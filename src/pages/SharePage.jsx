import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { setBanner } from "../components/storage";
import { postJson } from "../api";

// Lands here from a "share this puzzle" link. Reads the letters / timer
// from the query string, POSTs a fresh solo session to the server, then
// redirects to /p/<newId>. Each visit to a share URL creates its own
// session; sender and recipient end up playing independently with the
// same puzzle.
export default function SharePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const letters = (params.get("letters") || "").toLowerCase();
      const center = (params.get("center") || "").toLowerCase();
      if (!/^[a-z]{6}$/.test(letters) || !/^[a-z]$/.test(center)) {
        setBanner("That share link looks broken.");
        navigate("/", { replace: true });
        return;
      }
      const timerMode = params.get("timerMode");
      const countdownSeconds = Number(params.get("countdownSeconds"));
      try {
        const data = await postJson("/api/games", {
          letters,
          center,
          timerMode:
            timerMode === "down" || timerMode === "none" ? timerMode : "up",
          countdownSeconds: Number.isFinite(countdownSeconds)
            ? Math.max(0, Math.floor(countdownSeconds))
            : 0,
        });
        if (cancelled) return;
        navigate(`/p/${data.gameId}`, { replace: true });
      } catch (e) {
        if (cancelled) return;
        setBanner(e.message || "Couldn't start that puzzle.");
        navigate("/", { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params, navigate]);

  return <div className="App-loading">Starting puzzle…</div>;
}
