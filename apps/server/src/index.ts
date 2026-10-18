import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { dataDir, REPO_ROOT, setting } from "./config";
import { createWardrobeApi } from "./routes";

const port = Number(setting("PORT", "4747"));
const host = setting("HOST", "0.0.0.0");
const webDist = path.join(REPO_ROOT, "apps/web/dist");
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

const api = createWardrobeApi({ dataDir: dataDir() });
await api.start();

/** Serves the built web app (npm run build) so one process hosts both the site and the API. */
async function serveWeb(pathname: string, res: ServerResponse) {
  const indexFile = path.join(webDist, "index.html");
  const requested = path.join(webDist, path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, ""));
  const isFile = async (file: string) => (await stat(file).catch(() => null))?.isFile() ?? false;
  const file = requested.startsWith(webDist) && await isFile(requested) ? requested : indexFile;
  if (!(await isFile(file))) {
    res.statusCode = 404;
    res.end("The web app has not been built. Run `npm run build`, or use `npm run dev` for development.");
    return;
  }
  res.setHeader("Content-Type", STATIC_TYPES[path.extname(file)] || "application/octet-stream");
  res.setHeader("Cache-Control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  if (await api.handle(req, res)) return;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.end();
    return;
  }
  await serveWeb(new URL(req.url || "/", "http://localhost").pathname, res);
});

server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(error.code === "EADDRINUSE" ? `[wardrobe] Port ${port} is already in use. Set PORT in .env to another port.` : error);
  process.exit(1);
});

server.listen(port, host, () => {
  const lan = Object.values(networkInterfaces()).flat().find((address) => address?.family === "IPv4" && !address.internal)?.address;
  console.log(`[wardrobe] API listening on http://localhost:${port}${lan ? ` (LAN: http://${lan}:${port})` : ""}`);
});
