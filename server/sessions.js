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

// Word list filenames in data/. Two SCOWL sizes serve two different
// roles; both must live in `data/` (see scowl-*.txt there).
//
// LEGAL_WORDS_FILE — the larger set, used to validate input. A word
//   the player submits must be in this set to be accepted.
// SCORING_WORDS_FILE — a smaller, higher-quality subset used to
//   generate random boards, populate the rank/score totals, and drive
//   the post-game reveal. Must be a subset of the legal list (and is
//   by construction, since SCOWL sizes nest).
//
// Swap these to experiment with different SCOWL sizes; the rest of the
// pipeline reads from them via loadData() below.
export const LEGAL_WORDS_FILE = "scowl-80.txt";
export const SCORING_WORDS_FILE = "scowl-50.txt";

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
// Pending configure-cancel timers (groupId → handle): if the
// configurator disconnects, after PRESENCE_GRACE_MS we clear
// `configuring` so the next player can claim setup.
const CONFIGURE_TIMERS = (globalThis.__freebeeConfigureTimers ??= new Map());

// Grace window before auto-ending a multi game whose players have all
// disconnected. Keep it long enough to cover a network blip but short
// enough that an abandoned game doesn't tie up a session for hours.
export const PRESENCE_GRACE_MS = 30_000;

// Sessions evict after 24h of inactivity. Groups outlive their longest-
// played session: chat history persists across boards, so a group that
// might be picked up next weekend deserves more rope than a one-off
// game does. Sweep runs lazily, at most once every SWEEP_INTERVAL_MS,
// on the lookup hot path.
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const GROUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweepAt = 0;

let dataPromise = null;
function loadData() {
  if (!dataPromise) {
    dataPromise = (async () => {
      const dir = path.join(process.cwd(), "data");
      const [legalText, scoringText] = await Promise.all([
        fs.readFile(path.join(dir, LEGAL_WORDS_FILE), "utf8"),
        fs.readFile(path.join(dir, SCORING_WORDS_FILE), "utf8"),
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
// groups whose lastActiveAt is past their TTL.
function maybeSweep() {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [id, s] of STORE) {
    if (now - s.lastActiveAt > SESSION_TTL_MS) STORE.delete(id);
  }
  for (const [id, g] of GROUPS) {
    if (now - g.lastActiveAt > GROUP_TTL_MS) {
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

// Resolve a URL id to a group, regardless of whether it has a session yet.
// Used by routes that need to operate on a no-session group (assembling /
// configuring) — getSession returns null in those states.
export function getGroupForId(id) {
  maybeSweep();
  const g = GROUPS.get(id);
  if (g) g.lastActiveAt = Date.now();
  return g ?? null;
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

// Create a group with no session. The host can invite friends, then
// someone enters configure mode to pick options for the first game.
export async function createEmptyGroup(playerName) {
  const cleanName = String(playerName || "").trim();
  if (!cleanName) return { error: "Name required" };
  const data = await loadData();
  const host = makePlayer(cleanName, PLAYER_COLORS[0]);
  const id = pickUrlId(data);
  const now = Date.now();
  const group = {
    id,
    hostId: host.playerId,
    players: [host],
    messages: [],
    currentSessionId: null,
    configuring: null,
    createdAt: now,
    lastActiveAt: now,
  };
  GROUPS.set(id, group);
  return group;
}

// --- Configuration state machine ---
//
// Between games (no session, or current session ended), one player at a
// time can take ownership of the "next game" setup form. Others see a
// "Joel is setting up the next game…" wait screen and can chat. The
// owner commits → a fresh session is created in the group.

function configureGuard(group, playerId) {
  if (!group.players.some((p) => p.playerId === playerId)) {
    return { error: "Not in this group" };
  }
  return null;
}

// True when the group is in a state where a new game can be configured:
// no session yet, or the current session has ended. An active or lobby
// session blocks configure (the configurator would stomp it).
function canConfigure(group) {
  if (!group.currentSessionId) return true;
  const s = STORE.get(group.currentSessionId);
  if (!s) return true;
  return s.ended;
}

export function startConfiguring(group, playerId) {
  const err = configureGuard(group, playerId);
  if (err) return err;
  if (!canConfigure(group)) return { error: "Game in progress" };
  if (group.configuring && group.configuring.ownerId !== playerId) {
    return { error: "Someone else is configuring" };
  }
  group.configuring = { ownerId: playerId };
  group.lastActiveAt = Date.now();
  broadcastGroup(group);
  return { ok: true };
}

export function cancelConfiguring(group, playerId) {
  const err = configureGuard(group, playerId);
  if (err) return err;
  if (!group.configuring) return { ok: true }; // idempotent
  if (group.configuring.ownerId !== playerId) {
    return { error: "Not the configurator" };
  }
  group.configuring = null;
  cancelConfigureGrace(group.id);
  group.lastActiveAt = Date.now();
  broadcastGroup(group);
  return { ok: true };
}

// Owner pushes their in-progress form state so other players see what
// they're picking in real time. Stored on group.configuring.draft;
// included in views so non-owners can render a read-only mirror.
// Commit reads its options from the request body, not the draft, so
// a debounced/delayed draft can't poison commit.
export function updateDraft(group, playerId, draft) {
  const err = configureGuard(group, playerId);
  if (err) return err;
  if (!group.configuring || group.configuring.ownerId !== playerId) {
    return { error: "Not the configurator" };
  }
  group.configuring.draft = draft && typeof draft === "object" ? draft : {};
  group.lastActiveAt = Date.now();
  broadcastGroup(group);
  return { ok: true };
}

// Commit configuration: create a session in the group with the given
// options. Owner-only. Releases configuring state.
export async function commitConfiguration(group, playerId, opts) {
  const err = configureGuard(group, playerId);
  if (err) return err;
  if (!group.configuring || group.configuring.ownerId !== playerId) {
    return { error: "Not the configurator" };
  }
  if (!canConfigure(group)) return { error: "Game in progress" };
  const data = await loadData();
  const { letters, center, ...rest } = opts || {};
  let board;
  if (letters !== undefined || center !== undefined) {
    const cerr = validateCustomLetters(letters, center);
    if (cerr) return { error: cerr };
    board = makeCustomGame(data, letters, center);
    if (board.wordlist.length === 0) {
      return { error: "No valid words for these letters" };
    }
  } else {
    board = makeGame(data);
  }
  // Sessions created via configure go straight to active (no session
  // lobby — the group already served as the assembly room).
  const sessionOpts = {
    timerMode: rest.timerMode === "down" || rest.timerMode === "none"
      ? rest.timerMode
      : "up",
    countdownSeconds: Number.isFinite(rest.countdownSeconds)
      ? Math.max(0, Math.floor(rest.countdownSeconds))
      : 0,
    mode: rest.mode === "compete" ? "compete" : "multi",
    ...(Number.isInteger(rest.targetRank) ? { targetRank: rest.targetRank } : {}),
  };
  const session = buildSession(board, sessionOpts, group.id);
  // Skip the session-lobby state — go straight to active.
  session.state = "active";
  session.paused = false;
  session.startedAt = sessionOpts.timerMode !== "none" ? Date.now() : null;
  STORE.set(session.id, session);
  group.currentSessionId = session.id;
  group.configuring = null;
  cancelConfigureGrace(group.id);
  group.lastActiveAt = Date.now();
  broadcastGroup(group);
  return session;
}

// --- Player join / lifecycle ---

// Add a player to a multiplayer group. Allowed when the group has no
// active game in progress: either no session yet, or the current
// session is in lobby/ended state. Once a game is "active", the
// roster is locked until it ends.
export function addPlayer(group, name) {
  if (!group) return { error: "Group not found" };
  if (group.currentSessionId) {
    const s = STORE.get(group.currentSessionId);
    if (s && s.state === "active") {
      return { error: "Game already started" };
    }
  }
  const cleanName = String(name || "").trim();
  if (!cleanName) return { error: "Name required" };
  const player = makePlayer(cleanName, nextColor(group.players));
  group.players.push(player);
  group.lastActiveAt = Date.now();
  broadcastGroup(group);
  return { player };
}

// Remove a player from the group. Reassigns the host if it was them
// (oldest remaining player by joinedAt). Cancels configuring if it was
// them. Deletes the group entirely when the last player leaves; that
// also drops any SUBS so leftover sockets reading on the same id don't
// keep the structure alive.
export function removePlayer(group, playerId) {
  if (!group) return { error: "Group not found" };
  const idx = group.players.findIndex((p) => p.playerId === playerId);
  if (idx < 0) return { error: "Not in this group" };
  group.players.splice(idx, 1);

  if (group.players.length === 0) {
    // Last player out: tear down the group and any session it owns.
    if (group.currentSessionId) STORE.delete(group.currentSessionId);
    GROUPS.delete(group.id);
    SUBS.delete(group.id);
    cancelGrace(group.id);
    cancelConfigureGrace(group.id);
    return { ok: true, deleted: true };
  }

  if (group.hostId === playerId) {
    // Reassign to the player who's been here longest.
    let next = group.players[0];
    for (const p of group.players) {
      if (p.joinedAt < next.joinedAt) next = p;
    }
    group.hostId = next.playerId;
  }
  if (group.configuring && group.configuring.ownerId === playerId) {
    group.configuring = null;
    cancelConfigureGrace(group.id);
  }
  group.lastActiveAt = Date.now();
  broadcastGroup(group);
  return { ok: true, deleted: false };
}

function cancelGrace(groupId) {
  const t = GRACE_TIMERS.get(groupId);
  if (t) {
    clearTimeout(t);
    GRACE_TIMERS.delete(groupId);
  }
}

function cancelConfigureGrace(groupId) {
  const t = CONFIGURE_TIMERS.get(groupId);
  if (t) {
    clearTimeout(t);
    CONFIGURE_TIMERS.delete(groupId);
  }
}

// Configurator went offline. After PRESENCE_GRACE_MS, clear
// `configuring` so other players can claim setup. Reconnect cancels
// the timer (so a network blip doesn't strip ownership).
function scheduleConfigureCancel(group) {
  const groupId = group.id;
  if (CONFIGURE_TIMERS.has(groupId)) return;
  const t = setTimeout(() => {
    CONFIGURE_TIMERS.delete(groupId);
    const g = GROUPS.get(groupId);
    if (!g || !g.configuring) return;
    const owner = g.players.find(
      (p) => p.playerId === g.configuring.ownerId,
    );
    // Owner came back during the grace and we missed cancelling — bail.
    if (owner && owner.connections > 0) return;
    g.configuring = null;
    g.lastActiveAt = Date.now();
    broadcastGroup(g);
  }, PRESENCE_GRACE_MS);
  CONFIGURE_TIMERS.set(groupId, t);
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
// text to MAX_CHAT_LEN. Operates on the group directly so empty groups
// (assembling/configuring) can chat too. Returns { error } if rejected;
// { ok: true } otherwise.
export function addChatMessage(group, playerId, rawText) {
  if (!group) return { error: "Group not found" };
  if (!group.players.some((p) => p.playerId === playerId)) {
    return { error: "Not in this group" };
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
  group.lastActiveAt = Date.now();
  broadcastGroup(group);
  return { ok: true };
}

// Mark that a player opened a WS connection. Idempotent in spirit: each
// connection is counted, so multiple tabs from the same player don't
// flicker presence on close. Operates on the group directly so empty
// groups (assembling/configuring with no session) can track presence.
export function presenceConnect(group, playerId) {
  if (!group) return;
  const p = group.players.find((x) => x.playerId === playerId);
  if (!p) return;
  p.connections = (p.connections || 0) + 1;
  if (p.connections === 1) {
    cancelGrace(group.id);
    if (group.configuring && group.configuring.ownerId === playerId) {
      cancelConfigureGrace(group.id);
    }
    group.lastActiveAt = Date.now();
    broadcastGroup(group);
  }
}

export function presenceDisconnect(group, playerId) {
  if (!group) return;
  const p = group.players.find((x) => x.playerId === playerId);
  if (!p || !p.connections) return;
  p.connections--;
  if (p.connections === 0) {
    const session = group.currentSessionId
      ? STORE.get(group.currentSessionId)
      : null;
    if (
      session &&
      session.state === "active" &&
      group.players.every((x) => !x.connections)
    ) {
      scheduleAutoEnd(session);
    }
    if (group.configuring && group.configuring.ownerId === playerId) {
      scheduleConfigureCancel(group);
    }
    group.lastActiveAt = Date.now();
    broadcastGroup(group);
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

// Group view: rendered when a group has no session yet (assembling) or
// is between games (configuring). Contains roster + chat + state, but
// no board fields. The client distinguishes by `state`:
// "assembling" / "configuring" mean "no game right now".
export function groupView(group, viewerId = null) {
  void viewerId;
  const view = {
    gameId: group.id,
    state: group.configuring ? "configuring" : "assembling",
    hostId: group.hostId,
    players: group.players.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      color: p.color,
      online: (p.connections || 0) > 0,
    })),
    messages: group.messages.slice(),
  };
  if (group.configuring) {
    view.configuring = {
      ownerId: group.configuring.ownerId,
      draft: group.configuring.draft ?? {},
    };
  }
  return view;
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
    if (group.configuring) {
      // After "New setup" on the end screen but before commit, the
      // group is back in configuring while the ended session is still
      // the current one. Surface so the client can show the wait /
      // form screens over the end-of-game view.
      view.configuring = {
        ownerId: group.configuring.ownerId,
        draft: group.configuring.draft ?? {},
      };
    }
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

// Group-driven broadcast: dispatches the right view based on whether the
// group has a session. Use for group-level changes (chat, presence,
// configure) that need to reach subscribers regardless of session state.
function broadcastGroup(group) {
  const subs = SUBS.get(group.id);
  if (!subs || subs.size === 0) return;
  const session = group.currentSessionId
    ? STORE.get(group.currentSessionId)
    : null;
  for (const { send, viewerId } of subs) {
    try {
      const view = session
        ? clientView(session, viewerId)
        : groupView(group, viewerId);
      send(view);
    } catch {
      // ignore
    }
  }
}

// Test-only: reset the in-memory store so tests don't leak state.
export function _resetStore() {
  for (const t of GRACE_TIMERS.values()) clearTimeout(t);
  GRACE_TIMERS.clear();
  for (const t of CONFIGURE_TIMERS.values()) clearTimeout(t);
  CONFIGURE_TIMERS.clear();
  STORE.clear();
  GROUPS.clear();
  SUBS.clear();
  lastSweepAt = 0;
  dataPromise = null;
  idPool = null;
}
