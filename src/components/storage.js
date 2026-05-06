export const STORAGE_KEY = "freebee:state";

// Only the gameId is persisted; the server holds the entire game state
// (found words, score, elapsed time, pause, ended). On reload the client
// rehydrates via GET /api/games/:id.
export function loadSavedState() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.gameId) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveState(state) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // quota / disabled — silently ignore
  }
}

export function clearSavedState() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

// One-shot error banner survives a single navigation (sessionStorage), used
// when redirecting from /g/<id> to / because the URL was bad.
const BANNER_KEY = "freebee:banner";

export function setBanner(message) {
  if (typeof window === "undefined") return;
  try {
    if (message == null) {
      window.sessionStorage.removeItem(BANNER_KEY);
    } else {
      window.sessionStorage.setItem(BANNER_KEY, String(message));
    }
  } catch {
    // ignore
  }
}

// Read and clear in one step (so a refresh doesn't keep showing the banner).
export function takeBanner() {
  if (typeof window === "undefined") return null;
  try {
    const v = window.sessionStorage.getItem(BANNER_KEY);
    if (v) window.sessionStorage.removeItem(BANNER_KEY);
    return v;
  } catch {
    return null;
  }
}

// Player name persists in its own slot, separate from STORAGE_KEY (which
// is per-game state). It pre-fills the name field on the home page and
// the lobby join card so the player doesn't retype it every session.
const NAME_KEY = "freebee:name";

export function loadSavedName() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(NAME_KEY) || "";
  } catch {
    return "";
  }
}

export function saveSavedName(name) {
  if (typeof window === "undefined") return;
  try {
    const trimmed = String(name || "").trim().slice(0, 32);
    if (trimmed) window.localStorage.setItem(NAME_KEY, trimmed);
  } catch {
    // ignore
  }
}
