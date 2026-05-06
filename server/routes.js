import {
  createRandomSession,
  createCustomSession,
  createEmptyGroup,
  getSession,
  getGroup,
  getGroupForId,
  getMember,
  isHost,
  isMultiplayer,
  addPlayer,
  removePlayer,
  startSession,
  pauseSession,
  resumeSession,
  endSession,
  submitWord,
  addChatMessage,
  newBoardFromSession,
  startConfiguring,
  cancelConfiguring,
  commitConfiguration,
  clientView,
  groupView,
} from "./sessions.js";
import { lookupDefinition } from "./defs.js";

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
  // POST /api/games — create solo, co-op (multi), or compete.
  // Inferred mode: playerName present + no explicit mode → "multi".
  // Explicit modes: "solo", "multi", "compete". For "compete", an
  // optional `targetRank` (index into RANKS) sets the first-to-rank
  // end condition.
  app.post("/api/games", async (c) => {
    const body = await safeJson(c);
    const {
      letters,
      center,
      timerMode,
      countdownSeconds,
      playerName,
      mode,
      targetRank,
    } = body;
    const cleanName =
      typeof playerName === "string" ? playerName.trim() : "";
    const cleanMode =
      mode === "solo" || mode === "multi" || mode === "compete"
        ? mode
        : undefined;
    const opts = {
      timerMode:
        timerMode === "down" || timerMode === "none" ? timerMode : "up",
      countdownSeconds: Number.isFinite(countdownSeconds)
        ? Math.max(0, Math.floor(countdownSeconds))
        : 0,
      ...(cleanName ? { playerName: cleanName } : {}),
      ...(cleanMode ? { mode: cleanMode } : {}),
      ...(Number.isInteger(targetRank) ? { targetRank } : {}),
    };

    let session;
    if (letters !== undefined || center !== undefined) {
      session = await createCustomSession({ letters, center, ...opts });
      if (session.error) return c.json({ error: session.error }, 400);
    } else {
      session = await createRandomSession(opts);
      if (session.error) return c.json({ error: session.error }, 400);
    }

    const group = getGroup(session);
    const hostId = group ? group.hostId : null;
    const view = clientView(session, hostId);
    if (group) view.playerId = hostId;
    return c.json(view);
  });

  // GET /api/games/:id — current state. Auto-end check runs inside
  // getSession. If the URL is a group with no session yet (assembling /
  // configuring), fall back to the group view. Optional ?playerId= so
  // compete viewers get their own per-player slice.
  app.get("/api/games/:id", (c) => {
    const id = c.req.param("id");
    const playerId = c.req.query("playerId") || null;
    const session = getSession(id);
    if (session) return c.json(clientView(session, playerId));
    const group = getGroupForId(id);
    if (!group) return c.json({ error: "Game not found" }, 404);
    return c.json(groupView(group, playerId));
  });

  // POST /api/groups — create an empty multiplayer group (no session
  // yet). Used by the "Play with friends" flow, where players assemble
  // before anyone configures the first game.
  app.post("/api/groups", async (c) => {
    const body = await safeJson(c);
    const group = await createEmptyGroup(body.playerName);
    if (group.error) return c.json({ error: group.error }, 400);
    const view = groupView(group, group.hostId);
    view.playerId = group.hostId;
    return c.json(view);
  });

  // Configure state machine: claim, cancel, commit. Anyone in the group
  // can claim (no host gate) — first to click owns the form. Owner is
  // the only one who can cancel or commit.
  app.post("/api/games/:id/configure", async (c) => {
    const id = c.req.param("id");
    const group = getGroupForId(id);
    if (!group) return c.json({ error: "Game not found" }, 404);
    const body = await safeJson(c);
    const result = startConfiguring(group, body.playerId);
    if (result.error) {
      const status = result.error === "Not in this group" ? 403 : 409;
      return c.json({ error: result.error }, status);
    }
    return c.json(groupView(group, body.playerId));
  });

  app.post("/api/games/:id/configure/cancel", async (c) => {
    const id = c.req.param("id");
    const group = getGroupForId(id);
    if (!group) return c.json({ error: "Game not found" }, 404);
    const body = await safeJson(c);
    const result = cancelConfiguring(group, body.playerId);
    if (result.error) return c.json({ error: result.error }, 403);
    const session = group.currentSessionId ? getSession(id) : null;
    return c.json(
      session
        ? clientView(session, body.playerId)
        : groupView(group, body.playerId),
    );
  });

  app.post("/api/games/:id/configure/commit", async (c) => {
    const id = c.req.param("id");
    const group = getGroupForId(id);
    if (!group) return c.json({ error: "Game not found" }, 404);
    const body = await safeJson(c);
    const { playerId, ...opts } = body;
    const result = await commitConfiguration(group, playerId, opts);
    if (result.error) {
      const status =
        result.error === "Not the configurator" ||
        result.error === "Not in this group"
          ? 403
          : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json(clientView(result, playerId));
  });

  // GET /api/define/:word — dictionary lookup for the word-list popover.
  // Returns { word, def } on hit, 404 otherwise. The DB stores words in
  // uppercase, but lookupDefinition normalizes case.
  app.get("/api/define/:word", (c) => {
    const word = c.req.param("word");
    const def = lookupDefinition(word);
    if (!def) return c.json({ error: "No definition available" }, 404);
    return c.json({ word: word.toLowerCase(), def });
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

    if (isMultiplayer(session)) {
      if (session.state !== "active") {
        return c.json({ error: "Game is not active" }, 409);
      }
      if (!getMember(session, playerId)) {
        return c.json({ error: "Not in this game" }, 403);
      }
    }

    return c.json(submitWord(session, word, playerId || null));
  });

  // POST /api/games/:id/pause — body { playerId } in multiplayer
  app.post("/api/games/:id/pause", async (c) => {
    const r = withSession(c);
    if (r.error) return r.error;
    const body = await safeJson(c);
    if (isMultiplayer(r.session) && !getMember(r.session, body.playerId)) {
      return c.json({ error: "Not in this game" }, 403);
    }
    pauseSession(r.session);
    return c.json(clientView(r.session, body.playerId || null));
  });

  // POST /api/games/:id/resume
  app.post("/api/games/:id/resume", async (c) => {
    const r = withSession(c);
    if (r.error) return r.error;
    const body = await safeJson(c);
    if (isMultiplayer(r.session) && !getMember(r.session, body.playerId)) {
      return c.json({ error: "Not in this game" }, 403);
    }
    resumeSession(r.session);
    return c.json(clientView(r.session, body.playerId || null));
  });

  // POST /api/games/:id/end
  app.post("/api/games/:id/end", async (c) => {
    const r = withSession(c);
    if (r.error) return r.error;
    const body = await safeJson(c);
    if (isMultiplayer(r.session) && !getMember(r.session, body.playerId)) {
      return c.json({ error: "Not in this game" }, 403);
    }
    endSession(r.session);
    return c.json(clientView(r.session, body.playerId || null));
  });

  // POST /api/games/:id/join — multiplayer only, body { playerName }
  app.post("/api/games/:id/join", async (c) => {
    const id = c.req.param("id");
    const group = getGroupForId(id);
    if (!group) return c.json({ error: "Game not found" }, 404);
    const body = await safeJson(c);
    const result = addPlayer(group, body.playerName);
    if (result.error) return c.json({ error: result.error }, 400);
    // Render whichever view applies: if the group has a session
    // (legacy lobby flow), the session view; else the group view.
    const session = group.currentSessionId
      ? getSession(group.id)
      : null;
    const view = session
      ? clientView(session, result.player.playerId)
      : groupView(group, result.player.playerId);
    view.playerId = result.player.playerId;
    return c.json(view);
  });

  // POST /api/games/:id/leave — body { playerId }. Removes the caller
  // from the group's roster. Server reassigns the host if needed and
  // tears the group down when the last player leaves.
  app.post("/api/games/:id/leave", async (c) => {
    const id = c.req.param("id");
    const group = getGroupForId(id);
    if (!group) return c.json({ error: "Game not found" }, 404);
    const body = await safeJson(c);
    const result = removePlayer(group, body.playerId);
    if (result.error) return c.json({ error: result.error }, 403);
    return c.json({ ok: true });
  });

  // POST /api/games/:id/start — multiplayer only, host only, body { playerId }
  app.post("/api/games/:id/start", async (c) => {
    const r = withSession(c);
    if (r.error) return r.error;
    const session = r.session;
    if (!isMultiplayer(session)) {
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
    return c.json(clientView(session, body.playerId));
  });

  // POST /api/games/:id/chat — multi only, body { playerId, text }.
  // Works whether or not the group has a session right now.
  app.post("/api/games/:id/chat", async (c) => {
    const id = c.req.param("id");
    const group = getGroupForId(id);
    if (!group) return c.json({ error: "Game not found" }, 404);
    const body = await safeJson(c);
    if (!group.players.some((p) => p.playerId === body.playerId)) {
      return c.json({ error: "Not in this group" }, 403);
    }
    const result = addChatMessage(group, body.playerId, body.text);
    if (result.error) return c.json({ error: result.error }, 400);
    const session = group.currentSessionId ? getSession(id) : null;
    return c.json(
      session
        ? clientView(session, body.playerId)
        : groupView(group, body.playerId),
    );
  });

  // POST /api/games/:id/new-board — multiplayer only, body { playerId }
  app.post("/api/games/:id/new-board", async (c) => {
    const r = withSession(c);
    if (r.error) return r.error;
    const session = r.session;
    if (!isMultiplayer(session)) {
      return c.json({ error: "Not a multiplayer game" }, 400);
    }
    const body = await safeJson(c);
    if (!getMember(session, body.playerId)) {
      return c.json({ error: "Not in this game" }, 403);
    }
    const next = await newBoardFromSession(session);
    if (next.error) return c.json({ error: next.error }, 400);
    return c.json(clientView(next, body.playerId));
  });
}
