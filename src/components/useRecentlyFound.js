import { useEffect, useRef, useState } from "react";

// "Recently found" tracker for the WordList underline. Words that just
// arrived in `found` get a 5-second underline; the *initial* render (or
// a reconnect with a populated list) doesn't flash on existing words.
//
// Per-word setTimeouts live in a ref keyed by word — NOT in the
// effect's cleanup. The submitter's path triggers `setFound` twice in
// quick succession (the immediate response from /submit, then the WS
// broadcast a tick later); a per-effect cleanup would cancel the
// just-scheduled timer when the second update fires, leaving the
// underline stuck on forever.
export default function useRecentlyFound(found) {
  const [recentlyFound, setRecentlyFound] = useState(() => new Set());
  const knownFoundRef = useRef(new Set(found));
  const timersRef = useRef(new Map());

  useEffect(() => {
    const known = knownFoundRef.current;
    const fresh = found.filter((w) => !known.has(w));
    if (fresh.length === 0) return;
    knownFoundRef.current = new Set(found);
    setRecentlyFound((cur) => {
      const next = new Set(cur);
      fresh.forEach((w) => next.add(w));
      return next;
    });
    fresh.forEach((w) => {
      const existing = timersRef.current.get(w);
      if (existing) clearTimeout(existing);
      const id = setTimeout(() => {
        timersRef.current.delete(w);
        setRecentlyFound((cur) => {
          if (!cur.has(w)) return cur;
          const next = new Set(cur);
          next.delete(w);
          return next;
        });
      }, 5000);
      timersRef.current.set(w, id);
    });
  }, [found]);

  // Clear pending timers on unmount. (No per-effect cleanup above —
  // see the comment on the timers ref.)
  useEffect(
    () => () => {
      timersRef.current.forEach((id) => clearTimeout(id));
      timersRef.current.clear();
    },
    [],
  );

  return recentlyFound;
}
