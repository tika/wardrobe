import type { ExportedHandler } from "@cloudflare/workers-types";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "./env";
import { requireAccess } from "./lib/auth";
import { onError, onNotFound } from "./lib/http";
import { routes } from "./routes";

export { GenerateStage } from "./workflows/generate";

// Static web files are served by Workers assets before the Worker runs; only /api/* reaches Hono.
const app = new Hono<AppEnv>()
  .use("/api/*", requireAccess)
  .route("/api/import", routes);
app.onError(onError);
app.notFound(onNotFound);

export default {
  fetch: (request, env, ctx) => app.fetch(request as unknown as Request, env, ctx),
} satisfies ExportedHandler<Bindings>;
