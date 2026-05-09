# Architecture

A high-level orientation for someone reading the codebase for the first time.

## What freebee is

A spelling-bee word game: the player gets seven letters (one outer ring of six plus a center), and finds words that use only those letters and include the center. Pangrams (use all seven distinct letters) are worth a bonus. There are three modes:

- **Solo** — a single player against the clock (or no clock).
- **Co-op (multi)** — a group plays one shared puzzle; words found by anyone count for the team.
- **Compete** — same letters, but each player keeps their own found list and score, and the game ends when someone hits a target rank (or a countdown expires).

Solo and group games live at different URL spaces (`/p/:id` for solo, `/g/:id` for the lobby, `/g/:id/play` for the active group game). The same `<Game>` component renders both — what differs is the parent page that wires it up.

## Process layout

There are two halves in development, one process in production:

- **Server**: Hono on port 3001 (`server/server.js`). Registers REST routes (`server/routes.js`) and a WebSocket endpoint (`server/ws.js`). Holds all live game state in process memory.
- **Client**: React 18 + react-router-dom + Vite, served on :5173 in dev. Vite's dev proxy forwards `/api/*` and `/ws/*` to the Hono server on :3001.

In production (`npm start`), Hono also serves the Vite-built static assets out of `dist/`, so client and server share an origin and the proxy isn't needed.

There is no database. State lives in three module-level Maps on `globalThis` (so `node --watch` HMR doesn't blow them away mid-game): `STORE` (sessions), `GROUPS` (groups), `SUBS` (WebSocket subscribers). Sessions evict 24h after their last activity; groups evict 7d after theirs.

## Front end vs back end

The server is the single source of truth. The client is a renderer plus an input collector.

**Server is responsible for:**
- Choosing the puzzle's letters and the answer set (the wordlist + which words count for score).
- Validating each word submission against the legal/scoring lists.
- Tracking score, found-by-whom, ranks, the timer's elapsed/paused state, group rosters, chat history.
- Pushing state changes to all subscribers via WebSocket. Each push contains a full `clientView`, not a delta — easier to keep in sync; cheap because views are small.

**Client is responsible for:**
- Rendering the current `clientView` it has from the server. Most local state mirrors fields from the view 1:1 and updates on each push.
- Capturing keyboard / button input and POSTing it (submit, pause, resume, end, etc.). The server's response (also a `clientView`) is the new state.
- A small amount of local-only state that the server doesn't care about: the "Recently found" 5-second underline, the displayed (per-frame) timer value (the server gives you `elapsed` in seconds; the client interpolates between pushes via `useTimer`), the chat preview popover, the WebSocket connection status pill.
- Persisting *just enough* in `localStorage` to resume after a refresh: solo stores `{gameId}`, multi stores `{gameId, playerId}`, plus the player's name and (now) their preferred BoardBuilder strategy.

The view never contains the unfound words; see [Wire protocol](#wire-protocol--websocket) for the redaction details.

## Data model

Two entities: **Group** and **Session**.

- A **Group** is the persistent thing friends share via a URL. It holds the roster (players + their colors + presence-connection counts), chat backlog, host id, and a pointer to the current session (`currentSessionId`). Groups outlive individual games — chat carries across, the roster carries across.
- A **Session** is a single playthrough: the board (letters, center, total-words, scoring word set), the per-game state (found list, score, foundBy attribution, per-player compete state), and the timer state. Sessions are cut by `commitConfiguration` (first game in a group) or `newBoardFromSession` (subsequent games).

The URL id space is shared. For solo, the URL id is the session id directly (no group). For multi/compete, the URL id is the group id and the session is reached via `group.currentSessionId`. `getSession(id)` does this dispatch — callers (routes, WS) treat it the same in both cases.

`pickUrlId` checks both maps before returning a new id, so collisions can't happen.

## Lifecycle

### Solo
1. `POST /api/games` (optional `letters`/`center` for custom puzzles, plus `timerMode` / `countdownSeconds` / `builder` / `previousLetters`) creates a fresh session in `state: "active"` immediately.
2. The client navigates to `/p/:gameId`, opens a WebSocket, plays the game.
3. "New board" POSTs `/api/games` again, carrying the previous game's timer config + builder choice + letters (so the BoardBuilder can avoid too much overlap with the just-played board).

### Multi / Compete (Phase 2 group flow)
1. `POST /api/groups` creates an empty group with the host on the roster. State `assembling`, no session yet.
2. Friends `POST /api/games/:id/join` (URL id = group id).
3. Someone clicks "Start setup" → `POST /api/games/:id/configure`. State flips to `configuring`; the clicker owns the form. First-to-click wins; duplicate claims by other players 409.
4. The owner edits the form. Each change `POST`s `/api/games/:id/configure/update` with the in-progress draft so non-owners' read-only mirror reflects it in real time.
5. The owner clicks Go → `POST /api/games/:id/configure/commit` with the final options (mode, timer, target rank, builder, optional custom letters). The server cuts a fresh session straight to `active` and broadcasts. All subscribers navigate to `/g/:id/play`.
6. After the game ends, a player can click "New setup" (back to step 3) or "New board" (cuts a fresh session with the same options via `newBoardFromSession`, no configure round-trip).

### Configure ownership grace
If the configurator's WebSocket disconnects (closed tab, network blip), `configuring` is auto-cancelled after `PRESENCE_GRACE_MS` (30s) so other players can claim setup. Reconnect within 30s cancels the timer (a network blip won't strip ownership). Same grace logic also runs for "all players offline" → auto-end of an active session.

## Wire protocol — WebSocket

Connect to `ws://host/ws/:gameId?playerId=<id>`. The `playerId` is optional (spectators don't need one); when supplied, the server marks that player "online" via `presenceConnect`. On disconnect, `presenceDisconnect` decrements; when the player's connection count drops to zero, they're "offline". (Multi-tab is fine: presence transitions only fire on the 0↔1 boundary.)

The server pushes JSON. There are exactly two message shapes:

```ts
{ type: "state",     view: ClientView }   // on every state change
{ type: "heartbeat", view: ClientView }   // every 5s (HEARTBEAT_MS)
```

Both carry a full `view`. Heartbeats double as a watchdog signal — clients use them to detect a half-open socket where `onclose` never fires.

**Close codes:**
- `4404` ("Game not found") — the URL id is unknown to the server.
- All other closures are normal (network, server restart, client unmount).

The client never sends WebSocket messages. State changes go via REST; the WebSocket is one-way (server → client).

### Why the asymmetric protocol?

Five reasons, in roughly the order they mattered:

1. **The data flow is itself asymmetric.** The server pushes high-frequency state — other players' submits, presence transitions, configure-draft updates from whoever's setting up, heartbeat-cadence elapsed-time refreshes. The client emits low-frequency user actions: a submit every few seconds at peak, a pause / resume / end here and there. Pushing tens of state updates per minute through WebSocket is the right tool; pushing one click per action through REST is also the right tool. Mixing them would mean inventing a worse version of one for the other's job.

2. **REST gives request/response semantics for free.** Every client → server interaction is "do a thing, tell me the new state". HTTP has this baked in: status codes, response bodies, retries, browser DevTools inspection, middleware-based auth. The submit response is `{result, points, isPangram}` — distinct from the broadcast `clientView` and easier to handle inline. With WS-as-RPC we'd reinvent correlation IDs, ack envelopes, and error-mapping conventions, all at lower fidelity than HTTP.

3. **No need to correlate requests with responses.** Multiple actions can be in flight (a submit firing while a pause request is pending, say). Each REST call has its own TCP socket and response; the client doesn't have to pair them up. Doing the same over a single WebSocket would require the client to track outstanding request IDs and route incoming messages back to the right caller.

4. **The two channels are independent failure modes.** If the WebSocket dies (network blip, proxy idle-kill), the client can still POST a submit or end-game via REST — the user isn't blocked from finishing. Conversely, REST POSTs always trigger a broadcast on the way out, so even a hypothetical scenario where the WS is healthy but a single REST call fails doesn't desync the other clients. Putting both directions on one channel would couple the failure modes.

5. **The server's REST response *is* the next state.** Routes that mutate (submit, pause, resume, end, configure/*) return a fresh `clientView` (or a submit-specific shape) in the response body. The client applies it via the same `applyServerView` path that handles WS pushes. So the round-trip is "one POST, one full state delta" — no waiting for a separate WebSocket message to confirm the action took effect. The WebSocket is purely the "tell me when *somebody else* did something" channel.

Said differently: the WebSocket exists *so other tabs / players can find out about your actions*, not so you can find out about your own. Your own actions return their effect synchronously via HTTP.

### `ClientView`

The redacted projection that's safe to ship to the client. Built by `clientView(session, viewerId)` in `server/sessions.js`. Conceptually:

```ts
type ClientView = {
  gameId, sessionId,                    // URL id + per-board id
  mode: "solo" | "multi" | "compete",
  state: "active" | "ended"             // or "assembling"/"configuring" for groups
                                        //   without a current session
  letters, center,                      // 6 outer + 1 center
  words, total,                         // counts for the bottom-of-screen stats
  timerMode, countdownSeconds,
  builder,                              // BoardBuilder strategy used
  found, bonusFound, score,             // co-op + solo: shared. compete: viewer's own.
  ended, paused, elapsed,
  // Multi only:
  players?: Array<{ playerId, name, color, online, score?, foundCount? }>,
  hostId?,
  foundBy?: { [word]: playerId },       // co-op only
  messages?: Array<{ playerId, text, important?, ts }>,
  // Compete only:
  winnerId?,                            // set when ended
  missedByMe?: { [word]: playerId },    // post-end "what others got that I didn't"
  // Group flow:
  configuring?: { ownerId, draft? },    // present only while setup is in progress
  // Post-end review:
  revealList?,                          // scoring words; only present once ended
};
```

**Critical invariant**: the unfound `wordlistSet` and `scoringSet` (the actual answer sets for this puzzle) are *never* in the view. `revealList` is only attached after `state === "ended"`. There's a test (`clientView` redaction in `tests/api/games.test.js`) that pins this down. Don't add fields that would let the client see unfound words.

For compete, the view is per-viewer: each player's WebSocket gets their own `found`/`score`/`missedByMe` slice. The session itself stores per-player state in `session.playerState[playerId]`.

### Subscriber model

Subscribers are keyed by URL id (`group.id` for multi, `session.id` for solo), so chat broadcasts (group-level events) and submits (session-level events) both fan out to the same listener pool. Inside a group, both `broadcast(session)` (for session changes) and `broadcastGroup(group)` (for group-only changes like configuring state) push to the same id.

### Client reconnect

`useGameStream` (in `src/components/`) is the client hook that owns the socket. It auto-reconnects on close with exponential backoff (1s → 2s → 5s steady, ±20% jitter). A heartbeat watchdog force-closes the socket from the client side if no message arrives for 15s — this catches half-open TCP that the browser hasn't noticed. The hook returns a status (`"connecting" | "connected" | "reconnecting"`); `<Game>` shows a "Reconnecting…" pill if the reconnecting state lasts ≥ 1s (most blips self-heal in well under a second; a flickering pill on every blip would read as broken).

## REST API surface

```
POST /api/groups                          create empty group, host on roster
POST /api/games                           solo only — create a session
POST /api/games/:id/join                  add a player to a group
POST /api/games/:id/leave                 remove a player from a group

POST /api/games/:id/configure             claim "I'm setting up the next game"
POST /api/games/:id/configure/update      push in-progress form state for mirrors
POST /api/games/:id/configure/cancel      release the claim
POST /api/games/:id/configure/commit      cut a fresh session with the chosen options

POST /api/games/:id/submit                try a word
POST /api/games/:id/pause                 pause the timer
POST /api/games/:id/resume                resume
POST /api/games/:id/end                   end the game (sets state="ended")
POST /api/games/:id/new-board             cut a fresh session in the same group
POST /api/games/:id/chat                  append a chat message

GET  /api/games/:id                       fetch current ClientView
GET  /api/define/:word                    dictionary lookup for the popover
```

All POST bodies are JSON. Membership is enforced by `playerId` in the body where it matters; non-members get 403. The full route definitions live in `server/routes.js` (~340 lines).

## Board generation

`server/builders.js` is the focus; `server/game.js` holds the primitives.

### Word lists (`scowl-50.txt`, `scowl-80.txt`)

Two SCOWL lists ship in `data/`. The bigger one (`scowl-80.txt`, ~100k words) is the **legal** set: anything in here can be submitted and counted. The smaller one (`scowl-50.txt`) is the **scoring** subset: words from this list count toward the score, drive the rank ladder, and appear in the post-end `revealList`. Pangrams are only drawn from the scoring list — that guarantees every random puzzle has a "real" pangram that an average player would know.

The lists were filtered down from app.aspell.net (US + GB-ise + GB-ize spellings, variant_level=3) to lowercase ASCII alphabetic words ≥ 4 letters. To swap sizes, change the `LEGAL_WORDS_FILE` / `SCORING_WORDS_FILE` constants at the top of `server/sessions.js`.

### Letter masks

Every word and every puzzle is represented as a 26-bit integer (`letterBit('a')` = 1, `letterBit('z')` = 1<<25). Operations that would otherwise need string scans become bitwise:

```js
// Does word w only use the puzzle's allowed letters?
(wordMask & allowedMask) === wordMask

// Does w include the center?
(wordMask & centerBit) !== 0

// Pangram?
popcount(wordMask) === 7

// How many letters do these two boards share?
popcount(boardA & boardB)
```

`processWords(legalText, scoringText)` runs once at startup and returns parallel arrays `{words, masks, lengths, inScoring, pangramMasks}`. `pangramMasks` is the deduplicated set of 7-letter masks that have a pangram in the scoring list — about 3,685 of them across the lists we ship.

### The puzzle rules

Random puzzles must satisfy `isValidPuzzleMask`:
- **No 's'.** S would make a third of the words trivial via plurals; we enforce this on the *outer letters and center*. (S-words still exist in the legal list — custom-letters games can use them.)
- **q→u**: if 'q' is in the puzzle, 'u' must be too (no playable q-words otherwise).
- **≥ 2 vowels** (A E I O U; y excluded).

These three are baked into the candidate pool (`pangramMasks`). Past that, every random board must clear the **`MIN_FOUND` ≥ 30** filter: at least 30 scoring words exist for the chosen (mask, center) pair. This rejects boards where the pangram exists but the rest of the answer set is sparse.

### The two strategies

There's a small `BoardBuilder` abstraction in `server/builders.js`: a factory `(data) → { name, next({ previousMask? }) }`. The chosen builder is per-session (stored on `session.builder`) and selectable from the configure UI. Two ship today:

#### `default`

The original algorithm:

1. Pick a uniformly random mask from `pangramMasks`.
2. **ING dampener**: if the mask contains all three of {i, n, g} simultaneously, accept it only with probability `ING_ACCEPT_RATE` (1/3); otherwise reject and resample. Without this, ~20% of boards would be `-ing` factories (inflections of every common verb), which makes consecutive games feel repetitive in their *words* even when the letters differ.
3. Pick a random center letter from the 7.
4. Build the puzzle (`buildGame`) and check `words >= MIN_FOUND`. If not, restart from step 1.

ING dampening fires for both builders. It's solving "boards keep producing the same kinds of words", which is orthogonal to "boards keep using the same kinds of letters". `default` uniformly samples from the natural English pangram pool — which is itself heavily biased toward common letters (the letter 'e' appears in ~68% of valid pangram masks; 'q' in ~3%).

#### `diverse` (default for new sessions)

Stacks two compounding levers on top of `default`:

1. **Tier-weighted candidate pool.** Instead of sampling uniformly from `pangramMasks`, the diverse builder samples from a *weighted pool* where rare-letter pangrams are duplicated. Three tiers compound:

    | Tier      | Letters     | Multiplier |
    |-----------|-------------|------------|
    | very rare | j q x z     | ×8         |
    | rare      | k v w y     | ×3         |
    | uncommon  | b f h       | ×1.5       |

    A pangram with both a 'j' and a 'k' gets weight 8 × 3 = 24, so its mask appears 24 times in the sampling array (vs. 1 copy for an all-common-letters pangram). Uniform sampling from this padded array is mathematically equivalent to weighted sampling but cheaper at runtime and easier to reason about.

2. **Consecutive-board overlap cap.** When `next()` is given a `previousMask`, the builder rejects any candidate that shares more than `MAX_PREV_OVERLAP` (4) letters with it. Without this, average overlap between consecutive boards in the same session is ~3.10 / 7 (44%), which is the main driver of the "this board feels like the last one" sensation. The cap drops it to ~2.78.

The `previousMask` is sourced contextually: solo passes the previous game's `letters + center` as `previousLetters` in the request body; multi reads it from the group's last session via `previousMaskFromGroup(group)`.

Both levers respect the structural ceiling: 'j' appears in only ~63 of the ~3,030 playable pangram masks (a hard cap of ~2.1% under uniform sampling). Weighting can push it to ~5–10% but not higher, because that's all the j-pangram material there is. See `scripts/board-stats.js` for the full simulation that calibrated these weights.

### Cost

Acceptance rate (probability a random draw clears all filters):
- `default`: ~67% (1.49 draws per accepted board)
- `diverse`: ~52% (1.91 draws per board)

In wall-clock time, both are well under a millisecond per board. The cost matters more for the simulation script than for production traffic.

## Custom letters

The `commitConfiguration` and `POST /api/games` paths take optional `letters` (6 outer) + `center`. When supplied, they bypass the BoardBuilder entirely and `makeCustomGame(data, letters, center)` builds the board directly from those letters. Only structural input validation applies (must be 6+1 unique letters, no q without u). The puzzle's `wordlist` is whatever scoring + legal words exist for that letter set, no `MIN_FOUND` minimum — the player asked for these letters and is expected to know what they're getting into.

The `builder` field is still stored on the session for custom games (it's just a recorded preference). On "New board" off a custom game, the next board is random and uses the recorded builder.

## Timer model

Each session has `timerMode: "none" | "up" | "down"`, plus `startedAt` (wall-clock anchor for the current running interval) and `accumulatedMs` (sum of completed intervals). Elapsed time is:

- `accumulatedMs + (Date.now() - startedAt)` while running
- `accumulatedMs` while paused

`snapshotElapsed` flushes a running interval into `accumulatedMs` on pause/end. `maybeAutoEnd` runs at the top of every `getSession` call so a countdown that expired with no one hitting an endpoint still reports as ended on the next read (it doesn't need a wall-clock timer firing in the background).

The client's `useTimer` hook reads `Date.now()` *during render* on purpose — `useState` would show a 1-frame stale value on resume. ESLint disables `react-hooks/refs` and `react-hooks/purity` for that file only.

Sessions are unpaused at creation. Pause/resume only fire from explicit user action.

## Scoring and ranks

`scoreWord(w)` in `game.js`:
- 4-letter word: 1 point
- 5+ letter word: word length (5 → 5, 6 → 6, ...)
- Pangram bonus: +10

Total score and rank ladder live in `shared/ranks.js` (used by both client and server — don't duplicate the constants):

```js
RANKS = ["Start", "Good", "Solid", "Nice", "Great", "Amazing", "Genius"];
GENIUS_AT = 0.68;  // fraction of total score that earns Genius
```

Other ranks are spaced linearly between 0 and 0.68 of the total. `currentRankIndex(score, total)` is the canonical lookup; the rank bar in the UI uses the same function as the compete "first to rank N" end-condition check on the server.

## TTLs and presence

| Constant | Value | What it controls |
|---|---|---|
| `SESSION_TTL_MS` | 24h | Session evicted this long after `lastActiveAt` |
| `GROUP_TTL_MS` | 7d | Group evicted (groups outlive sessions on purpose; chat carries) |
| `PRESENCE_GRACE_MS` | 30s | Auto-end + auto-cancel-configuring grace after all players go offline |
| `HEARTBEAT_MS` | 5s | Server heartbeat cadence |
| `HEARTBEAT_TIMEOUT_MS` | 15s | Client watchdog (3 missed heartbeats → force reconnect) |

Eviction is lazy — there's no background sweep timer. `getSession()` runs `maybeSweep()` at the top, which iterates the maps once every 10 minutes and drops expired entries.

## Notable design quirks

- **No DB.** State is in-memory and intentionally so. The risk model is "if the server restarts, in-flight games are lost" — accepted because games are ephemeral and players can just start over. `STORE`/`GROUPS`/`SUBS` are stashed on `globalThis` so `node --watch` HMR survives without losing in-flight games.
- **`<Game>` is shared between solo and multi.** It receives a `playerId` prop (null for solo) and conditionally renders the chat / leaderboard / leave-button affordances. The page-level wrappers (`SoloPage`, `PlayPage`) handle navigation, route-specific data fetching, and "what to do when the game ends or a new board cuts".
- **`<WordList>` uses `column-count: auto` with a fixed row height** to compute pagination capacity = `column-count × floor(height / row-height)`. The CSS comment near the rule explains why `column-fill: balance` would break it. The phone breakpoint hides the inline word list and replaces it with a fixed-position popover toggled by `.Game-wordlist-toggle`.
- **A `clientView` push on board flip is the signal to remount.** Multi sessions cycle their `sessionId` on "new board" (URL id stays the same — the group id). The client uses `sessionId` as a React `key` on `<Game>`, so the flip naturally throws away local state and re-initializes from the new view.
- **Two parallel ref-based hooks** (`useGameStream`, `useGlobalKeyHandler`) use the same trick: a ref holding the latest callback, written from a no-deps `useEffect` on every render, read from a stable listener registered once. This avoids the "WebSocket reopens every render" problem without using stale closures.
- **The `setBuilder` field on HomePage shadows nothing.** It's the local React `useState` setter; the storage helper of the same idea is `saveSavedBuilder`. The earlier review caught a real `setBanner` shadow that's been since fixed.

## Tests

Vitest with jsdom and `globals: true`; `vitest.setup.js` polyfills `localStorage`/`sessionStorage` (jsdom's stubs lack the real `Storage` methods). Tests are colocated under `tests/` mirroring `src/` and `server/`. Use `_resetStore()` from `server/sessions.js` between server tests to avoid cross-test leaks.

The test pyramid roughly:
- **server/** — REST routes + session state machinery + builder simulations (the largest band)
- **components/** — Game, Chat, WordList, useTimer, Leaderboard pieces, setupFields, useGameStream
- **pages/** — HomePage, LobbyPage, PlayPage, SoloPage (route-level integration with mocked fetch + FakeWebSocket)

Total ~360 tests. The server-side game-builder tests use the real word lists; React-side tests mock fetch and instantiate a `FakeWebSocket` that supports `addEventListener("open"|"message"|"close", fn)` plus test-only `fireOpen()` / `fireMessage()` / `fireClose()` helpers.

## Where to look for...

| If you want to understand... | Read... |
|---|---|
| What the client receives | `clientView` in `server/sessions.js` |
| The full WebSocket lifecycle | `server/ws.js` (server) + `src/components/useGameStream.js` (client) |
| The room/lifecycle state machine | `startConfiguring` / `commitConfiguration` / `cancelConfiguring` in `server/sessions.js` |
| How a board is generated | `server/builders.js` + `server/game.js`'s `buildGame` |
| Scoring rules | `scoreWord` in `server/game.js` + `shared/ranks.js` |
| The big React component | `src/components/Game.jsx` (~650 lines; the orchestration root) |
| Configure-form details | `src/components/ConfigureForm.jsx` |
| Why a board feels the way it does | `scripts/board-stats.js` (run with N) |
