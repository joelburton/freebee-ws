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
import { fetchGame, openGameStream, postJson } from "../api";

export default function LobbyPage() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState(null);
  const [playerId, setPlayerId] = useState(null);
  const [nameInput, setNameInput] = useState(() => loadSavedName());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [copyMsg, setCopyMsg] = useState("");

  // Initial load: fetch state, validate it's a multi lobby, recover saved
  // playerId if it's still in the roster.
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
      if (data.mode !== "multi" && data.mode !== "compete") {
        setBanner("That isn't a multiplayer game.");
        navigate("/", { replace: true });
        return;
      }
      // Already-superseded by /new-board → jump to successor and replace.
      if (data.nextGameId) {
        navigate(`/g/${data.nextGameId}`, { replace: true });
        return;
      }
      setGame(data);
      const saved = loadSavedState();
      const valid =
        saved &&
        saved.gameId === gameId &&
        saved.playerId &&
        data.players.some((p) => p.playerId === saved.playerId);
      if (valid) setPlayerId(saved.playerId);
      // Game has already started: members go to /play, strangers stay
      // here and see the "already started" card.
      if (data.state !== "lobby" && valid) {
        navigate(`/g/${gameId}/play`, { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameId, navigate]);

  // Live lobby updates. When the host hits Start, we navigate to /play.
  useEffect(() => {
    if (!game || game.state !== "lobby") return;
    const ws = openGameStream(gameId, playerId);
    ws.addEventListener("message", (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (!msg?.view) return;
        if (msg.view.nextGameId) {
          navigate(`/g/${msg.view.nextGameId}`, { replace: true });
          return;
        }
        if (msg.view.state !== "lobby" && playerId) {
          navigate(`/g/${gameId}/play`, { replace: true });
          return;
        }
        setGame(msg.view);
      } catch {
        // ignore
      }
    });
    return () => ws.close();
    // Re-run only on lobby-state transitions and the local playerId
    // becoming known; not on every roster broadcast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, game?.state, playerId]);

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

    // Modern API only works in secure contexts (HTTPS or localhost).
    // Testing on a phone via the dev server's LAN IP fails the
    // promise; fall back to the deprecated execCommand path which
    // works on plain HTTP too.
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

  // Not joined: show join card, or "already started" if too late.
  if (!playerId) {
    if (game.state !== "lobby") {
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
          <h2 className="App-card-title">Join game</h2>
          <p className="App-multi-roster-summary">
            {game.players.length === 1
              ? `${game.players[0].name} is waiting.`
              : `${game.players.map((p) => p.name).join(", ")} are waiting.`}
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

  // Joined and in lobby. (active/ended states are handled by the redirect
  // effect — this branch is just the lobby render.)
  const isHost = game.hostId === playerId;
  return (
    <div className="App-start">
      {siteHeader}
      <section className="App-card App-card-lobby">
        <h2 className="App-card-title">Lobby</h2>
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
        <button
          type="button"
          className="App-start-go"
          onClick={handleCopyLink}
        >
          {copyMsg || "Copy share link"}
        </button>
        {isHost ? (
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
