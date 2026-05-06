import {
  getSession,
  getMember,
  clientView,
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

      const teardown = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        if (presenceCounted) {
          presenceCounted = false;
          const s = getSession(gameId);
          if (s) presenceDisconnect(s, playerId);
        }
      };

      return {
        onOpen(_evt, ws) {
          const session = getSession(gameId);
          if (!session) {
            ws.close(4404, "Game not found");
            return;
          }

          // Count presence first so the initial view already reflects it.
          if (getMember(session, playerId)) {
            presenceConnect(session, playerId);
            presenceCounted = true;
          }

          sendJson(ws, {
            type: "state",
            view: clientView(session, playerId),
          });

          unsubscribe = subscribeToSession(
            gameId,
            (view) => {
              sendJson(ws, { type: "state", view });
            },
            playerId,
          );

          heartbeat = setInterval(() => {
            const s = getSession(gameId);
            if (!s) {
              try {
                ws.close();
              } catch {
                // already closed
              }
              return;
            }
            sendJson(ws, {
              type: "heartbeat",
              view: clientView(s, playerId),
            });
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
