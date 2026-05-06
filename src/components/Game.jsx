import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Letters from "./Letters";
import Feedback from "./Feedback";
import WordList from "./WordList";
import RankBar from "./RankBar";
import Chat from "./Chat";
import useTimer from "./useTimer";
import { saveState } from "./storage";

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ss = s.toString().padStart(2, "0");
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

const EMPTY_FEEDBACK = { message: "", type: null };

const ERROR_MESSAGES = {
  badLetters: "Bad letters",
  tooShort: "Too short!",
  missingCenter: "Must use center letter",
  notAWord: "Not a valid word",
};

export default function Game({
  game,
  onNewGame,
  onResetSetup,
  onNextGame,
  playerId = null,
}) {
  const [found, setFound] = useState(game.found || []);
  const [bonusFound, setBonusFound] = useState(game.bonusFound || []);
  const [score, setScore] = useState(game.score || 0);
  const [ended, setEnded] = useState(game.ended || false);
  const [paused, setPaused] = useState(game.paused || false);
  const [serverElapsed, setServerElapsed] = useState(game.elapsed || 0);
  const [revealList, setRevealList] = useState(game.revealList || null);
  // Multi-only: roster of players + word→playerId attribution. Solo
  // games leave these empty and skip the roster UI / word coloring.
  const [players, setPlayers] = useState(game.players || []);
  const [foundBy, setFoundBy] = useState(game.foundBy || {});
  // Chat backlog (multi only).
  const [messages, setMessages] = useState(game.messages || []);
  const [submitFeedback, setSubmitFeedback] = useState(EMPTY_FEEDBACK);
  const [word, setWord] = useState("");
  const [outerLetters, setOuterLetters] = useState(
    Array.from(game.letters.toUpperCase()),
  );
  const timerMode = game.timerMode || "up";
  const countdownSeconds = game.countdownSeconds || 0;
  const { displayTime, timeUp } = useTimer({
    mode: timerMode,
    countdownSeconds,
    serverElapsed,
    paused,
    ended,
  });
  // `ended` reflects server-confirmed end. `displayEnded` covers the brief
  // window between the client's clock hitting 0 and the server confirming
  // via /end's response or the SSE state event.
  const displayEnded = ended || timeUp;
  const locked = paused || displayEnded;
  // The "Time's up" message is derived (no setState-in-effect cascading);
  // submission feedback is regular transient state. `timeUp` stays true
  // even after the server confirms ended (elapsed is frozen at the limit).
  const feedback = timeUp
    ? { message: "Time's up!", type: "error" }
    : submitFeedback;
  const inputRef = useRef(null);
  const chatRef = useRef(null);
  const submitting = useRef(false);
  const togglingPause = useRef(false);
  // Pagination state surfaced from <WordList> via its onPagination prop;
  // we render the controls ourselves on the action bar.
  const [wordPagination, setWordPagination] = useState({
    page: 0,
    totalPages: 1,
    setPage: () => {},
  });
  // Phone-only: the word list is a popover toggled by a floating button.
  // CSS hides the toggle and inlines the list above the phone breakpoint.
  const [wordListOpen, setWordListOpen] = useState(false);

  const bonusSet = useMemo(() => new Set(bonusFound), [bonusFound]);
  // word → hex color, derived from foundBy + the player roster. Empty in
  // solo since foundBy is empty.
  const wordColors = useMemo(() => {
    if (!players.length) return null;
    const byId = new Map(players.map((p) => [p.playerId, p.color]));
    const out = {};
    for (const w of Object.keys(foundBy)) {
      const c = byId.get(foundBy[w]);
      if (c) out[w] = c;
    }
    return out;
  }, [players, foundBy]);
  const allowedUpper = useMemo(
    () =>
      new Set(
        [...game.letters, game.center].map((c) => c.toUpperCase()),
      ),
    [game.letters, game.center],
  );

  // Words that just arrived in `found` get a 5-second "recently added"
  // underline in the WordList. `knownFoundRef` records what was already
  // present so the *initial* render (or a reconnect with a populated
  // `found` array) doesn't flash on every existing word.
  //
  // Timers live in a ref keyed by word — NOT in the effect's cleanup.
  // The submitter's path triggers `setFound` twice in quick succession
  // (immediate response from /submit, then the WS broadcast a tick
  // later); a per-effect cleanup would cancel the just-scheduled timer
  // when the second update fires, leaving the underline stuck on
  // forever. Per-word timers are independent and fire reliably.
  const [recentlyFound, setRecentlyFound] = useState(() => new Set());
  const knownFoundRef = useRef(new Set(found));
  const recentTimersRef = useRef(new Map());
  useEffect(() => {
    const known = knownFoundRef.current;
    const fresh = found.filter((w) => !known.has(w));
    if (fresh.length === 0) return;
    knownFoundRef.current = new Set(found);
    setRecentlyFound((cur) => {
      const next = new Set(cur);
      fresh.forEach((w) => next.add(w));
      return next;
    });
    fresh.forEach((w) => {
      const existing = recentTimersRef.current.get(w);
      if (existing) clearTimeout(existing);
      const id = setTimeout(() => {
        recentTimersRef.current.delete(w);
        setRecentlyFound((cur) => {
          if (!cur.has(w)) return cur;
          const next = new Set(cur);
          next.delete(w);
          return next;
        });
      }, 5000);
      recentTimersRef.current.set(w, id);
    });
  }, [found]);

  // Clear any pending recent-fade timers on unmount. (No per-effect
  // cleanup above — see comment on the timers ref.)
  useEffect(
    () => () => {
      recentTimersRef.current.forEach((id) => clearTimeout(id));
      recentTimersRef.current.clear();
    },
    [],
  );

  // Server is authoritative for game state. Solo persists just the
  // gameId; multi persists {gameId, playerId} so a refresh of /g/<id>
  // can reconnect to the same roster slot. Without preserving playerId
  // here, Game would clobber the multi pointer that MultiLoader wrote.
  useEffect(() => {
    if (playerId) saveState({ gameId: game.gameId, playerId });
    else saveState({ gameId: game.gameId });
  }, [game.gameId, playerId]);

  // Live state stream. The server pushes { type: "state" | "heartbeat",
  // view } on every change and every HEARTBEAT_MS. Both carry a full
  // clientView; applyServerView keeps the UI in sync even with multiple
  // tabs hitting the same game.
  useEffect(() => {
    if (typeof window === "undefined" || typeof WebSocket === "undefined") {
      return;
    }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const qs = playerId
      ? `?playerId=${encodeURIComponent(playerId)}`
      : "";
    const ws = new WebSocket(
      `${proto}//${window.location.host}/ws/${game.gameId}${qs}`,
    );
    ws.addEventListener("message", (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg && msg.view) applyServerView(msg.view);
      } catch {
        // malformed message — ignore
      }
    });
    return () => ws.close();
    // applyServerView closes over current state setters and onNextGame;
    // we only want to reopen the socket on gameId/playerId change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.gameId, playerId]);

  // Apply a server response that includes a clientView (pause/resume/end
  // returns). Submit responses don't include these fields and are handled
  // separately.
  function applyServerView(data) {
    if (typeof data.elapsed === "number") setServerElapsed(data.elapsed);
    if (typeof data.paused === "boolean") setPaused(data.paused);
    if (typeof data.ended === "boolean") setEnded(data.ended);
    if (data.revealList) setRevealList(data.revealList);
    if (Array.isArray(data.found)) setFound(data.found);
    if (Array.isArray(data.bonusFound)) setBonusFound(data.bonusFound);
    if (typeof data.score === "number") setScore(data.score);
    if (Array.isArray(data.players)) setPlayers(data.players);
    if (data.foundBy && typeof data.foundBy === "object") {
      setFoundBy(data.foundBy);
    }
    if (Array.isArray(data.messages)) setMessages(data.messages);
    // Multi: server creates a successor session when someone clicks
    // "New board" on the ended game. Surface that to the parent loader
    // so every connected player can be brought forward.
    if (data.nextGameId && onNextGame) onNextGame(data.nextGameId);
  }

  async function endGameOnServer() {
    try {
      const resp = await fetch(`/api/games/${game.gameId}/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerId }),
      });
      if (resp.ok) applyServerView(await resp.json());
    } catch {
      // Network failure: locally-set ended keeps the UI from getting stuck.
    }
  }

  // When the client's clock hits 0, ask the server to end the game.
  // The /end response (or an SSE 'state' event) sets `ended` for us.
  useEffect(() => {
    if (!timeUp || ended) return;
    endGameOnServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeUp, ended]);

  async function tryWord(input) {
    const upper = input.toUpperCase();
    if (submitting.current) return;
    submitting.current = true;
    try {
      const resp = await fetch(`/api/games/${game.gameId}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ word: input, playerId }),
      });
      if (!resp.ok) {
        setSubmitFeedback({ message: "Server error", type: "error" });
        return;
      }
      const data = await resp.json();
      if (data.result === "accepted") {
        setSubmitFeedback({
          message: data.isPangram
            ? `${upper}: Pangram! +${data.points}`
            : `${upper}: +${data.points}`,
          type: "success",
        });
        setFound(data.found);
        setBonusFound(data.bonusFound);
        setScore(data.totalScore);
      } else if (data.result === "alreadyFound") {
        setSubmitFeedback({ message: `${upper}: Already found!`, type: "warning" });
      } else {
        const msg = ERROR_MESSAGES[data.result] || "Not a valid word";
        setSubmitFeedback({ message: `${upper}: ${msg}`, type: "error" });
      }
    } catch {
      setSubmitFeedback({ message: "Network error", type: "error" });
    } finally {
      submitting.current = false;
    }
  }

  async function togglePause() {
    if (togglingPause.current) return;
    togglingPause.current = true;
    const path = paused ? "resume" : "pause";
    try {
      const resp = await fetch(`/api/games/${game.gameId}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerId }),
      });
      if (resp.ok) applyServerView(await resp.json());
    } catch {
      // Network error: leave state as-is; next server interaction resyncs.
    } finally {
      togglingPause.current = false;
    }
  }

  function handleSubmit(evt) {
    evt.preventDefault();
    if (locked || !word) return;
    tryWord(word);
    setWord("");
    // On touch devices we deliberately skip refocusing the input —
    // focusing it pops up the soft keyboard, and touch users are most
    // likely entering letters via the on-screen hex buttons. On desktop
    // (mouse/keyboard), restore focus so they can keep typing or tab.
    if (
      typeof window !== "undefined" &&
      !window.matchMedia?.("(pointer: coarse)").matches
    ) {
      inputRef.current?.focus();
    }
  }

  // Tab from the word input pops chat open (or just refocuses if already
  // open) so the player doesn't need to mouse to the chat button.
  function handleWordKeyDown(evt) {
    if (evt.key === "Tab" && !evt.shiftKey && chatRef.current) {
      evt.preventDefault();
      chatRef.current.openAndFocus();
    }
  }

  function handleLetterClick(letter) {
    if (locked) return;
    setWord((w) => (w + letter).toUpperCase());
  }

  function handleDelete() {
    if (locked) return;
    setWord((w) => w.slice(0, -1));
  }

  function handleShuffle() {
    setOuterLetters((ls) => shuffle(ls));
  }

  function handleEndClick() {
    if (ended) return;
    setEnded(true);
    endGameOnServer();
  }

  return (
    <div className="Game">
      <div className="Game-board">
        <header className="Game-title">
          <h1>
            <Link href="/" onClick={onResetSetup}>
              Freebee
            </Link>
          </h1>
        </header>
        <form
          className={`Game-form${locked ? " is-locked" : ""}${
            paused && !displayEnded ? " is-blurred" : ""
          }`}
          onSubmit={handleSubmit}
        >
          <div className="Game-input">
            <div className="WordInput">
              <input
                ref={inputRef}
                className="Form-wordInput"
                value={word}
                onChange={(e) => setWord(e.target.value.toUpperCase())}
                onKeyDown={handleWordKeyDown}
                autoFocus
                spellCheck={false}
                autoComplete="off"
                placeholder={displayEnded ? "Game over" : "Type or click"}
                disabled={locked}
              />
              <div className="WordInput-overlay" aria-hidden="true">
                {word.split("").map((ch, i) => (
                  <span
                    key={i}
                    className={
                      allowedUpper.has(ch) ? undefined : "WordInput-illegal"
                    }
                  >
                    {ch}
                  </span>
                ))}
              </div>
            </div>
            <Feedback message={feedback.message} type={feedback.type} />
          </div>
          <Letters
            letters={outerLetters}
            center={game.center.toUpperCase()}
            onLetterClick={handleLetterClick}
          />
          <div className="Actions">
            <button
              type="button"
              className="Action"
              onClick={handleDelete}
              onMouseDown={(e) => e.preventDefault()}
              disabled={locked}
            >
              Delete
            </button>
            <button
              type="button"
              className="Action Action-icon"
              onClick={handleShuffle}
              onMouseDown={(e) => e.preventDefault()}
              aria-label="Shuffle letters"
              title="Shuffle"
            >
              ⟲
            </button>
            <button type="submit" className="Action" disabled={locked}>
              Enter
            </button>
          </div>
        </form>
      </div>
      <aside className="Game-side">
        {players.length > 0 && (
          <ul className="Game-roster" aria-label="Players">
            {players.map((p) => (
              <li
                key={p.playerId}
                className={`Game-roster-player${p.online === false ? " is-offline" : ""}`}
                style={{ "--player-color": p.color }}
              >
                <span className="Game-roster-dot" aria-hidden="true" />
                <span className="Game-roster-name">{p.name}</span>
                {p.playerId === playerId && (
                  <span className="Game-roster-tag">you</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <RankBar score={score} total={game.total} />
        <div className="Game-stats">
          <div className="Stat">
            <div className="Stat-label">Score</div>
            <div className="Stat-value">
              {score} <span className="Stat-total">/ {game.total}</span>
            </div>
          </div>
          <div className="Stat">
            <div className="Stat-label">Words</div>
            <div className="Stat-value">
              {found.length}{" "}
              <span className="Stat-total">/ {game.words}</span>
            </div>
          </div>
          <div className="Stat">
            <div className="Stat-label">
              Time
              {timerMode !== "none" && !displayEnded && (
                <button
                  type="button"
                  className="Stat-pause"
                  onClick={togglePause}
                  aria-label={paused ? "Resume" : "Pause"}
                  title={paused ? "Resume" : "Pause"}
                >
                  {paused ? "▶" : "⏸"}
                </button>
              )}
            </div>
            <div className="Stat-value">
              {timerMode === "none" ? "—" : formatTime(displayTime)}
            </div>
          </div>
        </div>
        <div
          className={`Game-wordlist${
            wordListOpen ? " is-open" : ""
          }${paused && !displayEnded ? " is-blurred" : ""}`}
        >
          <button
            type="button"
            className="Game-wordlist-close"
            onClick={() => setWordListOpen(false)}
            aria-label="Close word list"
          >
            ×
          </button>
          <WordList
            found={found}
            all={displayEnded ? revealList : null}
            bonusSet={bonusSet}
            wordColors={wordColors}
            recentlyFound={recentlyFound}
            showNav={false}
            onPagination={setWordPagination}
          />
        </div>
        <div className="Game-side-bar">
          <div className="Game-side-bar-group">
            {displayEnded ? (
              <>
                <button
                  type="button"
                  className="Side-button"
                  onClick={onNewGame}
                >
                  New board
                </button>
                <button
                  type="button"
                  className="Side-button"
                  onClick={onResetSetup}
                >
                  New setup
                </button>
              </>
            ) : (
              <button
                type="button"
                className="Side-button"
                onClick={handleEndClick}
              >
                End game
              </button>
            )}
          </div>
          <div
            className={`WordList-nav Game-side-bar-nav${
              wordPagination.totalPages <= 1 ? " is-hidden" : ""
            }`}
            aria-hidden={wordPagination.totalPages <= 1}
          >
            <button
              type="button"
              className="WordList-nav-button"
              onClick={() =>
                wordPagination.setPage(wordPagination.page - 1)
              }
              disabled={
                wordPagination.totalPages <= 1 || wordPagination.page === 0
              }
              aria-label="Previous page"
            >
              ‹
            </button>
            <span className="WordList-nav-page">
              {wordPagination.page + 1} / {wordPagination.totalPages}
            </span>
            <button
              type="button"
              className="WordList-nav-button"
              onClick={() =>
                wordPagination.setPage(wordPagination.page + 1)
              }
              disabled={
                wordPagination.totalPages <= 1 ||
                wordPagination.page >= wordPagination.totalPages - 1
              }
              aria-label="Next page"
            >
              ›
            </button>
          </div>
          {/* Phone-only via CSS: opens the word list popover. Hidden
              on tablet+ where the word list is inline. */}
          <button
            type="button"
            className="Game-wordlist-toggle"
            onClick={() => setWordListOpen((o) => !o)}
            aria-expanded={wordListOpen}
            aria-label="Word list"
          >
            Words {found.length}/{game.words}
          </button>
        </div>
      </aside>
      {playerId && (
        <Chat
          ref={chatRef}
          gameId={game.gameId}
          playerId={playerId}
          players={players}
          messages={messages}
          onTabAway={() => inputRef.current?.focus()}
        />
      )}
    </div>
  );
}
