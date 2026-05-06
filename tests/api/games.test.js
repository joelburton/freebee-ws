import { Hono } from "hono";
import { registerApiRoutes } from "../../server/routes.js";
import {
  _resetStore,
  getSession,
  subscribeToSession,
  pauseSession,
  resumeSession,
  endSession,
  presenceConnect,
  presenceDisconnect,
  SESSION_TTL_MS,
  PRESENCE_GRACE_MS,
} from "../../server/sessions.js";

// One Hono app shared across tests. The assertion shape (Response with
// .status / .json()) is identical to what the old Next route handlers
// returned, so the existing test bodies port verbatim — just the call
// sites change from `await app.fetch(req, { params })` to `await app.fetch(req)`.
const app = new Hono();
registerApiRoutes(app);

function jsonReq(url, body) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  _resetStore();
});

describe("POST /api/games (create)", () => {
  it("creates a random game and returns a client-safe view", async () => {
    const res = await app.fetch(jsonReq("http://localhost/api/games", {}));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.gameId).toBe("string");
    // Two short words joined by a hyphen, e.g. "penguin-orange". The
    // defensive fallback in pickGameId may add a `-xxxx` UUID slice if
    // collisions exhaust the retry loop, so allow an optional 3rd part.
    expect(data.gameId).toMatch(/^[a-z]{4,6}-[a-z]{4,6}(?:-[0-9a-f]{4})?$/);
    expect(data.letters).toHaveLength(6);
    expect(data.center).toHaveLength(1);
    expect(data.words).toBeGreaterThanOrEqual(30);
    expect(data.total).toBeGreaterThan(0);
    expect(data.found).toEqual([]);
    expect(data.score).toBe(0);
    expect(data.ended).toBe(false);
    // No answers leaked.
    expect(data.wordlist).toBeUndefined();
    expect(data.revealList).toBeUndefined();
  });

  it("creates a custom game with full a-z available (incl. 's')", async () => {
    const res = await app.fetch(
      jsonReq("http://localhost/api/games", {
        letters: "abdefg",
        center: "s",
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.center).toBe("s");
    expect(new Set(data.letters)).toEqual(new Set("abdefg"));
  });

  it("rejects structurally invalid custom letters", async () => {
    const res = await app.fetch(
      jsonReq("http://localhost/api/games", {
        letters: "bdein",
        center: "r",
      }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/6/);
  });

  it("rejects custom letters that yield no valid words", async () => {
    const res = await app.fetch(
      jsonReq("http://localhost/api/games", {
        letters: "qxzvwk",
        center: "j",
      }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/No valid words/i);
  });

  it("stores timer config on the session", async () => {
    const res = await app.fetch(
      jsonReq("http://localhost/api/games", {
        timerMode: "down",
        countdownSeconds: 300,
      }),
    );
    const data = await res.json();
    expect(data.timerMode).toBe("down");
    expect(data.countdownSeconds).toBe(300);
  });
});

describe("GET /api/games/[id]", () => {
  it("404s for unknown id", async () => {
    const res = await app.fetch(new Request("http://localhost/api/games/nope"));
    expect(res.status).toBe(404);
  });

  it("returns the current state for a known id (no answers)", async () => {
    const create = await app.fetch(jsonReq("http://localhost/api/games", {}));
    const { gameId } = await create.json();
    const res = await app.fetch(
      new Request(`http://localhost/api/games/${gameId}`),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.gameId).toBe(gameId);
    expect(data.revealList).toBeUndefined();
  });

  it("includes revealList once ended", async () => {
    const create = await app.fetch(jsonReq("http://localhost/api/games", {}));
    const { gameId } = await create.json();
    await app.fetch(jsonReq(`http://localhost/api/games/${gameId}/end`, {}));
    const res = await app.fetch(
      new Request(`http://localhost/api/games/${gameId}`),
    );
    const data = await res.json();
    expect(data.ended).toBe(true);
    expect(Array.isArray(data.revealList)).toBe(true);
    expect(data.revealList.length).toBeGreaterThan(0);
  });
});

describe("POST /api/games/[id]/submit", () => {
  async function startCustom() {
    const res = await app.fetch(
      jsonReq("http://localhost/api/games", {
        letters: "bdeint",
        center: "r",
      }),
    );
    return (await res.json()).gameId;
  }

  function submit(gameId, word) {
    return app.fetch(
      jsonReq(`http://localhost/api/games/${gameId}/submit`, { word }),
    );
  }

  it("404s for unknown id", async () => {
    const res = await submit("nope", "tribe");
    expect(res.status).toBe(404);
  });

  it("accepts a valid word and reports score", async () => {
    const id = await startCustom();
    const res = await submit(id, "tribe");
    const data = await res.json();
    expect(data.result).toBe("accepted");
    expect(data.points).toBe(5);
    expect(data.isPangram).toBe(false);
    expect(data.totalScore).toBe(5);
    expect(data.found).toEqual(["tribe"]);
  });

  it("flags pangram with isPangram=true", async () => {
    const id = await startCustom();
    const res = await submit(id, "interbred");
    const data = await res.json();
    expect(data.result).toBe("accepted");
    expect(data.isPangram).toBe(true);
    expect(data.points).toBe(9 + 10);
  });

  it("rejects words with bad letters", async () => {
    const id = await startCustom();
    const res = await submit(id, "qrider");
    expect((await res.json()).result).toBe("badLetters");
  });

  it("rejects too-short words", async () => {
    const id = await startCustom();
    const res = await submit(id, "rib");
    expect((await res.json()).result).toBe("tooShort");
  });

  it("rejects words missing the center letter", async () => {
    const id = await startCustom();
    // bidet: only allowed letters (b,d,e,i,t) — missing center r
    const res = await submit(id, "bidet");
    expect((await res.json()).result).toBe("missingCenter");
  });

  it("rejects already-found words", async () => {
    const id = await startCustom();
    await submit(id, "tribe");
    const res = await submit(id, "tribe");
    expect((await res.json()).result).toBe("alreadyFound");
  });

  it("rejects unknown words", async () => {
    const id = await startCustom();
    const res = await submit(id, "rrrrr");
    expect((await res.json()).result).toBe("notAWord");
  });

  it("flags legal-only finds with bonus=true and tracks bonusFound", async () => {
    const id = await startCustom();
    // 'birder' is in the legal list but not the scoring list for {b,d,e,i,n,t,r}.
    const res = await submit(id, "birder");
    const data = await res.json();
    expect(data.result).toBe("accepted");
    expect(data.bonus).toBe(true);
    expect(data.bonusFound).toEqual(["birder"]);
  });

  it("does not flag scoring finds as bonus", async () => {
    const id = await startCustom();
    const res = await submit(id, "tribe");
    const data = await res.json();
    expect(data.bonus).toBe(false);
    expect(data.bonusFound).toEqual([]);
  });

  it("normalizes case", async () => {
    const id = await startCustom();
    const res = await submit(id, "TRIBE");
    expect((await res.json()).result).toBe("accepted");
  });

  it("409s after the game has ended", async () => {
    const id = await startCustom();
    await app.fetch(jsonReq(`http://localhost/api/games/${id}/end`, {}));
    const res = await submit(id, "tribe");
    expect(res.status).toBe(409);
  });
});

describe("POST /api/games/[id]/end", () => {
  function end(gameId) {
    return app.fetch(jsonReq(`http://localhost/api/games/${gameId}/end`, {}));
  }

  it("404s for unknown id", async () => {
    const res = await end("nope");
    expect(res.status).toBe(404);
  });

  it("ends and returns revealList + found + score", async () => {
    const create = await app.fetch(jsonReq("http://localhost/api/games", {}));
    const { gameId } = await create.json();
    const res = await end(gameId);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ended).toBe(true);
    expect(Array.isArray(data.revealList)).toBe(true);
    expect(data.found).toEqual([]);
    expect(data.score).toBe(0);
  });

  it("is idempotent", async () => {
    const create = await app.fetch(jsonReq("http://localhost/api/games", {}));
    const { gameId } = await create.json();
    await end(gameId);
    const res = await end(gameId);
    expect(res.status).toBe(200);
    expect(getSession(gameId).ended).toBe(true);
  });
});

describe("Server-authoritative timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function pause(gameId) {
    return app.fetch(jsonReq(`http://localhost/api/games/${gameId}/pause`, {}));
  }
  function resume(gameId) {
    return app.fetch(jsonReq(`http://localhost/api/games/${gameId}/resume`, {}));
  }
  function get(gameId) {
    return app.fetch(new Request(`http://localhost/api/games/${gameId}`));
  }

  it("elapsed accrues over wall time and freezes on pause", async () => {
    const create = await app.fetch(jsonReq("http://localhost/api/games", {}));
    const { gameId, elapsed: e0 } = await create.json();
    expect(e0).toBe(0);

    vi.advanceTimersByTime(7000);
    const after7 = await (await get(gameId)).json();
    expect(after7.elapsed).toBe(7);

    await pause(gameId);
    vi.advanceTimersByTime(60000);
    const stillPaused = await (await get(gameId)).json();
    expect(stillPaused.paused).toBe(true);
    expect(stillPaused.elapsed).toBe(7);

    await resume(gameId);
    vi.advanceTimersByTime(3000);
    const after10 = await (await get(gameId)).json();
    expect(after10.paused).toBe(false);
    expect(after10.elapsed).toBe(10);
  });

  it("pause/resume are idempotent", async () => {
    const create = await app.fetch(jsonReq("http://localhost/api/games", {}));
    const { gameId } = await create.json();
    await pause(gameId);
    await pause(gameId);
    const a = await (await get(gameId)).json();
    expect(a.paused).toBe(true);
    expect(a.elapsed).toBe(0);
    await resume(gameId);
    await resume(gameId);
    const b = await (await get(gameId)).json();
    expect(b.paused).toBe(false);
  });

  it("submit returns 409 when paused", async () => {
    const create = await app.fetch(
      jsonReq("http://localhost/api/games", {
        letters: "bdeint",
        center: "r",
      }),
    );
    const { gameId } = await create.json();
    await pause(gameId);
    const res = await app.fetch(
      jsonReq(`http://localhost/api/games/${gameId}/submit`, {
        word: "tribe",
      }),
    );
    expect(res.status).toBe(409);
  });

  it("countdown auto-ends when time expires; elapsed caps at countdownSeconds", async () => {
    const create = await app.fetch(
      jsonReq("http://localhost/api/games", {
        timerMode: "down",
        countdownSeconds: 60,
      }),
    );
    const { gameId } = await create.json();
    vi.advanceTimersByTime(45000);
    const mid = await (await get(gameId)).json();
    expect(mid.ended).toBe(false);
    expect(mid.elapsed).toBe(45);

    vi.advanceTimersByTime(60000); // total 105s, well past the limit
    const final = await (await get(gameId)).json();
    expect(final.ended).toBe(true);
    expect(final.paused).toBe(true);
    expect(final.elapsed).toBe(60);
    expect(final.revealList).toBeDefined();
  });

  it("countdown auto-end fires on submit too (not just GET)", async () => {
    const create = await app.fetch(
      jsonReq("http://localhost/api/games", {
        letters: "bdeint",
        center: "r",
        timerMode: "down",
        countdownSeconds: 5,
      }),
    );
    const { gameId } = await create.json();
    vi.advanceTimersByTime(10000);
    const res = await app.fetch(
      jsonReq(`http://localhost/api/games/${gameId}/submit`, {
        word: "tribe",
      }),
    );
    expect(res.status).toBe(409);
    expect(getSession(gameId).ended).toBe(true);
  });

  it("ending freezes elapsed at the moment of end", async () => {
    const create = await app.fetch(jsonReq("http://localhost/api/games", {}));
    const { gameId } = await create.json();
    vi.advanceTimersByTime(12000);
    await app.fetch(jsonReq(`http://localhost/api/games/${gameId}/end`, {}));
    vi.advanceTimersByTime(60000);
    const data = await (await get(gameId)).json();
    expect(data.ended).toBe(true);
    expect(data.elapsed).toBe(12);
  });

  it("timerMode='none' leaves elapsed at 0 but starts unpaused (game is playable)", async () => {
    const create = await app.fetch(
      jsonReq("http://localhost/api/games", { timerMode: "none" }),
    );
    const { gameId } = await create.json();
    vi.advanceTimersByTime(60000);
    const data = await (await get(gameId)).json();
    expect(data.elapsed).toBe(0);
    expect(data.paused).toBe(false);
  });

  it("multi started with timerMode='none' transitions active and unpaused", async () => {
    const create = await app.fetch(
      jsonReq("http://localhost/api/games", {
        playerName: "Joel",
        timerMode: "none",
      }),
    );
    const { gameId, playerId } = await create.json();
    const res = await app.fetch(
      jsonReq(`http://localhost/api/games/${gameId}/start`, { playerId }),
    );
    const data = await res.json();
    expect(data.state).toBe("active");
    expect(data.paused).toBe(false);
    expect(data.elapsed).toBe(0);
  });
});

describe("subscribe/broadcast", () => {
  it("notifies subscribers on pause/resume/end", async () => {
    const create = await app.fetch(jsonReq("http://localhost/api/games", {}));
    const { gameId } = await create.json();
    const session = getSession(gameId);
    const events = [];
    const unsub = subscribeToSession(gameId, (view) => events.push(view));

    pauseSession(session);
    expect(events.at(-1).paused).toBe(true);
    resumeSession(session);
    expect(events.at(-1).paused).toBe(false);
    endSession(session);
    expect(events.at(-1).ended).toBe(true);
    expect(events.at(-1).revealList).toBeDefined();

    unsub();
    pauseSession(session); // already ended, no broadcast — but also no error.
    expect(events).toHaveLength(3);
  });

  it("delivers a broadcast to multiple subscribers", async () => {
    const create = await app.fetch(jsonReq("http://localhost/api/games", {}));
    const { gameId } = await create.json();
    const session = getSession(gameId);
    const a = vi.fn();
    const b = vi.fn();
    const u1 = subscribeToSession(gameId, a);
    const u2 = subscribeToSession(gameId, b);
    pauseSession(session);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    u1();
    resumeSession(session);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    u2();
  });

  it("survives a subscriber that throws", async () => {
    const create = await app.fetch(jsonReq("http://localhost/api/games", {}));
    const { gameId } = await create.json();
    const session = getSession(gameId);
    const ok = vi.fn();
    subscribeToSession(gameId, () => {
      throw new Error("boom");
    });
    subscribeToSession(gameId, ok);
    expect(() => pauseSession(session)).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("submit (accepted) broadcasts the new state", async () => {
    const create = await app.fetch(
      jsonReq("http://localhost/api/games", {
        letters: "bdeint",
        center: "r",
      }),
    );
    const { gameId } = await create.json();
    const events = [];
    const unsub = subscribeToSession(gameId, (view) => events.push(view));
    await app.fetch(
      jsonReq(`http://localhost/api/games/${gameId}/submit`, {
        word: "tribe",
      }),
    );
    expect(events.at(-1).found).toEqual(["tribe"]);
    expect(events.at(-1).score).toBe(5);
    unsub();
  });
});

// The WS endpoint is exercised by the broadcast plumbing tests above
// (subscribe/broadcast) plus integration smoke testing. Unit-testing the
// WS handshake against an in-memory server adds noise without value.

describe("Session TTL / GC", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("evicts sessions older than SESSION_TTL_MS on next read", async () => {
    const create = await app.fetch(jsonReq("http://localhost/api/games", {}));
    const { gameId } = await create.json();
    expect(getSession(gameId)).not.toBeNull();
    // Advance past TTL plus the sweep cooldown.
    vi.advanceTimersByTime(SESSION_TTL_MS + 60 * 1000);
    // Trigger sweep: any getSession call after the cooldown will scan.
    expect(getSession(gameId)).toBeNull();
  });

  it("activity (any getSession) resets the eviction clock", async () => {
    const create = await app.fetch(jsonReq("http://localhost/api/games", {}));
    const { gameId } = await create.json();
    // Just under the TTL: still alive.
    vi.advanceTimersByTime(SESSION_TTL_MS - 1000);
    expect(getSession(gameId)).not.toBeNull(); // touches lastActiveAt
    // Another full TTL window passes since the touch.
    vi.advanceTimersByTime(SESSION_TTL_MS - 1000);
    expect(getSession(gameId)).not.toBeNull();
  });

  it("does not evict on every read (sweep is rate-limited)", async () => {
    const a = (await (await app.fetch(jsonReq("http://localhost/api/games", {}))).json()).gameId;
    // Make `a` ancient by manipulating its lastActiveAt directly.
    const sa = getSession(a);
    sa.lastActiveAt = Date.now() - SESSION_TTL_MS - 1;
    // The next getSession on `a` itself touches it before the sweep would
    // evict it; but a getSession on a *different* (unknown) id triggers the
    // sweep which removes `a`.
    vi.advanceTimersByTime(10 * 60 * 1000); // past sweep cooldown
    expect(getSession("unknown")).toBeNull(); // forces sweep
    expect(getSession(a)).toBeNull(); // already swept
  });
});

describe("Multiplayer: lobby creation, join, start", () => {  function pjson(url, body) {
    return jsonReq(url, body);
  }

  async function createMulti(extra = {}) {
    const res = await app.fetch(
      pjson("http://localhost/api/games", { playerName: "Joel", ...extra }),
    );
    return res.json();
  }

  it("creates a multi game with mode='multi', state='lobby', host as first player", async () => {
    const data = await createMulti();
    expect(data.mode).toBe("multi");
    expect(data.state).toBe("lobby");
    expect(data.players).toHaveLength(1);
    expect(data.players[0].name).toBe("Joel");
    expect(data.players[0].color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(data.hostId).toBe(data.players[0].playerId);
    expect(data.playerId).toBe(data.hostId);
    // Multi lobby starts paused; the timer hasn't begun.
    expect(data.paused).toBe(true);
    expect(data.elapsed).toBe(0);
  });

  it("solo create returns no playerId / players / hostId", async () => {
    const res = await app.fetch(pjson("http://localhost/api/games", {}));
    const data = await res.json();
    expect(data.mode).toBe("solo");
    expect(data.state).toBe("active");
    expect(data.playerId).toBeUndefined();
    expect(data.players).toBeUndefined();
    expect(data.hostId).toBeUndefined();
  });

  it("join adds a player with a distinct color and returns its playerId", async () => {
    const { gameId } = await createMulti();
    const res = await app.fetch(
      pjson(`http://localhost/api/games/${gameId}/join`, {
        playerName: "Alice",
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.players).toHaveLength(2);
    expect(data.players[1].name).toBe("Alice");
    // Distinct color from host.
    expect(data.players[1].color).not.toBe(data.players[0].color);
    expect(data.playerId).toBe(data.players[1].playerId);
  });

  it("join allows duplicate names (distinguished by color)", async () => {
    const { gameId } = await createMulti();
    await app.fetch(
      pjson(`http://localhost/api/games/${gameId}/join`, {
        playerName: "Joel",
      }),
    );
    const res = await app.fetch(
      pjson(`http://localhost/api/games/${gameId}/join`, {
        playerName: "Joel",
      }),
    );
    const data = await res.json();
    const names = data.players.map((p) => p.name);
    expect(names).toEqual(["Joel", "Joel", "Joel"]);
  });

  it("join refuses an empty name", async () => {
    const { gameId } = await createMulti();
    const res = await app.fetch(
      pjson(`http://localhost/api/games/${gameId}/join`, { playerName: "" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/required/i);
  });

  it("join refuses on a solo game", async () => {
    const create = await app.fetch(pjson("http://localhost/api/games", {}));
    const { gameId } = await create.json();
    const res = await app.fetch(
      pjson(`http://localhost/api/games/${gameId}/join`, {
        playerName: "Alice",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/multiplayer/i);
  });

  it("join refuses after the game has started", async () => {
    const created = await createMulti();
    await app.fetch(
      pjson(`http://localhost/api/games/${created.gameId}/start`, {
        playerId: created.playerId,
      }),
    );
    const res = await app.fetch(
      pjson(`http://localhost/api/games/${created.gameId}/join`, {
        playerName: "Late",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already started/i);
  });

  it("start: host transitions lobby → active and begins the timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const created = await createMulti();
      const res = await app.fetch(
        pjson(`http://localhost/api/games/${created.gameId}/start`, {
          playerId: created.playerId,
        }),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.state).toBe("active");
      expect(data.paused).toBe(false);
      vi.advanceTimersByTime(3000);
      const after = await (
        await app.fetch(
          new Request(`http://localhost/api/games/${created.gameId}`),
        )
      ).json();
      expect(after.elapsed).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("start: 403 for non-host", async () => {
    const created = await createMulti();
    const join = await app.fetch(
      pjson(`http://localhost/api/games/${created.gameId}/join`, {
        playerName: "Alice",
      }),
    );
    const aliceId = (await join.json()).playerId;
    const res = await app.fetch(
      pjson(`http://localhost/api/games/${created.gameId}/start`, {
        playerId: aliceId,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("start: 409 when already started", async () => {
    const created = await createMulti();
    await app.fetch(
      pjson(`http://localhost/api/games/${created.gameId}/start`, {
        playerId: created.playerId,
      }),
    );
    const res = await app.fetch(
      pjson(`http://localhost/api/games/${created.gameId}/start`, {
        playerId: created.playerId,
      }),
    );
    expect(res.status).toBe(409);
  });
});

describe("Multiplayer: in-game actions require membership", () => {
  async function startedMulti(letters = "bdeint", center = "r") {
    const create = await app.fetch(
      jsonReq("http://localhost/api/games", {
        playerName: "Host",
        letters,
        center,
      }),
    );
    const created = await create.json();
    const join = await app.fetch(
      jsonReq(`http://localhost/api/games/${created.gameId}/join`, {
        playerName: "Buddy",
      }),
    );
    const buddyId = (await join.json()).playerId;
    await app.fetch(
      jsonReq(`http://localhost/api/games/${created.gameId}/start`, {
        playerId: created.playerId,
      }),
    );
    return { gameId: created.gameId, hostId: created.playerId, buddyId };
  }

  it("submit: 403 if playerId not in roster", async () => {
    const { gameId } = await startedMulti();
    const res = await app.fetch(
      jsonReq(`http://localhost/api/games/${gameId}/submit`, {
        word: "tribe",
        playerId: "not-a-real-id",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("submit: 409 while game is still in lobby", async () => {
    const create = await app.fetch(
      jsonReq("http://localhost/api/games", {
        playerName: "Host",
        letters: "bdeint",
        center: "r",
      }),
    );
    const { gameId, playerId } = await create.json();
    const res = await app.fetch(
      jsonReq(`http://localhost/api/games/${gameId}/submit`, {
        word: "tribe",
        playerId,
      }),
    );
    expect(res.status).toBe(409);
  });

  it("submit attributes the find via foundBy", async () => {
    const { gameId, buddyId } = await startedMulti();
    const res = await app.fetch(
      jsonReq(`http://localhost/api/games/${gameId}/submit`, {
        word: "tribe",
        playerId: buddyId,
      }),
    );
    expect((await res.json()).result).toBe("accepted");
    const get = await app.fetch(
      new Request(`http://localhost/api/games/${gameId}`),
    );
    const view = await get.json();
    expect(view.found).toEqual(["tribe"]);
    expect(view.foundBy).toEqual({ tribe: buddyId });
  });

  it("pause/resume/end: 403 for non-member, 200 for any member", async () => {
    const { gameId, buddyId } = await startedMulti();
    const noBody = (path) =>
      jsonReq(`http://localhost/api/games/${gameId}/${path}`, {
        playerId: "stranger",
      });
    expect(
      (await app.fetch(noBody("pause"))).status,
    ).toBe(403);
    expect(
      (
        await app.fetch(
          jsonReq(`http://localhost/api/games/${gameId}/pause`, {
            playerId: buddyId,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.fetch(
          jsonReq(`http://localhost/api/games/${gameId}/resume`, {
            playerId: buddyId,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.fetch(
          jsonReq(`http://localhost/api/games/${gameId}/end`, {
            playerId: buddyId,
          }),
        )
      ).status,
    ).toBe(200);
  });
});

describe("Multiplayer presence", () => {
  async function startedMulti() {
    const create = await app.fetch(
      jsonReq("http://localhost/api/games", {
        playerName: "Host",
        letters: "bdeint",
        center: "r",
      }),
    );
    const created = await create.json();
    const join = await app.fetch(
      jsonReq(`http://localhost/api/games/${created.gameId}/join`, {
        playerName: "Buddy",
      }),
    );
    const buddy = await join.json();
    await app.fetch(
      jsonReq(`http://localhost/api/games/${created.gameId}/start`, {
        playerId: created.playerId,
      }),
    );
    return {
      gameId: created.gameId,
      hostId: created.playerId,
      buddyId: buddy.playerId,
    };
  }

  it("clientView reports online=false for joined-but-not-yet-connected players", async () => {
    const create = await app.fetch(
      jsonReq("http://localhost/api/games", { playerName: "Joel" }),
    );
    const data = await create.json();
    expect(data.players[0].online).toBe(false);
  });

  it("connect/disconnect transitions only fire on 0↔1 boundaries (multi-tab)", async () => {
    const { gameId, hostId } = await startedMulti();
    const session = getSession(gameId);
    const events = [];
    const unsub = subscribeToSession(gameId, (v) => events.push(v));

    presenceConnect(session, hostId);
    expect(events.at(-1).players.find((p) => p.playerId === hostId).online).toBe(true);
    presenceConnect(session, hostId); // second tab — no transition
    presenceDisconnect(session, hostId); // first tab away — still online
    expect(events).toHaveLength(1);
    presenceDisconnect(session, hostId); // last tab away — offline now
    expect(events.at(-1).players.find((p) => p.playerId === hostId).online).toBe(false);
    expect(events).toHaveLength(2);

    unsub();
  });

  it("auto-ends after the grace window when all players are offline", async () => {
    vi.useFakeTimers();
    try {
      const { gameId, hostId, buddyId } = await startedMulti();
      const session = getSession(gameId);
      presenceConnect(session, hostId);
      presenceConnect(session, buddyId);
      presenceDisconnect(session, hostId);
      // Buddy still online — game should not be ended.
      vi.advanceTimersByTime(PRESENCE_GRACE_MS + 1000);
      expect(session.state).toBe("active");

      presenceDisconnect(session, buddyId);
      // Now everyone's offline. Just under grace: still active.
      vi.advanceTimersByTime(PRESENCE_GRACE_MS - 1000);
      expect(session.state).toBe("active");
      // Past the grace: ended.
      vi.advanceTimersByTime(2000);
      expect(session.state).toBe("ended");
      expect(session.ended).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnect within grace cancels the auto-end", async () => {
    vi.useFakeTimers();
    try {
      const { gameId, hostId } = await startedMulti();
      const session = getSession(gameId);
      presenceConnect(session, hostId);
      presenceDisconnect(session, hostId);
      // Halfway through the grace, host reconnects.
      vi.advanceTimersByTime(PRESENCE_GRACE_MS / 2);
      presenceConnect(session, hostId);
      vi.advanceTimersByTime(PRESENCE_GRACE_MS);
      expect(session.state).toBe("active");
    } finally {
      vi.useRealTimers();
    }
  });

  it("non-member presence calls are no-ops on a multi session", async () => {
    const { gameId, hostId } = await startedMulti();
    const session = getSession(gameId);
    const before = session.players.find((p) => p.playerId === hostId).connections;
    presenceConnect(session, "stranger");
    expect(
      session.players.find((p) => p.playerId === hostId).connections,
    ).toBe(before);
  });
});

// The WS handler delegates to presenceConnect / presenceDisconnect on
// open / close. Drive those directly — same coverage, no socket setup.
describe("connection presence", () => {
  it("connecting with a member playerId marks online; disconnect marks offline", async () => {
    const create = await app.fetch(
      jsonReq("http://localhost/api/games", { playerName: "Joel" }),
    );
    const { gameId, playerId } = await create.json();
    const session = getSession(gameId);
    expect(session.players[0].connections).toBe(0);

    presenceConnect(session, playerId);
    expect(session.players[0].connections).toBe(1);

    presenceDisconnect(session, playerId);
    expect(session.players[0].connections).toBe(0);
  });

  it("anonymous (no playerId) connection does not affect presence", async () => {
    const create = await app.fetch(
      jsonReq("http://localhost/api/games", { playerName: "Joel" }),
    );
    const { gameId } = await create.json();
    const session = getSession(gameId);
    presenceConnect(session, null);
    expect(session.players[0].connections).toBe(0);
    presenceConnect(session, "not-a-member");
    expect(session.players[0].connections).toBe(0);
  });
});

describe("Multiplayer new-board", () => {
  async function buildEndedMulti() {
    const create = await app.fetch(
      jsonReq("http://localhost/api/games", {
        playerName: "Host",
        timerMode: "down",
        countdownSeconds: 90,
      }),
    );
    const created = await create.json();
    const join = await app.fetch(
      jsonReq(`http://localhost/api/games/${created.gameId}/join`, {
        playerName: "Buddy",
      }),
    );
    const buddy = await join.json();
    await app.fetch(
      jsonReq(`http://localhost/api/games/${created.gameId}/start`, {
        playerId: created.playerId,
      }),
    );
    await app.fetch(
      jsonReq(`http://localhost/api/games/${created.gameId}/end`, {
        playerId: created.playerId,
      }),
    );
    return {
      gameId: created.gameId,
      hostId: created.playerId,
      buddyId: buddy.playerId,
      hostColor: created.players[0].color,
      buddyColor: buddy.players.find((p) => p.playerId === buddy.playerId)
        .color,
    };
  }

  function newBoard(gameId, playerId) {
    return app.fetch(
      jsonReq(`http://localhost/api/games/${gameId}/new-board`, { playerId }),
    );
  }

  it("creates a successor with same roster, same colors, host preserved, timer running", async () => {
    const old = await buildEndedMulti();
    const res = await newBoard(old.gameId, old.hostId);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.gameId).not.toBe(old.gameId);
    expect(data.mode).toBe("multi");
    expect(data.state).toBe("active");
    expect(data.hostId).toBe(old.hostId);
    expect(data.players.map((p) => p.playerId)).toEqual([
      old.hostId,
      old.buddyId,
    ]);
    expect(data.players.map((p) => p.color)).toEqual([
      old.hostColor,
      old.buddyColor,
    ]);
    expect(data.found).toEqual([]);
    expect(data.foundBy).toEqual({});
    expect(data.paused).toBe(false);
    expect(data.timerMode).toBe("down");
    expect(data.countdownSeconds).toBe(90);
  });

  it("with timerMode 'none', successor is unpaused (not stuck blurred)", async () => {
    // A "none" game has no pause/resume button, so a paused successor
    // would be unrecoverable — see newBoardFromSession.
    const create = await app.fetch(
      jsonReq("http://localhost/api/games", {
        playerName: "Host",
        timerMode: "none",
      }),
    );
    const host = await create.json();
    await app.fetch(
      jsonReq(`http://localhost/api/games/${host.gameId}/start`, {
        playerId: host.playerId,
      }),
    );
    await app.fetch(
      jsonReq(`http://localhost/api/games/${host.gameId}/end`, {
        playerId: host.playerId,
      }),
    );
    const res = await app.fetch(
      jsonReq(`http://localhost/api/games/${host.gameId}/new-board`, {
        playerId: host.playerId,
      }),
    );
    const data = await res.json();
    expect(data.timerMode).toBe("none");
    expect(data.paused).toBe(false);
    expect(data.state).toBe("active");
  });

  it("is idempotent: a second caller gets the same successor", async () => {
    const old = await buildEndedMulti();
    const a = await (await newBoard(old.gameId, old.hostId)).json();
    const b = await (await newBoard(old.gameId, old.buddyId)).json();
    expect(b.gameId).toBe(a.gameId);
  });

  it("exposes nextGameId on the old session's view after the first call", async () => {
    const old = await buildEndedMulti();
    const a = await (await newBoard(old.gameId, old.hostId)).json();
    const view = await (
      await app.fetch(
        new Request(`http://localhost/api/games/${old.gameId}`),
      )
    ).json();
    expect(view.nextGameId).toBe(a.gameId);
  });

  it("403 when caller isn't a member", async () => {
    const old = await buildEndedMulti();
    const res = await newBoard(old.gameId, "stranger");
    expect(res.status).toBe(403);
  });

  it("400 on a solo game", async () => {
    const create = await app.fetch(jsonReq("http://localhost/api/games", {}));
    const { gameId } = await create.json();
    const res = await newBoard(gameId, "anything");
    expect(res.status).toBe(400);
  });
});

describe("Multiplayer chat", () => {
  async function multi() {
    const create = await app.fetch(
      jsonReq("http://localhost/api/games", { playerName: "Joel" }),
    );
    const data = await create.json();
    return { gameId: data.gameId, hostId: data.playerId };
  }

  function chat(gameId, playerId, text) {
    return app.fetch(
      jsonReq(`http://localhost/api/games/${gameId}/chat`, {
        playerId,
        text,
      }),
    );
  }

  it("appends a message and broadcasts to subscribers", async () => {
    const { gameId, hostId } = await multi();
    const events = [];
    const unsub = subscribeToSession(gameId, (v) => events.push(v));
    const res = await chat(gameId, hostId, "hello");
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]).toMatchObject({
      playerId: hostId,
      text: "hello",
    });
    expect(events.at(-1).messages[0].text).toBe("hello");
    unsub();
  });

  it("rejects empty messages", async () => {
    const { gameId, hostId } = await multi();
    const res = await chat(gameId, hostId, "   ");
    expect(res.status).toBe(400);
  });

  it("403s for non-members", async () => {
    const { gameId } = await multi();
    const res = await chat(gameId, "stranger", "hi");
    expect(res.status).toBe(403);
  });

  it("400s on a solo game", async () => {
    const create = await app.fetch(jsonReq("http://localhost/api/games", {}));
    const { gameId } = await create.json();
    const res = await chat(gameId, "x", "hi");
    expect(res.status).toBe(400);
  });

  it("truncates over-long text to 500 chars", async () => {
    const { gameId, hostId } = await multi();
    const longText = "x".repeat(600);
    const res = await chat(gameId, hostId, longText);
    const view = await res.json();
    expect(view.messages[0].text).toHaveLength(500);
  });

  it("caps history at 100 messages (oldest dropped)", async () => {
    const { gameId, hostId } = await multi();
    for (let i = 0; i < 105; i++) {
      await chat(gameId, hostId, `m${i}`);
    }
    const view = await (
      await app.fetch(
        new Request(`http://localhost/api/games/${gameId}`),
      )
    ).json();
    expect(view.messages).toHaveLength(100);
    expect(view.messages[0].text).toBe("m5");
    expect(view.messages.at(-1).text).toBe("m104");
  });
});
