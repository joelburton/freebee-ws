import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fetchDefinition } from "../api.js";

// How long the definition popover stays up after a click. Clicking
// another word swaps in the new definition and resets the timer.
const DEFINITION_VISIBLE_MS = 5000;
// Phone breakpoint matches §10 of globals.css. The definition popover
// is desktop-only — on phone, taps on word-list items do nothing.
const PHONE_QUERY = "(max-width: 759px)";

// Definition text uses three pairs of sigils: {polite=adj} for
// cross-references, <wear=v> for variant pointers, [adj IMPOLITER,
// IMPOLITEST] for inflection lists. Render the contents italicized
// while keeping the surrounding punctuation visible (the brackets
// carry structural meaning the player can still parse).
const SIGIL_RE = /([{<[])([^}>\]]*)([}>\]])/g;
function renderDefinition(text) {
  const out = [];
  let i = 0;
  let key = 0;
  for (const m of text.matchAll(SIGIL_RE)) {
    if (m.index > i) out.push(text.slice(i, m.index));
    out.push(m[1], <em key={key++}>{m[2]}</em>, m[3]);
    i = m.index + m[0].length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

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
  // When false, render every word in a single flowing list (no slicing,
  // no nav, no measurement). The phone full-screen takeover uses this
  // so the player can scroll instead of paging.
  paginate = true,
}) {
  const [page, setPage] = useState(0);
  const [computedPageSize, setComputedPageSize] = useState(FALLBACK_PAGE_SIZE);
  const listRef = useRef(null);
  // { word, def, top, left } — fixed-position coords from the clicked
  // <li>'s bounding rect. `def === null` means "no definition" / pending.
  const [definition, setDefinition] = useState(null);

  // Auto-dismiss the popover 5s after it appears. If the player clicks
  // another word, `definition` swaps to the new entry and this effect
  // re-runs (clearing the previous timer first).
  useEffect(() => {
    if (!definition) return;
    const t = setTimeout(() => setDefinition(null), DEFINITION_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [definition]);

  const handleWordClick = async (word, e) => {
    if (window.matchMedia?.(PHONE_QUERY).matches) return;
    // Re-clicking the word that's already showing dismisses the popover
    // (toggle behavior). Same as clicking the popover itself.
    if (definition && definition.word === word) {
      setDefinition(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    // Anchor below the clicked word, left-aligned with it. Show
    // immediately with a "Looking up…" placeholder so the click feels
    // responsive even if the request races (it's local sqlite, but
    // still — showing nothing for 50 ms reads as "did my click work?").
    setDefinition({ word, def: null, top: rect.bottom, left: rect.left });
    const def = await fetchDefinition(word);
    // Bail if the user has since clicked another word; that newer
    // request owns the popover now.
    setDefinition((prev) =>
      prev && prev.word === word ? { ...prev, def: def ?? "" } : prev,
    );
  };

  // Capacity = columns × rows, derived from the live layout so a future
  // media-query change to column-count or `--wl-row-height` "just works"
  // without code changes. ResizeObserver keeps it in sync if the panel
  // resizes (e.g., window resize on a responsive layout).
  useLayoutEffect(() => {
    if (!paginate) return;
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
  }, [pageSizeProp, paginate]);

  const pageSize = paginate ? (pageSizeProp ?? computedPageSize) : Infinity;

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

  // Re-sync `page` to `safePage` after totalPages shrinks (e.g., the
  // word list collapses post-end on compete). Without this, page would
  // hold its stale unclamped value and the user would jump back to it
  // when the list grew again.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  // Surface pagination state so a parent can render its own nav (e.g., on
  // the Game's action bar). `setPage` is React useState's stable setter.
  useEffect(() => {
    if (!onPagination) return;
    onPagination({ page: safePage, totalPages, setPage });
  }, [onPagination, safePage, totalPages]);

  return (
    <div className="WordList-wrapper">
      <ul
        ref={listRef}
        className={`WordList${paginate ? "" : " WordList-scroll"}`}
      >
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
                onClick={(e) => handleWordClick(word, e)}
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
      {definition && (
        <div
          className="WordList-define"
          role="dialog"
          aria-label={`Definition of ${definition.word}`}
          style={{ top: definition.top, left: definition.left }}
          onClick={() => setDefinition(null)}
        >
          <div className="WordList-define-word">{definition.word}</div>
          <div className="WordList-define-body">
            {definition.def === null
              ? "…"
              : definition.def === ""
                ? "No definition available"
                : renderDefinition(definition.def)}
          </div>
        </div>
      )}
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
