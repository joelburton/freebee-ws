import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { registerApiRoutes } from "./routes.js";
import { registerWebSocket } from "./ws.js";

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

registerApiRoutes(app);
registerWebSocket(app, upgradeWebSocket);

// Production: serve the Vite build. In dev, Vite proxies API + WS here so
// this server never has to serve HTML.
if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("/*", serveStatic({ path: "./dist/index.html" }));
}

const port = Number(process.env.PORT) || 3001;
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
});
injectWebSocket(server);
