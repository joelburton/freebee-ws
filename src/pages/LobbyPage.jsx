import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  clearSavedState,
  loadSavedName,
  loadSavedState,
  saveSavedName,
  saveState,
  setBanner,
} from "../components/storage";
import { fetchGame, openGameStream, parseTime, postJson } from "../api";
import {
  CustomLettersForm,
  EndCondition,
  TimerControls,
} from "../components/setupFields";

const DEFAULT_TARGET_RANK = 6;

export default function LobbyPage() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState(null);
  const [playerId, setPlayerId] = useState(null);
  const [nameInput, setNameInput] = useState(() => loadSavedName());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [copyMsg, setCopyMsg] = useState("");

  // Initial load: fetch state, recover saved playerId if it's still in
  // the roster.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await fetchGame(gameId);
      if (cancelled) return;
      if (!data) {
        setBanner("That game doesn't exist.");
        navigate("/", { replace: true });
        return;
      }
      // Solo URL ended up here by mistake.
      if (data.mode === "solo") {
        setBanner("That isn't a multiplayer game.");
        navigate("/", { replace: true });
        return;
      }
      setGame(data);
      const saved = loadSavedState();
      const valid =
        saved &&
        saved.gameId === gameId &&
        saved.playerId &&
        data.players?.some((p) => p.playerId === saved.playerId);
      if (valid) setPlayerId(saved.playerId);
      if (data.state === "active" && valid) {
        navigate(`/g/${gameId}/play`, { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameId, navigate]);

  // Live updates: chat, roster, configure ownership, plus the flip to
  // active when someone commits configuration.
  useEffect(() => {
    if (!game) return;
    if (game.state === "active") return;
    const ws = openGameStream(gameId, playerId);
    ws.addEventListener("message", (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg?.view) setGame(msg.view);
      } catch {
        // ignore
      }
    });
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, game?.state, playerId]);

  // Navigate to /play when the session goes active and we have an
  // identity. Kept separate from the WS handler so it can't miss the
  // transition: if a state push lands with the WS-handler's closure
  // still holding a stale (null) playerId, that handler skips its
  // inline navigate and just calls setGame; this effect picks up the
  // (state="active", playerId=set) combination on the next render.
  useEffect(() => {
    if (game?.state === "active" && playerId) {
      navigate(`/g/${gameId}/play`, { replace: true });
    }
  }, [game?.state, playerId, gameId, navigate]);

  async function handleJoin(evt) {
    evt.preventDefault();
    const name = nameInput.trim();
    if (!name) return;
    setBusy(true);
    setActionError("");
    try {
      const data = await postJson(`/api/games/${gameId}/join`, {
        playerName: name,
      });
      setGame(data);
      setPlayerId(data.playerId);
      saveSavedName(name);
      saveState({ gameId, playerId: data.playerId });
    } catch (e) {
      setActionError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleStartSetup() {
    setBusy(true);
    setActionError("");
    try {
      await postJson(`/api/games/${gameId}/configure`, { playerId });
    } catch (e) {
      setActionError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelSetup() {
    setBusy(true);
    setActionError("");
    try {
      await postJson(`/api/games/${gameId}/configure/cancel`, { playerId });
    } catch (e) {
      setActionError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Legacy single-step start (for sessions that still spin up via the
  // old /api/games path with a session-level lobby state).
  async function handleStart() {
    setBusy(true);
    setActionError("");
    try {
      await postJson(`/api/games/${gameId}/start`, { playerId });
      navigate(`/g/${gameId}/play`);
    } catch (e) {
      setActionError(e.message);
      setBusy(false);
    }
  }

  function handleCopyLink() {
    const url = window.location.href;
    const flash = (msg) => {
      setCopyMsg(msg);
      setTimeout(() => setCopyMsg(""), 2000);
    };

    // Modern API only works in secure contexts. On a phone via the dev
    // server's LAN IP it fails — fall back to execCommand which works
    // on plain HTTP too.
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        flash(ok ? "Link copied!" : "Copy failed");
      } catch (err) {
        console.error("copy fallback failed:", err);
        flash("Copy failed");
      }
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => flash("Link copied!"),
        (err) => {
          console.error("clipboard.writeText failed:", err);
          fallback();
        },
      );
    } else {
      fallback();
    }
  }

  function goHome() {
    clearSavedState();
    navigate("/");
  }

  if (!game) return <div className="App-loading">Loading game…</div>;

  const siteHeader = (
    <header className="App-header">
      <h1>
        <Link to="/">Freebee</Link>
      </h1>
    </header>
  );

  // Not-yet-in-the-roster: show a join card. (Or "already started" if
  // they arrived too late to join an active session.)
  if (!playerId) {
    if (game.state === "active") {
      return (
        <div className="App-start">
          {siteHeader}
          <section className="App-card">
            <h2 className="App-card-title">Game already started</h2>
            <p>
              You can&rsquo;t join this game — it&rsquo;s already in progress.
            </p>
            <button type="button" className="App-start-go" onClick={goHome}>
              Home
            </button>
          </section>
        </div>
      );
    }
    return (
      <div className="App-start">
        {siteHeader}
        <section className="App-card">
          <h2 className="App-card-title">Join group</h2>
          <p className="App-multi-roster-summary">
            {game.players?.length === 1
              ? `${game.players[0].name} is waiting.`
              : `${(game.players || []).map((p) => p.name).join(", ")} are waiting.`}
          </p>
          <form className="App-start-row" onSubmit={handleJoin}>
            <label className="App-start-field App-start-field-wide">
              <span>Your name</span>
              <input
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value.slice(0, 32))}
                placeholder="Name"
                spellCheck={false}
                autoComplete="off"
                autoFocus
                disabled={busy}
              />
            </label>
            <button
              type="submit"
              className="App-start-go"
              disabled={busy || !nameInput.trim()}
            >
              Join
            </button>
          </form>
          {actionError && <p className="App-start-error">{actionError}</p>}
        </section>
      </div>
    );
  }

  const isHost = game.hostId === playerId;
  const configuring = game.configuring;
  const isConfigurator = configuring && configuring.ownerId === playerId;
  const configuringName = configuring
    ? game.players.find((p) => p.playerId === configuring.ownerId)?.name ||
      "Someone"
    : null;
  const isLegacyLobby = game.state === "lobby"; // session-level lobby

  return (
    <div className="App-start">
      {siteHeader}
      <section className="App-card App-card-lobby">
        <h2 className="App-card-title">
          {isConfigurator
            ? "Set up the next game"
            : configuring
              ? `${configuringName} is setting up…`
              : "Lobby"}
        </h2>
        {!isConfigurator && (
          <ul className="App-lobby-roster">
            {game.players.map((p) => (
              <li
                key={p.playerId}
                style={{ "--player-color": p.color }}
                className={`App-lobby-player${
                  p.online === false ? " is-offline" : ""
                }`}
              >
                <span className="App-lobby-dot" aria-hidden="true" />
                <span className="App-lobby-name">{p.name}</span>
                {p.playerId === game.hostId && (
                  <span className="App-lobby-tag">host</span>
                )}
                {p.playerId === playerId && (
                  <span className="App-lobby-tag">you</span>
                )}
              </li>
            ))}
          </ul>
        )}

        {isConfigurator ? (
          <ConfigureForm
            gameId={gameId}
            playerId={playerId}
            onCancel={handleCancelSetup}
            busy={busy}
            onError={setActionError}
          />
        ) : configuring ? (
          <p className="App-multi-waiting">
            Waiting while {configuringName} picks the options. You can
            still chat.
          </p>
        ) : (
          <>
            <button
              type="button"
              className="App-start-go"
              onClick={handleCopyLink}
            >
              {copyMsg || "Copy share link"}
            </button>
            {isLegacyLobby ? (
              isHost ? (
                <>
                  <button
                    type="button"
                    className="App-start-go"
                    onClick={handleStart}
                    disabled={busy || game.players.length < 2}
                  >
                    Start game
                  </button>
                  <p className="App-multi-waiting">
                    {game.players.length < 2
                      ? "Waiting for friends to join — share the link above."
                      : "Start the game once everyone you invited has arrived."}
                  </p>
                </>
              ) : (
                <p className="App-multi-waiting">
                  Waiting for {hostName(game)} to start…
                </p>
              )
            ) : (
              <>
                <button
                  type="button"
                  className="App-start-go"
                  onClick={handleStartSetup}
                  disabled={busy}
                >
                  Start setup
                </button>
                <p className="App-multi-waiting">
                  {game.players.length < 2
                    ? "Waiting for friends to join — share the link above."
                    : "Click to pick game options for everyone."}
                </p>
              </>
            )}
          </>
        )}
        {actionError && <p className="App-start-error">{actionError}</p>}
      </section>
    </div>
  );
}

function hostName(game) {
  const host = game.players.find((p) => p.playerId === game.hostId);
  return host ? host.name : "the host";
}

// In-group configure form: mode + timer/end + optional custom letters.
// Owner-only; rendered when the group is in "configuring" state and
// the viewer owns the form.
function ConfigureForm({ gameId, playerId, onCancel, busy, onError }) {
  const [mode, setMode] = useState("multi"); // "multi" (co-op) or "compete"
  const [timerMode, setTimerMode] = useState("none");
  const [countdownInput, setCountdownInput] = useState("5:00");
  const [endModeCompete, setEndModeCompete] = useState("rank");
  const [countdownInputCompete, setCountdownInputCompete] = useState("5:00");
  const [targetRankCompete, setTargetRankCompete] = useState(
    DEFAULT_TARGET_RANK,
  );
  const [centerInput, setCenterInput] = useState("");
  const [outerInput, setOuterInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function ensureCountdown(modeStr, inputStr) {
    if (modeStr !== "down") return 0;
    const s = parseTime(inputStr);
    if (!s) {
      onError("Countdown must be M:SS or MM:SS (e.g. 5:00)");
      return null;
    }
    return s;
  }

  async function commit(extra = {}) {
    onError("");
    const body = { playerId, mode, ...extra };
    if (mode === "compete") {
      if (endModeCompete === "down") {
        const cs = ensureCountdown("down", countdownInputCompete);
        if (cs === null) return;
        body.timerMode = "down";
        body.countdownSeconds = cs;
      } else {
        body.timerMode = "up";
        body.targetRank = targetRankCompete;
      }
    } else {
      const cs = ensureCountdown(timerMode, countdownInput);
      if (cs === null) return;
      body.timerMode = timerMode;
      body.countdownSeconds = cs;
    }
    setSubmitting(true);
    try {
      // Server pushes "active" state via WS; lobby's effect navigates.
      await postJson(`/api/games/${gameId}/configure/commit`, body);
    } catch (e) {
      onError(e.message);
      setSubmitting(false);
    }
  }

  function commitRandom() {
    return commit();
  }

  function commitCustom(evt) {
    evt.preventDefault();
    return commit({
      letters: outerInput.toLowerCase(),
      center: centerInput.toLowerCase(),
    });
  }

  return (
    <>
      <div className="App-tabs" role="tablist" aria-label="Game mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "multi"}
          tabIndex={mode === "multi" ? 0 : -1}
          className={`App-tab${mode === "multi" ? " is-active" : ""}`}
          onClick={() => setMode("multi")}
        >
          Co-op
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "compete"}
          tabIndex={mode === "compete" ? 0 : -1}
          className={`App-tab${mode === "compete" ? " is-active" : ""}`}
          onClick={() => setMode("compete")}
        >
          Compete
        </button>
      </div>

      {mode === "multi" ? (
        <TimerControls
          radioGroup="cfg-timer"
          mode={timerMode}
          onModeChange={setTimerMode}
          countdown={countdownInput}
          onCountdownChange={setCountdownInput}
        />
      ) : (
        <EndCondition
          radioGroup="cfg-end"
          mode={endModeCompete}
          onModeChange={setEndModeCompete}
          countdown={countdownInputCompete}
          onCountdownChange={setCountdownInputCompete}
          targetRank={targetRankCompete}
          onTargetRankChange={setTargetRankCompete}
        />
      )}

      <div className="App-start-row">
        <span className="App-start-row-label">Random letters</span>
        <button
          type="button"
          className="App-start-go"
          onClick={commitRandom}
          disabled={busy || submitting}
          aria-label="Start with random letters"
        >
          Go
        </button>
      </div>
      <CustomLettersForm
        center={centerInput}
        onCenterChange={setCenterInput}
        outer={outerInput}
        onOuterChange={setOuterInput}
        onSubmit={commitCustom}
        disabled={busy || submitting}
        ariaLabel="Start with chosen letters"
      />

      <button
        type="button"
        className="App-start-go"
        onClick={onCancel}
        disabled={busy || submitting}
        style={{ alignSelf: "flex-start" }}
      >
        Cancel
      </button>
    </>
  );
}
