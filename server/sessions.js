import { promises as fs } from "fs";
import path from "path";
import {
  processWords,
  makeGame,
  makeCustomGame,
  validateCustomLetters,
  scoreWord,
} from "./game.js";

// HMR-safe: surviving dev hot reloads keeps in-flight games intact.
const STORE = (globalThis.__freebeeSessions ??= new Map());
// Per-session subscriber registry. Key: session id; value: Set<send fn>.
// The send fn is transport-agnostic — the WS layer registers a callback
// that pushes the latest clientView to its socket.
const SUBS = (globalThis.__freebeeSubs ??= new Map());
// Pending auto-end timers (sessionId → timeout handle), so a reconnect
// during the grace window can cancel them.
const GRACE_TIMERS = (globalThis.__freebeeGraceTimers ??= new Map());

// Grace window before auto-ending a multi game whose players have all
// disconnected. Keep it long enough to cover a network blip but short
// enough that an abandoned game doesn't tie up a session for hours.
export const PRESENCE_GRACE_MS = 30_000;

// Sessions are evicted after 24h of inactivity. Sweep runs lazily, at most
// once every SWEEP_INTERVAL_MS, on getSession (the most-trafficked path).
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweepAt = 0;

let dataPromise = null;
function loadData() {
  if (!dataPromise) {
    dataPromise = (async () => {
      const dir = path.join(process.cwd(), "data");
      const [legalText, scoringText] = await Promise.all([
        fs.readFile(path.join(dir, "legal-words.txt"), "utf8"),
        fs.readFile(path.join(dir, "scoring-words.txt"), "utf8"),
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

// Game IDs appear in shareable URLs (/g/<id>, /p/<id>), so we want
// something a friend can read off an SMS without typos. Two short words
// joined by a hyphen ("penguin-orange") gives ~hundreds of thousands of
// combinations against a typical handful of concurrent active games —
// collisions are vanishingly rare, but we retry just in case. The pool
// is the scoring word list (smaller, higher-quality SCOWL) filtered to
// 4–6 letters for typeability.
function buildGameIdPool(data) {
  const pool = [];
  for (let i = 0; i < data.words.length; i++) {
    if (!data.inScoring[i]) continue;
    const len = data.lengths[i];
    if (len >= 4 && len <= 6) pool.push(data.words[i]);
  }
  return pool;
}

let gameIdPool = null;
function pickGameId(data) {
  if (!gameIdPool) gameIdPool = buildGameIdPool(data);
  const pool = gameIdPool;
  for (let i = 0; i < 50; i++) {
    const a = pool[Math.floor(Math.random() * pool.length)];
    const b = pool[Math.floor(Math.random() * pool.length)];
    const id = `${a}-${b}`;
    if (!STORE.has(id)) return id;
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
    // Joined-but-not-yet-connected players (e.g., between /join and the
    // browser opening the socket) read as offline until they connect.
    connections: 0,
    joinedAt: Date.now(),
  };
}

function buildSession(board, opts = {}, id) {
  const {
    timerMode = "up",
    countdownSeconds = 0,
    playerName, // presence implies a multiplayer session (co-op or compete)
    // Three valid modes: "solo", "multi" (co-op), "compete". A
    // playerName must accompany "multi" / "compete". If `mode` is
    // missing, infer from playerName: present → "multi", absent → "solo".
    // Compete-only options:
    //   targetRank: index into RANKS (e.g. 6 for Genius). When set, the
    //     game ends as soon as any player reaches that rank.
    mode: requestedMode,
    targetRank,
  } = opts;
  const now = Date.now();
  const isMulti = playerName != null;
  const mode = requestedMode || (isMulti ? "multi" : "solo");
  const isCompete = mode === "compete";

  const players = [];
  let hostId = null;
  if (isMulti) {
    const host = makePlayer(playerName, PLAYER_COLORS[0]);
    players.push(host);
    hostId = host.playerId;
  }

  // Multiplayer sessions (co-op + compete) start in "lobby" with
  // paused=true (the lobby is semantically "the game hasn't started").
  // Solo never starts paused — including when timerMode is "none". A
  // "none" game has no clock to tick, but the player should still be
  // able to submit words.
  const startPaused = isMulti;
  const timerRunning = !startPaused && timerMode !== "none";

  return {
    id,
    mode,
    state: isMulti ? "lobby" : "active",
    hostId,
    players,
    // word → playerId attribution. Solo never writes here.
    foundBy: {},
    // Chat backlog (multi only). {playerId, text, ts}; capped at 100.
    messages: [],
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
    // Timer state. `startedAt` is the wall-clock anchor for the *current*
    // running interval (null when paused/ended). `accumulatedMs` holds the
    // total of all completed running intervals. Elapsed = accumulatedMs +
    // (now - startedAt) when running, else accumulatedMs.
    paused: startPaused,
    startedAt: timerRunning ? now : null,
    accumulatedMs: 0,
    // Compete-only: index into RANKS at which the game ends. null for
    // solo / co-op (those rely on countdown or manual end).
    targetRank: isCompete ? (targetRank ?? null) : null,
    createdAt: now,
    lastActiveAt: now,
  };
}

function touch(session) {
  session.lastActiveAt = Date.now();
}

// Lazy sweep: at most once every SWEEP_INTERVAL_MS, drop sessions whose
// lastActiveAt is older than SESSION_TTL_MS. Cheap when nothing's expired.
function maybeSweep() {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [id, s] of STORE) {
    if (now - s.lastActiveAt > SESSION_TTL_MS) {
      STORE.delete(id);
      SUBS.delete(id);
    }
  }
}

// Returns elapsed milliseconds based on the session's timer state.
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
  // Countdown only ticks once started, so don't auto-end a multi lobby.
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

export async function createRandomSession(opts = {}) {
  const data = await loadData();
  const session = buildSession(makeGame(data), opts, pickGameId(data));
  STORE.set(session.id, session);
  return session;
}

export async function createCustomSession({ letters, center, ...opts }) {
  const error = validateCustomLetters(letters, center);
  if (error) return { error };
  const data = await loadData();
  const board = makeCustomGame(data, letters, center);
  if (board.wordlist.length === 0) {
    return { error: "No valid words for these letters" };
  }
  const session = buildSession(board, opts, pickGameId(data));
  STORE.set(session.id, session);
  return session;
}

// Always run maybeAutoEnd before reading state, so a session whose
// countdown expired without anyone hitting an endpoint reports as ended.
// Touching keeps the session alive against TTL eviction.
export function getSession(id) {
  maybeSweep();
  const s = STORE.get(id);
  if (!s) return null;
  maybeAutoEnd(s);
  touch(s);
  return s;
}

// --- Multiplayer membership helpers ---

// True for any session with a player roster (co-op + compete). Use this
// instead of `mode === "multi"` for guards that care about "is there a
// roster / lobby / host?".
export function isMultiplayer(session) {
  return session.mode === "multi" || session.mode === "compete";
}

// Returns the player record for a given playerId, or null. Solo sessions
// always return null since they have no roster.
export function getMember(session, playerId) {
  if (!playerId || !isMultiplayer(session)) return null;
  return session.players.find((p) => p.playerId === playerId) || null;
}

export function isHost(session, playerId) {
  return isMultiplayer(session) && session.hostId === playerId;
}

// Add a player to a multiplayer session that is still in lobby state.
// Returns { player } on success or { error } on failure.
export function addPlayer(session, name) {
  if (!isMultiplayer(session)) return { error: "Not a multiplayer game" };
  if (session.state !== "lobby") return { error: "Game already started" };
  const cleanName = String(name || "").trim();
  if (!cleanName) return { error: "Name required" };
  const player = makePlayer(cleanName, nextColor(session.players));
  session.players.push(player);
  touch(session);
  broadcast(session);
  return { player };
}

function cancelGrace(sessionId) {
  const t = GRACE_TIMERS.get(sessionId);
  if (t) {
    clearTimeout(t);
    GRACE_TIMERS.delete(sessionId);
  }
}

function scheduleAutoEnd(session) {
  if (GRACE_TIMERS.has(session.id)) return;
  const id = session.id;
  const t = setTimeout(() => {
    GRACE_TIMERS.delete(id);
    const s = STORE.get(id);
    if (!s) return;
    if (s.state !== "active") return;
    if (!s.players.every((p) => !p.connections)) return; // someone came back
    endSession(s);
  }, PRESENCE_GRACE_MS);
  GRACE_TIMERS.set(id, t);
}

const MAX_CHAT_LEN = 500;
const MAX_MESSAGES = 100;

// Append a chat message and broadcast. Truncates over-length text to
// MAX_CHAT_LEN. Returns { error } if rejected; { ok: true } otherwise.
export function addChatMessage(session, playerId, rawText) {
  if (!isMultiplayer(session)) return { error: "Not a multiplayer game" };
  if (!session.players.some((p) => p.playerId === playerId)) {
    return { error: "Not in this game" };
  }
  const trimmed = String(rawText || "").trim();
  if (!trimmed) return { error: "Empty message" };
  // Leading "!" marks an important message: bolded in the chat list,
  // and the client auto-opens its chat popover on arrival. Strip the
  // sigil so it doesn't appear in the rendered text. A bare "!" with
  // no body is rejected like an empty message.
  const important = trimmed.startsWith("!");
  const text = important ? trimmed.slice(1).trim() : trimmed;
  if (!text) return { error: "Empty message" };
  const msg = {
    playerId,
    text: text.slice(0, MAX_CHAT_LEN),
    ts: Date.now(),
  };
  if (important) msg.important = true;
  session.messages.push(msg);
  // Bound the backlog so long sessions don't grow unbounded.
  if (session.messages.length > MAX_MESSAGES) {
    session.messages = session.messages.slice(-MAX_MESSAGES);
  }
  touch(session);
  broadcast(session);
  return { ok: true };
}

// Mark that a player opened a WS connection. Idempotent in spirit: each
// connection is counted, so multiple tabs from the same player don't
// flicker presence on close.
export function presenceConnect(session, playerId) {
  if (session.mode !== "multi") return;
  const p = session.players.find((x) => x.playerId === playerId);
  if (!p) return;
  p.connections = (p.connections || 0) + 1;
  if (p.connections === 1) {
    // Transition to online — cancel any pending auto-end.
    cancelGrace(session.id);
    touch(session);
    broadcast(session);
  }
}

export function presenceDisconnect(session, playerId) {
  if (session.mode !== "multi") return;
  const p = session.players.find((x) => x.playerId === playerId);
  if (!p || !p.connections) return;
  p.connections--;
  if (p.connections === 0) {
    // Transition to offline. If everyone's gone and the game is active,
    // arm the grace timer.
    if (
      session.state === "active" &&
      session.players.every((x) => !x.connections)
    ) {
      scheduleAutoEnd(session);
    }
    touch(session);
    broadcast(session);
  }
}

// Create a fresh multiplayer session that carries over the previous
// game's roster (same playerIds, names, colors) and timer config but
// with a new random board, no found words, state="active". Idempotent
// via the old session's nextGameId pointer — a second caller gets the
// existing successor instead of creating another orphan.
export async function newBoardFromSession(oldSession) {
  if (!isMultiplayer(oldSession)) {
    return { error: "Not a multiplayer game" };
  }
  if (oldSession.nextGameId) {
    const existing = STORE.get(oldSession.nextGameId);
    if (existing) return existing;
    // Stale pointer (TTL'd or evicted) — fall through and create anew.
  }
  const data = await loadData();
  const board = makeGame(data);
  const now = Date.now();
  const session = {
    id: pickGameId(data),
    mode: oldSession.mode,
    state: "active",
    hostId: oldSession.hostId,
    players: oldSession.players.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      color: p.color,
      connections: 0,
      joinedAt: now,
    })),
    foundBy: {},
    // Carry chat backlog forward — same group, same conversation. Player
    // ids in the roster are preserved (see players map above), so name +
    // color attribution still resolves on the client.
    messages: oldSession.messages.slice(),
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
    // New-board always starts running. startedAt is null for "none"
    // (there's no clock to anchor), but paused stays false — there's
    // no resume affordance for a "none" game, so a paused successor
    // would be unrecoverable.
    paused: false,
    startedAt: oldSession.timerMode === "none" ? null : now,
    accumulatedMs: 0,
    targetRank: oldSession.targetRank ?? null,
    createdAt: now,
    lastActiveAt: now,
  };
  STORE.set(session.id, session);
  oldSession.nextGameId = session.id;
  // Surface the successor on the old session so other tabs can navigate.
  broadcast(oldSession);
  return session;
}

// Transition a multiplayer session from lobby to active. No-op for
// solo or non-lobby sessions (caller is responsible for permission
// checks).
export function startSession(session) {
  if (!isMultiplayer(session)) return session;
  if (session.state !== "lobby") return session;
  session.state = "active";
  // Always unpause on start. For "none" the clock simply doesn't tick;
  // for "up"/"down" we anchor startedAt now.
  session.paused = false;
  session.startedAt = session.timerMode !== "none" ? Date.now() : null;
  touch(session);
  broadcast(session);
  return session;
}

// --- Timer/lifecycle (used by both solo and multi) ---

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
  // Multiplayer: only resume when active (lobby is "paused" by definition).
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
  touch(session);
  broadcast(session);
  return session;
}

// Client-safe projection: never includes wordlistSet/scoringSet; revealList
// only after end. Multi sessions add players/hostId/foundBy.
//
// `viewerId` (the requesting player) is plumbed through so compete mode
// can return per-player word lists. For solo and co-op, the value is
// ignored — every viewer sees the same shared state.
export function clientView(session, viewerId = null) {
  // viewerId is unused in solo/co-op — referenced here so eslint doesn't
  // complain about an unused parameter and so the call sites communicate
  // intent. Compete mode (added in a later phase) will use it.
  void viewerId;
  const view = {
    gameId: session.id,
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
    view.hostId = session.hostId;
    view.players = session.players.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      color: p.color,
      online: (p.connections || 0) > 0,
    }));
    view.foundBy = { ...session.foundBy };
    view.messages = session.messages.slice();
    if (session.nextGameId) view.nextGameId = session.nextGameId;
    if (session.targetRank != null) view.targetRank = session.targetRank;
  }
  if (session.ended) view.revealList = session.revealList;
  return view;
}

// Mirrors the original client tryWord ordering: bad letters → too short →
// missing center → already found → membership check. `playerId` is recorded
// for multi attribution; solo passes null.
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
  if (session.foundSet.has(word)) {
    return { result: SUBMIT.ALREADY_FOUND };
  }
  if (!session.wordlistSet.has(word)) {
    return { result: SUBMIT.NOT_A_WORD };
  }
  const points = scoreWord(word);
  const isPangram = new Set(word).size === 7;
  const isBonus = !session.scoringSet.has(word);
  session.found.push(word);
  session.foundSet.add(word);
  if (isBonus) session.bonusFound.push(word);
  session.score += points;
  if (session.mode === "multi" && playerId) {
    session.foundBy[word] = playerId;
  }
  touch(session);
  broadcast(session);
  return {
    result: SUBMIT.ACCEPTED,
    word,
    points,
    isPangram,
    bonus: isBonus,
    totalScore: session.score,
    found: session.found.slice(),
    bonusFound: session.bonusFound.slice(),
  };
}

// Subscribe to state updates for a session. `send` receives a clientView
// rendered for `viewerId` whenever the session state changes (submit
// accepted, pause/resume/end, auto-end). Per-viewer rendering matters
// for compete mode where each player sees their own word list.
// Returns an unsubscribe function.
//
// The internal storage holds {send, viewerId} entries; broadcast walks
// them, computing a fresh view per recipient.
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
  const subs = SUBS.get(session.id);
  if (!subs || subs.size === 0) return;
  for (const { send, viewerId } of subs) {
    try {
      send(clientView(session, viewerId));
    } catch {
      // Subscriber threw (e.g., closed stream); ignore. The route handler
      // is responsible for cleaning up its own subscription on close.
    }
  }
}

// Test-only: reset the in-memory store so tests don't leak state.
export function _resetStore() {
  for (const t of GRACE_TIMERS.values()) clearTimeout(t);
  GRACE_TIMERS.clear();
  STORE.clear();
  SUBS.clear();
  lastSweepAt = 0;
  dataPromise = null;
  gameIdPool = null;
}
