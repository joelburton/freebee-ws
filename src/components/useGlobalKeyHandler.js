import { useEffect, useRef } from "react";

// Listen for keydown on window with a ref-based dispatcher: the
// caller's handler closes over fresh state (word, locked, etc.) every
// render, but only one window listener is registered for the whole
// component's lifetime. Without the ref the listener would either
// re-register on every render (bad — flashes events through stale
// listeners during dispatch) or capture stale closures (worse).
export default function useGlobalKeyHandler(handler) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    function dispatch(e) {
      ref.current(e);
    }
    window.addEventListener("keydown", dispatch);
    return () => window.removeEventListener("keydown", dispatch);
  }, []);
}
