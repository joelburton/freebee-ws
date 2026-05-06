import {
  getSession,
  getGroup,
  getGroupForId,
  clientView,
  groupView,
  subscribeToSession,
  presenceConnect,
  presenceDisconnect,
} from "./sessions.js";

const HEARTBEAT_MS = 5000;

// Wire WS broadcast for game state. Client opens
// ws://.../ws/:gameId?playerId=<id> (playerId optional / observer-only).
// Messages from server are JSON: { type: "state" | "heartbeat", view }.
// Closure codes: 4404 = unknown game.
export function registerWebSocket(app, upgradeWebSocket) {
  app.get(
    "/ws/:gameId",
    upgradeWebSocket((c) => {
      const gameId = c.req.param("gameId");
      const playerId = c.req.query("playerId") || null;

      // State held across the socket lifecycle.
      let unsubscribe = () => {};
      let heartbeat = null;
      let presenceCounted = false;
      let closed = false;

      const sendJson = (ws, payload) => {
        if (closed) return;
        try {
          ws.send(JSON.stringify(payload));
        } catch {
          // Socket already closed; let onClose handle teardown.
        }
      };

      // Resolve the URL id to (session?, group?). Empty groups (no
      // session yet) still subscribe — chat and configure flow over WS
      // before any board exists.
      const resolve = () => {
        const session = getSession(gameId);
        const group = session ? getGroup(session) : getGroupForId(gameId);
        return { session, group };
      };

      const renderView = ({ session, group }) =>
        session
          ? clientView(session, playerId)
          : group
            ? groupView(group, playerId)
            : null;

      const teardown = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        if (presenceCounted) {
          presenceCounted = false;
          const { group } = resolve();
          if (group) presenceDisconnect(group, playerId);
        }
      };

      return {
        onOpen(_evt, ws) {
          const r = resolve();
          if (!r.session && !r.group) {
            ws.close(4404, "Game not found");
            return;
          }

          if (
            playerId &&
            r.group &&
            r.group.players.some((p) => p.playerId === playerId)
          ) {
            presenceConnect(r.group, playerId);
            presenceCounted = true;
          }

          const initial = renderView(resolve());
          if (initial) sendJson(ws, { type: "state", view: initial });

          unsubscribe = subscribeToSession(
            gameId,
            (view) => {
              sendJson(ws, { type: "state", view });
            },
            playerId,
          );

          heartbeat = setInterval(() => {
            const r2 = resolve();
            if (!r2.session && !r2.group) {
              try {
                ws.close();
              } catch {
                // already closed
              }
              return;
            }
            const view = renderView(r2);
            if (view) sendJson(ws, { type: "heartbeat", view });
          }, HEARTBEAT_MS);
        },
        onClose() {
          teardown();
        },
        onError() {
          teardown();
        },
      };
    }),
  );
}
