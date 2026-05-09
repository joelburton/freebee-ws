import { useEffect, useRef, useState } from "react";

// Heartbeat watchdog: server pushes every 5s; close from our side after
// 3 missed (covers half-open sockets where the close event never fires).
const HEARTBEAT_TIMEOUT_MS = 15000;

// Reconnect backoff: 1s, 2s, then 5s steady, with ±20% jitter.
function backoffMs(attempt) {
  if (attempt === 0) return 0;
  const base = attempt === 1 ? 1000 : attempt === 2 ? 2000 : 5000;
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

// Subscribe to /ws/:gameId and forward each `view` message to the
// caller's onView handler. Auto-reconnects on close with backoff and
// runs a watchdog that force-closes a silent socket so we reconnect
// after a network blip / sleep / proxy idle-kill instead of silently
// freezing the UI.
//
// Returns one of "connecting" | "connected" | "reconnecting":
//   connecting   — initial state until the first open
//   connected    — socket is open and receiving messages
//   reconnecting — was connected, isn't now; auto-reopening
export default function useGameStream(gameId, playerId, onView) {
  const onViewRef = useRef(onView);
  useEffect(() => {
    onViewRef.current = onView;
  });

  const [status, setStatus] = useState("connecting");

  useEffect(() => {
    if (typeof window === "undefined" || typeof WebSocket === "undefined") {
      return;
    }

    let cancelled = false;
    let ws = null;
    let reconnectTimer = null;
    let watchdogTimer = null;
    let attempt = 0;
    let hasConnected = false;

    function clearWatchdog() {
      if (watchdogTimer !== null) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
    }

    function armWatchdog() {
      clearWatchdog();
      watchdogTimer = setTimeout(() => {
        // Heartbeat missed for too long — kick the socket so the close
        // handler reconnects. The browser may take its own time before
        // firing onclose on a half-open TCP connection.
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      }, HEARTBEAT_TIMEOUT_MS);
    }

    function open() {
      if (cancelled) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const qs = playerId ? `?playerId=${encodeURIComponent(playerId)}` : "";
      ws = new WebSocket(
        `${proto}//${window.location.host}/ws/${gameId}${qs}`,
      );

      ws.addEventListener("open", () => {
        if (cancelled) return;
        attempt = 0;
        hasConnected = true;
        setStatus("connected");
        armWatchdog();
      });

      ws.addEventListener("message", (evt) => {
        if (cancelled) return;
        armWatchdog(); // any message — state or heartbeat — resets the deadline
        try {
          const msg = JSON.parse(evt.data);
          if (msg && msg.view) onViewRef.current(msg.view);
        } catch {
          // malformed — ignore
        }
      });

      ws.addEventListener("close", () => {
        if (cancelled) return;
        clearWatchdog();
        setStatus(hasConnected ? "reconnecting" : "connecting");
        attempt += 1;
        reconnectTimer = setTimeout(open, backoffMs(attempt));
      });

      // The browser fires close after error in all cases we care about,
      // so we don't need a separate error handler.
    }

    open();

    return () => {
      cancelled = true;
      clearWatchdog();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [gameId, playerId]);

  return status;
}
