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
      if (data.mode !== "multi" && data.mode !== "compete") {
        navigate(`/p/${gameId}`, { replace: true });
        return;
      }
      // Lobby is the lobby's job.
      if (data.state === "lobby") {
        navigate(`/g/${gameId}`, { replace: true });
        return;
      }
      const saved = loadSavedState();
      const valid =
        saved &&
        saved.gameId === gameId &&
        saved.playerId &&
        data.players.some((p) => p.playerId === saved.playerId);
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

  function handleResetSetup() {
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
    />
  );
}
