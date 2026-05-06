import { promises as fs } from "fs";
import path from "path";
import {
  processWords,
  makeGame,
  makeCustomGame,
  validateCustomLetters,
  scoreWord,
} from "./game.js";
import { currentRankIndex } from "../shared/ranks.js";

// ===========================================================================
// Phase 1 data model: a Group is the persistent entity that friends share;
// a Session is a single playthrough inside a group. Solo has no group.
//
// - Group holds identity + things that should outlive a single board:
//   players (identity, color, presence), chat backlog, currentSessionId.
// - Session holds the board, per-game word state, timer, and per-player
//   *game* state (compete scores) keyed by playerId.
// - URL id for multi = group.id. URL id for solo = session.id. The two
//   never collide (pickUrlId checks both maps before handing one out).
// - WS subscribers are keyed by URL id, so chat (group-level) and submits
//   (session-level) both fan out to the same listeners.
// ===========================================================================

// HMR-safe: surviving dev hot reloads keeps in-flight games intact.
const STORE = (globalThis.__freebeeSessions ??= new Map());
const GROUPS = (globalThis.__freebeeGroups ??= new Map());
// Per-URL-id subscriber registry. Key: group.id (multi) or session.id
// (solo); value: Set<{send, viewerId}>. The send fn is transport-
// agnostic — the WS layer registers a callback that pushes the latest
// clientView to its socket.
const SUBS = (globalThis.__freebeeSubs ??= new Map());
// Pending auto-end timers (groupId → timeout handle), so a reconnect
// during the grace window can cancel them.
const GRACE_TIMERS = (globalThis.__freebeeGraceTimers ??= new Map());

// Grace window before auto-ending a multi game whose players have all
// disconnected. Keep it long enough to cover a network blip but short
// enough that an abandoned game doesn't tie up a session for hours.
export const PRESENCE_GRACE_MS = 30_000;

// Sessions/groups are evicted after 24h of inactivity. Sweep runs lazily,
// at most once every SWEEP_INTERVAL_MS, on the lookup hot path.
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweepAt = 0;

let dataPromise = null;
function loadData() {
  if (!dataPromise) {
    dataPromise = (async () => {
      const dir = path.join(process.cwd(), "data");
      const [legalText, scoringText] = await Promise.all([
        fs.readFile(path.join(dir, "scowl-70.txt"), "utf8"),
        fs.readFile(path.join(dir, "scowl-50.txt"), "utf8"),
      ]);
      return processWords(legalText, scoringText);
    })();
  }
  return dataPromise;
}

export const SUBMIT = Object.freeze({
  ACCEPTED: "accepted",
  BAD_LETTERS: "badLetters",
  TOO_SHORT: "tooShort",
  MISSING_CENTER: "missingCenter",
  ALREADY_FOUND: "alreadyFound",
  NOT_A_WORD: "notAWord",
});

// 8-color palette for player roster + word-attribution. Light-bg friendly.
// Cycles after 8 players (no hard cap on roster size).
export const PLAYER_COLORS = Object.freeze([
  "#1976d2", // blue
  "#e64a19", // orange-red
  "#388e3c", // green
  "#7b1fa2", // purple
  "#f57c00", // orange
  "#00796b", // teal
  "#c2185b", // magenta
  "#5d4037", // brown
]);

function newId() {
  return globalThis.crypto.randomUUID();
}

// Shareable URL ids: two short words ("penguin-orange") that read off
// SMS without typos. The pool is the scoring word list (smaller, higher-
// quality SCOWL) filtered to 4–6 letters.
function buildIdPool(data) {
  const pool = [];
  for (let i = 0; i < data.words.length; i++) {
    if (!data.inScoring[i]) continue;
    const len = data.lengths[i];
    if (len >= 4 && len <= 6) pool.push(data.words[i]);
  }
  return pool;
}

let idPool = null;
function pickUrlId(data) {
  if (!idPool) idPool = buildIdPool(data);
  const pool = idPool;
  for (let i = 0; i < 50; i++) {
    const a = pool[Math.floor(Math.random() * pool.length)];
    const b = pool[Math.floor(Math.random() * pool.length)];
    const id = `${a}-${b}`;
    // Both namespaces share the URL id space — solo session ids and
    // multi group ids must not collide.
    if (!STORE.has(id) && !GROUPS.has(id)) return id;
  }
  // Defensive: if we somehow keep colliding, suffix with a UUID slice
  // so we never hand back a duplicate.
  const a = pool[Math.floor(Math.random() * pool.length)];
  const b = pool[Math.floor(Math.random() * pool.length)];
  return `${a}-${b}-${newId().slice(0, 4)}`;
}

function nextColor(players) {
  const used = new Set(players.map((p) => p.color));
  for (const c of PLAYER_COLORS) {
    if (!used.has(c)) return c;
  }
  return PLAYER_COLORS[players.length % PLAYER_COLORS.length];
}

function makePlayer(name, color) {
  const cleanName = String(name || "").trim().slice(0, 32);
  return {
    playerId: newId(),
    name: cleanName || "Player",
    color,
    // Active WS connections for this player. online === connections > 0.
    // Joined-but-not-yet-connected players read as offline until they
    // actually open a socket. Lives on the *group*: presence is a
    // property of the player's relationship to the group, not to any
    // individual game inside it.
    connections: 0,
    joinedAt: Date.now(),
  };
}

// Per-session per-player game state for compete mode. Co-op never reads
// these; solo has no players at all.
function emptyPlayerState() {
  return {
    found: [],
    foundSet: new Set(),
    bonusFound: [],
    score: 0,
  };
}

function getPlayerState(session, playerId) {
  let s = session.playerState[playerId];
  if (!s) {
    s = emptyPlayerState();
    session.playerState[playerId] = s;
  }
  return s;
}

function buildSession(board, opts, groupId) {
  const {
    timerMode = "up",
    countdownSeconds = 0,
    mode = "solo",
    targetRank,
  } = opts;
  const now = Date.now();
  const isMulti = mode === "multi" || mode === "compete";
  const isCompete = mode === "compete";

  // Multiplayer sessions start in "lobby" with paused=true. Solo starts
  // active and unpaused — even with timerMode "none" the player should
  // still be able to submit words.
  const startPaused = isMulti;
  const timerRunning = !startPaused && timerMode !== "none";

  return {
    id: newId(), // internal id; URL id for multi is the group's
    groupId, // null for solo
    mode,
    state: isMulti ? "lobby" : "active",
    foundBy: {}, // word → playerId (co-op attribution)
    letters: board.letters,
    center: board.center,
    words: board.words,
    total: board.total,
    wordlistSet: new Set(board.wordlist),
    scoringSet: new Set(board.revealList),
    revealList: board.revealList,
    found: [],
    foundSet: new Set(),
    bonusFound: [],
    score: 0,
    ended: false,
    timerMode,
    countdownSeconds,
    paused: startPaused,
    startedAt: timerRunning ? now : null,
    accumulatedMs: 0,
    targetRank: isCompete ? (targetRank ?? null) : null,
    // Compete: per-player game state, keyed by playerId. Empty for co-op.
    playerState: {},
    createdAt: now,
    lastActiveAt: now,
  };
}

function touch(session) {
  session.lastActiveAt = Date.now();
  if (session.groupId) {
    const g = GROUPS.get(session.groupId);
    if (g) g.lastActiveAt = session.lastActiveAt;
  }
}

// Lazy sweep: at most once every SWEEP_INTERVAL_MS, drop sessions and
// groups whose lastActiveAt is older than SESSION_TTL_MS.
function maybeSweep() {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [id, s] of STORE) {
    if (now - s.lastActiveAt > SESSION_TTL_MS) STORE.delete(id);
  }
  for (const [id, g] of GROUPS) {
    if (now - g.lastActiveAt > SESSION_TTL_MS) {
      GROUPS.delete(id);
      SUBS.delete(id);
    }
  }
}

function elapsedMs(session) {
  if (session.paused || session.ended || session.startedAt == null) {
    return session.accumulatedMs;
  }
  return session.accumulatedMs + (Date.now() - session.startedAt);
}

function snapshotElapsed(session) {
  if (!session.paused && !session.ended && session.startedAt != null) {
    session.accumulatedMs += Date.now() - session.startedAt;
    session.startedAt = null;
  }
}

// Auto-end on countdown expiry; caps elapsed at countdownSeconds exactly.
// Idempotent — does nothing once ended or for non-countdown games.
function maybeAutoEnd(session) {
  if (session.ended) return false;
  if (session.timerMode !== "down") return false;
  if (session.state !== "active") return false;
  const limitMs = session.countdownSeconds * 1000;
  if (elapsedMs(session) < limitMs) return false;
  session.accumulatedMs = limitMs;
  session.startedAt = null;
  session.paused = true;
  session.ended = true;
  session.state = "ended";
  broadcast(session);
  return true;
}

// The id used for URLs and WS subscriptions: group.id for multi,
// session.id for solo.
function urlIdOf(session) {
  return session.groupId ?? session.id;
}

// --- Lookup ---

// Resolve a URL id to its current session. For solo, the id IS the
// session id. For multi, the id is a group id and we hand back the
// group's currentSession.
export function getSession(id) {
  maybeSweep();
  // Solo path: the URL id is the session id directly.
  const direct = STORE.get(id);
  if (direct && direct.groupId == null) {
    maybeAutoEnd(direct);
    touch(direct);
    return direct;
  }
  // Multi path: URL id is a group id.
  const group = GROUPS.get(id);
  if (!group) return null;
  const s = STORE.get(group.currentSessionId);
  if (!s) return null;
  maybeAutoEnd(s);
  touch(s);
  return s;
}

export function getGroup(session) {
  return session.groupId ? GROUPS.get(session.groupId) ?? null : null;
}

// --- Multiplayer membership helpers ---

export function isMultiplayer(session) {
  return session.mode === "multi" || session.mode === "compete";
}

export function getMember(session, playerId) {
  if (!playerId || !isMultiplayer(session)) return null;
  const group = getGroup(session);
  if (!group) return null;
  return group.players.find((p) => p.playerId === playerId) || null;
}

export function isHost(session, playerId) {
  const group = getGroup(session);
  return !!(group && group.hostId === playerId);
}

// --- Creation ---

export async function createRandomSession(opts = {}) {
  const data = await loadData();
  return createSession(opts, () => makeGame(data), data);
}

export async function createCustomSession({ letters, center, ...opts }) {
  const error = validateCustomLetters(letters, center);
  if (error) return { error };
  const data = await loadData();
  const board = makeCustomGame(data, letters, center);
  if (board.wordlist.length === 0) {
    return { error: "No valid words for these letters" };
  }
  return createSession(opts, () => board, data);
}

// Internal: shared path for random + custom. Builds the session, and if
// it's multiplayer, builds the surrounding group (host = the creator).
function createSession(rawOpts, makeBoard, data) {
  const { playerName, ...rest } = rawOpts;
  const cleanName =
    typeof playerName === "string" && playerName.trim()
      ? playerName.trim()
      : null;
  const requestedMode = rest.mode;
  // Mode inference: explicit `mode` wins; otherwise playerName presence
  // implies "multi".
  const mode =
    requestedMode === "solo" ||
    requestedMode === "multi" ||
    requestedMode === "compete"
      ? requestedMode
      : cleanName
        ? "multi"
        : "solo";
  const isMulti = mode === "multi" || mode === "compete";

  if (isMulti) {
    if (!cleanName) return { error: "Player name required for multiplayer" };
    const host = makePlayer(cleanName, PLAYER_COLORS[0]);
    const id = pickUrlId(data);
    const now = Date.now();
    const group = {
      id,
      hostId: host.playerId,
      players: [host],
      messages: [], // persists across sessions in this group.
      currentSessionId: null, // set below
      createdAt: now,
      lastActiveAt: now,
    };
    GROUPS.set(id, group);
    const session = buildSession(makeBoard(), { ...rest, mode }, id);
    STORE.set(session.id, session);
    group.currentSessionId = session.id;
    return session;
  }

  // Solo: URL id = session id. pickUrlId checks both maps for collisions.
  const session = buildSession(makeBoard(), { ...rest, mode: "solo" }, null);
  const id = pickUrlId(data);
  session.id = id;
  STORE.set(id, session);
  return session;
}

// --- Player join / lifecycle ---

// Add a player to a multiplayer group. Lobby-state only. The session
// the group currently points at must be in lobby — once active, the
// roster is locked.
export function addPlayer(session, name) {
  if (!isMultiplayer(session)) return { error: "Not a multiplayer game" };
  if (session.state !== "lobby") return { error: "Game already started" };
  const group = getGroup(session);
  if (!group) return { error: "Group missing" };
  const cleanName = String(name || "").trim();
  if (!cleanName) return { error: "Name required" };
  const player = makePlayer(cleanName, nextColor(group.players));
  group.players.push(player);
  touch(session);
  broadcast(session);
  return { player };
}

function cancelGrace(groupId) {
  const t = GRACE_TIMERS.get(groupId);
  if (t) {
    clearTimeout(t);
    GRACE_TIMERS.delete(groupId);
  }
}

function scheduleAutoEnd(session) {
  const groupId = session.groupId;
  if (!groupId) return;
  if (GRACE_TIMERS.has(groupId)) return;
  const t = setTimeout(() => {
    GRACE_TIMERS.delete(groupId);
    const group = GROUPS.get(groupId);
    if (!group) return;
    const s = STORE.get(group.currentSessionId);
    if (!s) return;
    if (s.state !== "active") return;
    if (!group.players.every((p) => !p.connections)) return; // someone came back
    endSession(s);
  }, PRESENCE_GRACE_MS);
  GRACE_TIMERS.set(groupId, t);
}

const MAX_CHAT_LEN = 500;
const MAX_MESSAGES = 100;

// Append a chat message to the group and broadcast. Truncates over-length
// text to MAX_CHAT_LEN. Returns { error } if rejected; { ok: true } otherwise.
export function addChatMessage(session, playerId, rawText) {
  if (!isMultiplayer(session)) return { error: "Not a multiplayer game" };
  const group = getGroup(session);
  if (!group) return { error: "Group missing" };
  if (!group.players.some((p) => p.playerId === playerId)) {
    return { error: "Not in this game" };
  }
  const trimmed = String(rawText || "").trim();
  if (!trimmed) return { error: "Empty message" };
  const important = trimmed.startsWith("!");
  const text = important ? trimmed.slice(1).trim() : trimmed;
  if (!text) return { error: "Empty message" };
  const msg = {
    playerId,
    text: text.slice(0, MAX_CHAT_LEN),
    ts: Date.now(),
  };
  if (important) msg.important = true;
  group.messages.push(msg);
  if (group.messages.length > MAX_MESSAGES) {
    group.messages = group.messages.slice(-MAX_MESSAGES);
  }
  touch(session);
  broadcast(session);
  return { ok: true };
}

// Mark that a player opened a WS connection. Idempotent in spirit: each
// connection is counted, so multiple tabs from the same player don't
// flicker presence on close.
export function presenceConnect(session, playerId) {
  if (!isMultiplayer(session)) return;
  const group = getGroup(session);
  if (!group) return;
  const p = group.players.find((x) => x.playerId === playerId);
  if (!p) return;
  p.connections = (p.connections || 0) + 1;
  if (p.connections === 1) {
    cancelGrace(group.id);
    touch(session);
    broadcast(session);
  }
}

export function presenceDisconnect(session, playerId) {
  if (!isMultiplayer(session)) return;
  const group = getGroup(session);
  if (!group) return;
  const p = group.players.find((x) => x.playerId === playerId);
  if (!p || !p.connections) return;
  p.connections--;
  if (p.connections === 0) {
    if (
      session.state === "active" &&
      group.players.every((x) => !x.connections)
    ) {
      scheduleAutoEnd(session);
    }
    touch(session);
    broadcast(session);
  }
}

// Cut a fresh session in the same group: same roster + chat + timer
// config, new random board. Idempotent in two senses:
//   1. If the caller is holding a stale session reference (the group
//      moved on), return the current session.
//   2. If the current session is already a fresh successor (active,
//      no words found yet), return it instead of cutting yet another.
//      Two rapid "new board" clicks shouldn't cascade.
export async function newBoardFromSession(oldSession) {
  if (!isMultiplayer(oldSession)) {
    return { error: "Not a multiplayer game" };
  }
  const group = getGroup(oldSession);
  if (!group) return { error: "Group missing" };
  if (group.currentSessionId !== oldSession.id) {
    const current = STORE.get(group.currentSessionId);
    if (current) return current;
  }
  if (oldSession.state === "active" && oldSession.found.length === 0) {
    return oldSession;
  }
  const data = await loadData();
  const board = makeGame(data);
  const now = Date.now();
  const session = {
    id: newId(),
    groupId: group.id,
    mode: oldSession.mode,
    state: "active",
    foundBy: {},
    letters: board.letters,
    center: board.center,
    words: board.words,
    total: board.total,
    wordlistSet: new Set(board.wordlist),
    scoringSet: new Set(board.revealList),
    revealList: board.revealList,
    found: [],
    foundSet: new Set(),
    bonusFound: [],
    score: 0,
    ended: false,
    timerMode: oldSession.timerMode,
    countdownSeconds: oldSession.countdownSeconds,
    paused: false,
    startedAt: oldSession.timerMode === "none" ? null : now,
    accumulatedMs: 0,
    targetRank: oldSession.targetRank ?? null,
    playerState: {},
    createdAt: now,
    lastActiveAt: now,
  };
  STORE.set(session.id, session);
  group.currentSessionId = session.id;
  group.lastActiveAt = now;
  // Broadcast on the same URL id (group.id) — subscribers don't need to
  // navigate, the view just refreshes with the new board.
  broadcast(session);
  return session;
}

export function startSession(session) {
  if (!isMultiplayer(session)) return session;
  if (session.state !== "lobby") return session;
  session.state = "active";
  session.paused = false;
  session.startedAt = session.timerMode !== "none" ? Date.now() : null;
  touch(session);
  broadcast(session);
  return session;
}

export function pauseSession(session) {
  if (session.ended || session.paused) return session;
  snapshotElapsed(session);
  session.paused = true;
  touch(session);
  broadcast(session);
  return session;
}

export function resumeSession(session) {
  if (session.ended) return session;
  if (!session.paused) return session;
  if (session.timerMode === "none") return session;
  if (isMultiplayer(session) && session.state !== "active") return session;
  session.paused = false;
  session.startedAt = Date.now();
  touch(session);
  broadcast(session);
  return session;
}

export function endSession(session) {
  if (session.ended) return session;
  snapshotElapsed(session);
  session.paused = true;
  session.ended = true;
  session.state = "ended";
  if (session.mode === "compete") {
    const group = getGroup(session);
    if (group) {
      let bestId = null;
      let bestScore = -Infinity;
      for (const p of group.players) {
        const ps = session.playerState[p.playerId];
        const score = ps ? ps.score : 0;
        if (score > bestScore) {
          bestScore = score;
          bestId = p.playerId;
        }
      }
      if (bestId) session.winnerId = bestId;
    }
  }
  touch(session);
  broadcast(session);
  return session;
}

// Client-safe projection: never includes wordlistSet/scoringSet; revealList
// only after end. Multi sessions add roster/host/foundBy/messages from
// the surrounding group.
export function clientView(session, viewerId = null) {
  void viewerId;
  const view = {
    // Stable URL id: groupId for multi, session id for solo. The client
    // uses this for routing + localStorage; renaming would churn far
    // more code than it would clarify.
    gameId: urlIdOf(session),
    // Per-session id that changes on new-board (where gameId is stable
    // because the group's URL doesn't move). The client uses this as a
    // React `key` so the Game component remounts and resets local state
    // (typed input, feedback) when the board flips.
    sessionId: session.id,
    mode: session.mode,
    state: session.state,
    letters: session.letters,
    center: session.center,
    words: session.words,
    total: session.total,
    timerMode: session.timerMode,
    countdownSeconds: session.countdownSeconds,
    found: session.found,
    bonusFound: session.bonusFound,
    score: session.score,
    ended: session.ended,
    paused: session.paused,
    elapsed: Math.floor(elapsedMs(session) / 1000),
  };
  if (isMultiplayer(session)) {
    const group = getGroup(session);
    if (!group) return view; // shouldn't happen, but stay defensive
    view.hostId = group.hostId;
    view.players = group.players.map((p) => {
      const base = {
        playerId: p.playerId,
        name: p.name,
        color: p.color,
        online: (p.connections || 0) > 0,
      };
      if (session.mode === "compete") {
        const ps = session.playerState[p.playerId];
        base.score = ps ? ps.score : 0;
        base.foundCount = ps ? ps.found.length : 0;
      }
      return base;
    });
    view.foundBy = { ...session.foundBy };
    view.messages = group.messages.slice();
    if (session.targetRank != null) view.targetRank = session.targetRank;
  }

  if (session.mode === "compete") {
    const ps = session.playerState[viewerId];
    if (ps) {
      view.found = ps.found.slice();
      view.bonusFound = ps.bonusFound.slice();
      view.score = ps.score;
    } else {
      view.found = [];
      view.bonusFound = [];
      view.score = 0;
    }
    if (session.winnerId) view.winnerId = session.winnerId;

    // Post-end: precompute "missedByMe" — words the viewer didn't find
    // that someone else did.
    if (session.ended && ps) {
      const group = getGroup(session);
      const missed = {};
      if (group) {
        for (const p of group.players) {
          if (p.playerId === viewerId) continue;
          const other = session.playerState[p.playerId];
          if (!other) continue;
          for (const w of other.found) {
            if (ps.foundSet.has(w)) continue;
            if (!(w in missed)) missed[w] = p.playerId;
          }
        }
      }
      view.missedByMe = missed;
    }
  }
  if (session.ended) view.revealList = session.revealList;
  return view;
}

// Mirrors the original tryWord ordering: bad letters → too short →
// missing center → already found → membership check.
export function submitWord(session, rawInput, playerId = null) {
  const word = String(rawInput || "").toLowerCase().trim();
  const allowed = new Set(session.letters + session.center);
  if (![...word].every((c) => allowed.has(c))) {
    return { result: SUBMIT.BAD_LETTERS };
  }
  if (word.length < 4) return { result: SUBMIT.TOO_SHORT };
  if (!word.includes(session.center)) {
    return { result: SUBMIT.MISSING_CENTER };
  }

  const isCompete = session.mode === "compete";
  const ps = isCompete ? getPlayerState(session, playerId) : null;
  const foundSet = isCompete ? ps.foundSet : session.foundSet;

  if (foundSet.has(word)) {
    return { result: SUBMIT.ALREADY_FOUND };
  }
  if (!session.wordlistSet.has(word)) {
    return { result: SUBMIT.NOT_A_WORD };
  }
  const points = scoreWord(word);
  const isPangram = new Set(word).size === 7;
  const isBonus = !session.scoringSet.has(word);

  if (isCompete) {
    ps.found.push(word);
    ps.foundSet.add(word);
    if (isBonus) ps.bonusFound.push(word);
    ps.score += points;
    if (
      session.targetRank != null &&
      currentRankIndex(ps.score, session.total) >= session.targetRank
    ) {
      endSession(session);
    }
  } else {
    session.found.push(word);
    session.foundSet.add(word);
    if (isBonus) session.bonusFound.push(word);
    session.score += points;
    if (session.mode === "multi" && playerId) {
      session.foundBy[word] = playerId;
    }
  }
  touch(session);
  broadcast(session);
  return {
    result: SUBMIT.ACCEPTED,
    word,
    points,
    isPangram,
    bonus: isBonus,
    totalScore: isCompete ? ps.score : session.score,
    found: isCompete ? ps.found.slice() : session.found.slice(),
    bonusFound: isCompete ? ps.bonusFound.slice() : session.bonusFound.slice(),
  };
}

// Subscribe to state updates for a URL id (group for multi, session for
// solo). Returns an unsubscribe function. Multiple events fan out to
// the same listeners: chat (group-level), submits (session-level),
// new-board (cuts a successor session in the same group).
export function subscribeToSession(id, send, viewerId = null) {
  let subs = SUBS.get(id);
  if (!subs) {
    subs = new Set();
    SUBS.set(id, subs);
  }
  const entry = { send, viewerId };
  subs.add(entry);
  return () => {
    const set = SUBS.get(id);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) SUBS.delete(id);
  };
}

function broadcast(session) {
  const subs = SUBS.get(urlIdOf(session));
  if (!subs || subs.size === 0) return;
  for (const { send, viewerId } of subs) {
    try {
      send(clientView(session, viewerId));
    } catch {
      // Subscriber threw (e.g., closed stream); ignore.
    }
  }
}

// Test-only: reset the in-memory store so tests don't leak state.
export function _resetStore() {
  for (const t of GRACE_TIMERS.values()) clearTimeout(t);
  GRACE_TIMERS.clear();
  STORE.clear();
  GROUPS.clear();
  SUBS.clear();
  lastSweepAt = 0;
  dataPromise = null;
  idPool = null;
}
