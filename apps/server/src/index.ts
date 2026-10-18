import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app";
import { dataDir, REPO_ROOT, setting } from "./config";

const webDist = path.join(REPO_ROOT, "apps/web/dist");
const { app, start } = createApp(dataDir());

// Serve the built web app (npm run build) so one process hosts both the site and the API.
app.use("*", serveStatic({ root: webDist }));
app.get("*", serveStatic({ root: webDist, path: "index.html" }));

await start();
serve({ fetch: app.fetch, port: Number(setting("PORT", "4747")), hostname: setting("HOST", "0.0.0.0") }, ({ port }) => {
  console.log(`[wardrobe] listening on http://localhost:${port}`);
});
