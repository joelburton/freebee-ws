// Tiny JSON-fetch helpers shared across pages.
export async function postJson(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || "Request failed");
  }
  return resp.json();
}

export async function fetchGame(id) {
  const resp = await fetch(`/api/games/${id}`);
  if (!resp.ok) return null;
  return resp.json();
}

// Dictionary lookup. Resolves to the definition string, or null if the
// server has no entry (404) or the request fails.
export async function fetchDefinition(word) {
  try {
    const resp = await fetch(`/api/define/${encodeURIComponent(word)}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.def || null;
  } catch {
    return null;
  }
}

// "M:SS" or "MM:SS" → seconds; null on bad input.
export function parseTime(s) {
  const m = (s || "").trim().match(/^(\d+):(\d{1,2})$/);
  if (!m) return null;
  const total = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return total > 0 ? total : null;
}

// Open a WebSocket to /ws/:gameId; returns the socket. Caller closes it.
export function openGameStream(gameId, playerId) {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const qs = playerId ? `?playerId=${encodeURIComponent(playerId)}` : "";
  return new WebSocket(
    `${proto}//${window.location.host}/ws/${gameId}${qs}`,
  );
}
