import { useEffect, useRef } from "react";

// Subscribe to /ws/:gameId and forward each `view` message to the
// caller's onView handler. Uses a ref so handler closures don't force
// the socket to reopen on every render — the socket is rebound only
// when gameId or playerId changes.
export default function useGameStream(gameId, playerId, onView) {
  const onViewRef = useRef(onView);
  useEffect(() => {
    onViewRef.current = onView;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof WebSocket === "undefined") {
      return;
    }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const qs = playerId ? `?playerId=${encodeURIComponent(playerId)}` : "";
    const ws = new WebSocket(
      `${proto}//${window.location.host}/ws/${gameId}${qs}`,
    );
    ws.addEventListener("message", (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg && msg.view) onViewRef.current(msg.view);
      } catch {
        // malformed message — ignore
      }
    });
    return () => ws.close();
  }, [gameId, playerId]);
}
