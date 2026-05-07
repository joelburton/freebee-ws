import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Game from "../components/Game";
import {
  clearSavedState,
  loadSavedState,
  setBanner,
} from "../components/storage";
import { fetchGame, postJson } from "../api";

export default function PlayPage() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState(null);
  const [playerId, setPlayerId] = useState(null);
  const [loadError, setLoadError] = useState("");

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
      if (data.mode === "solo") {
        navigate(`/p/${gameId}`, { replace: true });
        return;
      }
      // Lobby / assembling / configuring all live on the lobby route.
      if (
        data.state === "lobby" ||
        data.state === "assembling" ||
        data.state === "configuring" ||
        data.configuring
      ) {
        navigate(`/g/${gameId}`, { replace: true });
        return;
      }
      const saved = loadSavedState();
      const valid =
        saved &&
        saved.gameId === gameId &&
        saved.playerId &&
        data.players?.some((p) => p.playerId === saved.playerId);
      if (!valid) {
        // No identity for this game — fall back to the lobby route, which
        // will show the "already started" card.
        navigate(`/g/${gameId}`, { replace: true });
        return;
      }
      setPlayerId(saved.playerId);
      setGame(data);
    })().catch((e) => setLoadError(e.message));
    return () => {
      cancelled = true;
    };
  }, [gameId, navigate]);

  function handleConfiguring() {
    // Server flipped the group into configure mode (someone clicked
    // "New setup" on the end card). Drop into the lobby route, which
    // renders the configurator's form for the owner and a wait
    // screen for everyone else.
    navigate(`/g/${gameId}`, { replace: true });
  }

  // Server cut a fresh session under the same group (new-board). Replace
  // game so the React key flips and <Game> remounts with the new
  // letters / center.
  function handleBoardChange(view) {
    setGame(view);
  }

  async function handleNewBoard() {
    // The URL stays the same across new-board (same group), so there's
    // no navigate to do — the WS push (and the response body, applied by
    // <Game>) carries the fresh board into the existing route.
    try {
      await postJson(`/api/games/${gameId}/new-board`, { playerId });
    } catch (e) {
      setLoadError(e.message);
    }
  }

  // "New setup" on the end card. For multi/compete: enter configure
  // mode in the same group; the WS push then drops everyone into the
  // lobby's configure UI. For solo, the same button is "back to home".
  async function handleResetSetup() {
    if (game?.mode === "multi" || game?.mode === "compete") {
      try {
        await postJson(`/api/games/${gameId}/configure`, { playerId });
      } catch (e) {
        setLoadError(e.message);
      }
      return;
    }
    clearSavedState();
    navigate("/");
  }

  async function handleLeave() {
    try {
      await postJson(`/api/games/${gameId}/leave`, { playerId });
    } catch (e) {
      console.error("leave failed:", e);
    }
    clearSavedState();
    navigate("/");
  }

  if (loadError) return <div className="App-loading">Error: {loadError}</div>;
  if (!game) return <div className="App-loading">Loading game…</div>;

  return (
    <Game
      // sessionId changes on new-board (gameId stays — same group URL),
      // so this remounts <Game> and clears local state like typed input
      // and feedback that wouldn't otherwise reset between boards.
      key={game.sessionId || game.gameId}
      game={game}
      playerId={playerId}
      onNewGame={handleNewBoard}
      onResetSetup={handleResetSetup}
      onConfiguring={handleConfiguring}
      onBoardChange={handleBoardChange}
      onLeave={handleLeave}
    />
  );
}
