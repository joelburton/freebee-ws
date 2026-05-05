import { useEffect, useRef, useState } from "react";

// Display interpolator. The server is authoritative for elapsed time; this
// hook anchors on every server-provided change to {serverElapsed, paused,
// ended} and ticks locally at 1Hz between anchors so the UI stays smooth
// without polling. When paused/ended/mode==='none', the local tick is
// suspended and `displayTime` snaps to the last server value.
//
// Implementation note: `tick` exists only to trigger a re-render every
// second; the elapsed value is computed from `Date.now()` at render time
// so a re-render right after resume reads a current clock (rather than
// a stale `now` snapshot from before the pause).
export default function useTimer({
  mode,
  countdownSeconds,
  serverElapsed,
  paused,
  ended,
}) {
  const [, setTick] = useState(0);
  const [anchor, setAnchor] = useState(() => ({
    at: Date.now(),
    elapsed: serverElapsed,
  }));

  // Re-anchor on (a) paused/ended toggles, or (b) a *new* serverElapsed
  // that diverges from the local interpolation by more than 1 second.
  // The drift check only runs when serverElapsed actually changed since
  // the last sync — otherwise the natural advance of the local clock
  // would look like drift to itself and re-anchor every tick.
  // Within a 1s tolerance we trust the local clock, so heartbeats with
  // matching elapsed don't reset the 1Hz tick phase (which would make
  // seconds visibly stretch/shrink). Snapping kicks in for real drift,
  // e.g., a tab backgrounded long enough for setInterval to fall behind.
  const lastSync = useRef({ paused, ended, serverElapsed });
  const liveElapsed =
    paused || ended
      ? anchor.elapsed
      : anchor.elapsed + Math.floor((Date.now() - anchor.at) / 1000);
  const stateChanged =
    lastSync.current.paused !== paused || lastSync.current.ended !== ended;
  const elapsedChanged = lastSync.current.serverElapsed !== serverElapsed;
  const drift = Math.abs(serverElapsed - liveElapsed);
  if (stateChanged || elapsedChanged) {
    lastSync.current = { paused, ended, serverElapsed };
  }
  if (stateChanged || (elapsedChanged && drift > 1)) {
    setAnchor({ at: Date.now(), elapsed: serverElapsed });
  }

  useEffect(() => {
    if (mode === "none" || paused || ended) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [mode, paused, ended]);

  const elapsed =
    paused || ended
      ? anchor.elapsed
      : anchor.elapsed + Math.floor((Date.now() - anchor.at) / 1000);
  const remaining = Math.max(0, countdownSeconds - elapsed);
  const displayTime = mode === "down" ? remaining : elapsed;
  const timeUp = mode === "down" && remaining === 0;

  return { elapsed, displayTime, timeUp };
}
