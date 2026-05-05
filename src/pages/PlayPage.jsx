import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Game from "../components/Game";
import {
  clearSavedState,
  loadSavedState,
  saveState,
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
      if (data.mode !== "multi") {
        navigate(`/p/${gameId}`, { replace: true });
        return;
      }
      // Server has cut a successor — bring this player along.
      if (data.nextGameId) {
        navigate(`/g/${data.nextGameId}/play`, { replace: true });
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

  function handleNextGame(nextId) {
    const saved = loadSavedState();
    if (saved?.gameId === gameId && saved.playerId) {
      saveState({ gameId: nextId, playerId: saved.playerId });
    }
    navigate(`/g/${nextId}/play`);
  }

  async function handleNewBoard() {
    try {
      const data = await postJson(`/api/games/${gameId}/new-board`, {
        playerId,
      });
      handleNextGame(data.gameId);
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
      key={game.gameId}
      game={game}
      playerId={playerId}
      onNewGame={handleNewBoard}
      onResetSetup={handleResetSetup}
      onNextGame={handleNextGame}
    />
  );
}
