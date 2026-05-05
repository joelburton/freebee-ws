import {
  createRandomSession,
  createCustomSession,
  getSession,
  getMember,
  isHost,
  addPlayer,
  startSession,
  pauseSession,
  resumeSession,
  endSession,
  submitWord,
  addChatMessage,
  newBoardFromSession,
  clientView,
} from "./sessions.js";

async function safeJson(c) {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

// Look up the session, returning either { session } or a 404 response.
function withSession(c) {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return { error: c.json({ error: "Game not found" }, 404) };
  return { session };
}

export function registerApiRoutes(app) {
  // POST /api/games — create solo or multi (multi when playerName present).
  app.post("/api/games", async (c) => {
    const body = await safeJson(c);
    const { letters, center, timerMode, countdownSeconds, playerName } = body;
    const cleanName =
      typeof playerName === "string" ? playerName.trim() : "";
    const opts = {
      timerMode:
        timerMode === "down" || timerMode === "none" ? timerMode : "up",
      countdownSeconds: Number.isFinite(countdownSeconds)
        ? Math.max(0, Math.floor(countdownSeconds))
        : 0,
      ...(cleanName ? { playerName: cleanName } : {}),
    };

    let session;
    if (letters !== undefined || center !== undefined) {
      session = await createCustomSession({ letters, center, ...opts });
      if (session.error) return c.json({ error: session.error }, 400);
    } else {
      session = await createRandomSession(opts);
    }

    const view = clientView(session);
    if (session.mode === "multi") view.playerId = session.hostId;
    return c.json(view);
  });

  // GET /api/games/:id — current state. Auto-end check is inside getSession.
  app.get("/api/games/:id", (c) => {
    const r = withSession(c);
    if (r.error) return r.error;
    return c.json(clientView(r.session));
  });

  // POST /api/games/:id/submit — body { word, playerId? }
  app.post("/api/games/:id/submit", async (c) => {
    const r = withSession(c);
    if (r.error) return r.error;
    const session = r.session;
    if (session.ended) return c.json({ error: "Game already ended" }, 409);
    if (session.paused) return c.json({ error: "Game is paused" }, 409);

    const body = await safeJson(c);
    const { word, playerId } = body;

    if (session.mode === "multi") {
      if (session.state !== "active") {
        return c.json({ error: "Game is not active" }, 409);
      }
      if (!getMember(session, playerId)) {
        return c.json({ error: "Not in this game" }, 403);
      }
    }

    return c.json(submitWord(session, word, playerId || null));
  });

  // POST /api/games/:id/pause — body { playerId } in multi
  app.post("/api/games/:id/pause", async (c) => {
    const r = withSession(c);
    if (r.error) return r.error;
    const body = await safeJson(c);
    if (r.session.mode === "multi" && !getMember(r.session, body.playerId)) {
      return c.json({ error: "Not in this game" }, 403);
    }
    pauseSession(r.session);
    return c.json(clientView(r.session));
  });

  // POST /api/games/:id/resume
  app.post("/api/games/:id/resume", async (c) => {
    const r = withSession(c);
    if (r.error) return r.error;
    const body = await safeJson(c);
    if (r.session.mode === "multi" && !getMember(r.session, body.playerId)) {
      return c.json({ error: "Not in this game" }, 403);
    }
    resumeSession(r.session);
    return c.json(clientView(r.session));
  });

  // POST /api/games/:id/end
  app.post("/api/games/:id/end", async (c) => {
    const r = withSession(c);
    if (r.error) return r.error;
    const body = await safeJson(c);
    if (r.session.mode === "multi" && !getMember(r.session, body.playerId)) {
      return c.json({ error: "Not in this game" }, 403);
    }
    endSession(r.session);
    return c.json(clientView(r.session));
  });

  // POST /api/games/:id/join — multi only, body { playerName }
  app.post("/api/games/:id/join", async (c) => {
    const r = withSession(c);
    if (r.error) return r.error;
    const body = await safeJson(c);
    const result = addPlayer(r.session, body.playerName);
    if (result.error) return c.json({ error: result.error }, 400);
    const view = clientView(r.session);
    view.playerId = result.player.playerId;
    return c.json(view);
  });

  // POST /api/games/:id/start — multi only, host only, body { playerId }
  app.post("/api/games/:id/start", async (c) => {
    const r = withSession(c);
    if (r.error) return r.error;
    const session = r.session;
    if (session.mode !== "multi") {
      return c.json({ error: "Not a multiplayer game" }, 400);
    }
    if (session.state !== "lobby") {
      return c.json({ error: "Game already started" }, 409);
    }
    const body = await safeJson(c);
    if (!isHost(session, body.playerId)) {
      return c.json({ error: "Host only" }, 403);
    }
    startSession(session);
    return c.json(clientView(session));
  });

  // POST /api/games/:id/chat — multi only, body { playerId, text }
  app.post("/api/games/:id/chat", async (c) => {
    const r = withSession(c);
    if (r.error) return r.error;
    const session = r.session;
    if (session.mode !== "multi") {
      return c.json({ error: "Not a multiplayer game" }, 400);
    }
    const body = await safeJson(c);
    if (!getMember(session, body.playerId)) {
      return c.json({ error: "Not in this game" }, 403);
    }
    const result = addChatMessage(session, body.playerId, body.text);
    if (result.error) return c.json({ error: result.error }, 400);
    return c.json(clientView(session));
  });

  // POST /api/games/:id/new-board — multi only, body { playerId }
  app.post("/api/games/:id/new-board", async (c) => {
    const r = withSession(c);
    if (r.error) return r.error;
    const session = r.session;
    if (session.mode !== "multi") {
      return c.json({ error: "Not a multiplayer game" }, 400);
    }
    const body = await safeJson(c);
    if (!getMember(session, body.playerId)) {
      return c.json({ error: "Not in this game" }, 403);
    }
    const next = await newBoardFromSession(session);
    if (next.error) return c.json({ error: next.error }, 400);
    return c.json(clientView(next));
  });
}
