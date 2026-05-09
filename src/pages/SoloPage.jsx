import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Game from "../components/Game";
import { setBanner } from "../components/storage";
import { fetchGame, postJson } from "../api";

export default function SoloPage() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState(null);
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
      if (data.mode !== "solo") {
        // Multi game opened via the solo URL — punt to the multi route.
        navigate(`/g/${gameId}`, { replace: true });
        return;
      }
      setGame(data);
    })().catch((e) => setLoadError(e.message));
    return () => {
      cancelled = true;
    };
  }, [gameId, navigate]);

  async function handleNewBoard() {
    try {
      // Carry the previous game's timer config (so we don't surprise
      // the player with a different mode), the builder choice (so
      // the player doesn't have to re-pick their preference each
      // time), and the letters (so the BoardBuilder can avoid too
      // much overlap with the last board).
      const data = await postJson("/api/games", {
        timerMode: game?.timerMode || "up",
        countdownSeconds: game?.countdownSeconds || 0,
        ...(game?.builder ? { builder: game.builder } : {}),
        ...(game?.letters && game?.center
          ? { previousLetters: game.letters + game.center }
          : {}),
      });
      navigate(`/p/${data.gameId}`, { replace: true });
    } catch (e) {
      setLoadError(e.message);
    }
  }

  function handleResetSetup() {
    // Don't clear saved state — resume from the home page should still work.
    navigate("/");
  }

  if (loadError) {
    return <div className="App-loading">Error: {loadError}</div>;
  }
  if (!game) {
    return <div className="App-loading">Loading game…</div>;
  }
  return (
    <Game
      key={game.gameId}
      game={game}
      onNewGame={handleNewBoard}
      onResetSetup={handleResetSetup}
    />
  );
}
