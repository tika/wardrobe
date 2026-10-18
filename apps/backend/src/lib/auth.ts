import type { CloudflareAccessContext } from "@cloudflare/workers-types";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { ApiError } from "./http";

/**
 * Cloudflare Access gates every URL of this Worker at the edge (see alchemy.run.ts) and,
 * for requests it let through, the runtime sets `ctx.access`. Refusing requests without it
 * keeps the API closed even if the Worker were ever exposed without the Access application.
 * `alchemy dev` has no edge; it binds the simulated login as ALCHEMY_DEV_ACCESS instead.
 */
export const requireAccess = createMiddleware<AppEnv>(async (c, next) => {
  const { access } = c.executionCtx as unknown as { access?: CloudflareAccessContext };
  if (!access && !c.env.ALCHEMY_DEV_ACCESS) throw new ApiError(401, "unauthorized", "Sign in through Cloudflare Access");
  await next();
});
