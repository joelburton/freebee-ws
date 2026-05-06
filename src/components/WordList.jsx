import { useEffect, useLayoutEffect, useRef, useState } from "react";

// Default capacity used while we measure or in environments where layout
// isn't available (jsdom, SSR). Real values come from ResizeObserver
// reading the live `column-count` and `--wl-row-height` (varies by
// breakpoint: 3 cols × 14 rows = 42 on phone/tablet, 5 × 14 = 70 on
// laptop). 42 is a safe under-estimate for the first paint.
const FALLBACK_PAGE_SIZE = 42;

function isPangram(word) {
  return new Set(word).size === 7;
}

export default function WordList({
  found,
  all,
  bonusSet,
  wordColors,
  recentlyFound,
  // Optional override; tests use this to make pagination deterministic.
  // Production callers leave it undefined and let the hook below derive
  // the value from the actual rendered layout.
  pageSize: pageSizeProp,
  // Set false to suppress the inline nav row — the parent will render
  // the controls elsewhere (e.g., on the Game's action bar) using the
  // state surfaced via `onPagination`.
  showNav = true,
  // Notified whenever pagination state changes:
  // { page, totalPages, setPage }. The setPage reference is stable.
  onPagination,
}) {
  const [page, setPage] = useState(0);
  const [computedPageSize, setComputedPageSize] = useState(FALLBACK_PAGE_SIZE);
  const listRef = useRef(null);

  // Capacity = columns × rows, derived from the live layout so a future
  // media-query change to column-count or `--wl-row-height` "just works"
  // without code changes. ResizeObserver keeps it in sync if the panel
  // resizes (e.g., window resize on a responsive layout).
  useLayoutEffect(() => {
    if (pageSizeProp != null) return;
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const cols = parseInt(cs.columnCount, 10);
      const rowHeight = parseFloat(cs.getPropertyValue("--wl-row-height"));
      const boxHeight = el.clientHeight;
      // Only update if every input is sane — otherwise keep the fallback
      // (jsdom returns 0 for clientHeight, so tests stay deterministic).
      if (!Number.isFinite(cols) || cols < 1) return;
      if (!Number.isFinite(rowHeight) || rowHeight <= 0) return;
      if (!Number.isFinite(boxHeight) || boxHeight <= 0) return;
      const rows = Math.max(1, Math.floor(boxHeight / rowHeight));
      const next = cols * rows;
      setComputedPageSize((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pageSizeProp]);

  const pageSize = pageSizeProp ?? computedPageSize;

  const foundSet = new Set(found);

  // In reveal mode, fold in any words the player found that aren't in the
  // scoring/reveal list, so their bonus marker stays visible.
  const display = all ? Array.from(new Set([...all, ...found])) : found;
  const sorted = display.length ? [...display].sort() : [];
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const slice = sorted.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  );
  const navHidden = totalPages <= 1;

  // Surface pagination state so a parent can render its own nav (e.g., on
  // the Game's action bar). `setPage` is React useState's stable setter.
  useEffect(() => {
    if (!onPagination) return;
    onPagination({ page: safePage, totalPages, setPage });
  }, [onPagination, safePage, totalPages]);

  return (
    <div className="WordList-wrapper">
      <ul ref={listRef} className="WordList">
        {sorted.length === 0 ? (
          <li className="WordList-empty">No words yet</li>
        ) : (
          slice.map((word) => {
            const classes = [];
            if (isPangram(word)) classes.push("WordList-pangram");
            if (!foundSet.has(word)) classes.push("WordList-unfound");
            const isBonus = !!(bonusSet && bonusSet.has(word));
            // Multi: word text is rendered in the finder's color (so a
            // glance at the list shows who got what); recently-added
            // words also get a thick same-color underline that fades
            // after a few seconds so you notice arrivals. Unfound
            // (reveal-mode) words and solo finds have no entry in
            // wordColors.
            const color = wordColors ? wordColors[word] : undefined;
            const isRecent = recentlyFound
              ? recentlyFound.has(word)
              : false;
            if (color && isRecent) classes.push("WordList-recent");
            return (
              <li
                key={word}
                className={classes.join(" ") || undefined}
                style={color ? { color } : undefined}
              >
                {word}
                {isBonus && (
                  <span className="WordList-bonus" aria-label="bonus" />
                )}
              </li>
            );
          })
        )}
      </ul>
      {showNav && (
        <div
          className={`WordList-nav${navHidden ? " is-hidden" : ""}`}
          aria-hidden={navHidden}
        >
          <button
            type="button"
            className="WordList-nav-button"
            onClick={() => setPage(safePage - 1)}
            disabled={navHidden || safePage === 0}
            aria-label="Previous page"
          >
            ‹
          </button>
          <span className="WordList-nav-page">
            {safePage + 1} / {totalPages}
          </span>
          <button
            type="button"
            className="WordList-nav-button"
            onClick={() => setPage(safePage + 1)}
            disabled={navHidden || safePage >= totalPages - 1}
            aria-label="Next page"
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}
