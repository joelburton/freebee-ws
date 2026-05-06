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

  async function handleLeave() {
    setBusy(true);
    setActionError("");
    try {
      await postJson(`/api/games/${gameId}/leave`, { playerId });
    } catch (e) {
      // Even if the server call fails, drop our local identity — we
      // shouldn't keep someone stuck on a group they tried to leave.
      console.error("leave failed:", e);
    }
    clearSavedState();
    navigate("/");
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
          <>
            <p className="App-multi-waiting">
              {configuringName} is picking the options. You can chat
              while you wait.
            </p>
            <ConfigureForm
              gameId={gameId}
              playerId={playerId}
              initialDraft={configuring.draft}
              readOnly
              busy={busy}
              onError={setActionError}
            />
          </>
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
        <button
          type="button"
          className="App-lobby-leave"
          onClick={handleLeave}
          disabled={busy}
        >
          Leave group
        </button>
      </section>
    </div>
  );
}

function hostName(game) {
  const host = game.players.find((p) => p.playerId === game.hostId);
  return host ? host.name : "the host";
}

// Default form state. Used as the initial draft for owners and as a
// fallback for non-owners until the owner's first /update push arrives.
const DEFAULT_DRAFT = {
  mode: "multi",
  timerMode: "none",
  countdownInput: "5:00",
  endModeCompete: "rank",
  countdownInputCompete: "5:00",
  targetRankCompete: DEFAULT_TARGET_RANK,
  centerInput: "",
  outerInput: "",
};

function mergeDraft(base, override) {
  return { ...base, ...(override || {}) };
}

// In-group configure form. The owner sees an interactive form and posts
// changes to /configure/update so other players' read-only mirrors
// stay in sync. Non-owners pass `readOnly` and the latest draft from
// view.configuring.draft; their state is fully driven by props.
function ConfigureForm({
  gameId,
  playerId,
  initialDraft,
  readOnly = false,
  onCancel,
  busy,
  onError,
}) {
  const [draft, setDraft] = useState(() =>
    mergeDraft(DEFAULT_DRAFT, initialDraft),
  );
  const [submitting, setSubmitting] = useState(false);

  // Non-owner: prop-driven. Owner: ignore incoming drafts (their own
  // local state is authoritative; the WS echo of their own update would
  // otherwise clobber a newer in-flight typing change).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (readOnly) setDraft(mergeDraft(DEFAULT_DRAFT, initialDraft));
  }, [readOnly, initialDraft]);

  // Owner: post initial draft once on claim, so non-owners' mirror has
  // something to render before the first user-driven change. Skipped
  // for read-only renders.
  useEffect(() => {
    if (readOnly) return;
    postJson(`/api/games/${gameId}/configure/update`, {
      playerId,
      draft,
    }).catch(() => {
      // Silent — failure here just means non-owners see defaults until
      // the next change.
    });
    // Run only on first mount of the owner's form. Subsequent draft
    // changes are pushed via setField below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setField(field, value) {
    if (readOnly) return;
    const next = { ...draft, [field]: value };
    setDraft(next);
    postJson(`/api/games/${gameId}/configure/update`, {
      playerId,
      draft: next,
    }).catch(() => {
      // Silent — owner's local state is authoritative for commit.
    });
  }

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
    const body = { playerId, mode: draft.mode, ...extra };
    if (draft.mode === "compete") {
      if (draft.endModeCompete === "down") {
        const cs = ensureCountdown("down", draft.countdownInputCompete);
        if (cs === null) return;
        body.timerMode = "down";
        body.countdownSeconds = cs;
      } else {
        body.timerMode = "up";
        body.targetRank = draft.targetRankCompete;
      }
    } else {
      const cs = ensureCountdown(draft.timerMode, draft.countdownInput);
      if (cs === null) return;
      body.timerMode = draft.timerMode;
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
      letters: draft.outerInput.toLowerCase(),
      center: draft.centerInput.toLowerCase(),
    });
  }

  return (
    <>
      <div className="App-tabs" role="tablist" aria-label="Game mode">
        <button
          type="button"
          role="tab"
          aria-selected={draft.mode === "multi"}
          tabIndex={draft.mode === "multi" ? 0 : -1}
          className={`App-tab${draft.mode === "multi" ? " is-active" : ""}`}
          onClick={() => setField("mode", "multi")}
          disabled={readOnly}
        >
          Co-op
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={draft.mode === "compete"}
          tabIndex={draft.mode === "compete" ? 0 : -1}
          className={`App-tab${draft.mode === "compete" ? " is-active" : ""}`}
          onClick={() => setField("mode", "compete")}
          disabled={readOnly}
        >
          Compete
        </button>
      </div>

      {draft.mode === "multi" ? (
        <TimerControls
          radioGroup="cfg-timer"
          mode={draft.timerMode}
          onModeChange={(v) => setField("timerMode", v)}
          countdown={draft.countdownInput}
          onCountdownChange={(v) => setField("countdownInput", v)}
          disabled={readOnly}
        />
      ) : (
        <EndCondition
          radioGroup="cfg-end"
          mode={draft.endModeCompete}
          onModeChange={(v) => setField("endModeCompete", v)}
          countdown={draft.countdownInputCompete}
          onCountdownChange={(v) => setField("countdownInputCompete", v)}
          targetRank={draft.targetRankCompete}
          onTargetRankChange={(v) => setField("targetRankCompete", v)}
          disabled={readOnly}
        />
      )}

      {!readOnly && (
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
      )}
      <CustomLettersForm
        center={draft.centerInput}
        onCenterChange={(v) => setField("centerInput", v)}
        outer={draft.outerInput}
        onOuterChange={(v) => setField("outerInput", v)}
        onSubmit={commitCustom}
        disabled={readOnly || busy || submitting}
        ariaLabel="Start with chosen letters"
      />

      {!readOnly && (
        <button
          type="button"
          className="App-start-go"
          onClick={onCancel}
          disabled={busy || submitting}
          style={{ alignSelf: "flex-start" }}
        >
          Cancel
        </button>
      )}
    </>
  );
}
