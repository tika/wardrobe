/**
 * Bun can't load the Workers runtime modules; stand in for the two classes
 * the code imports so modules (and the workflow) load under `bun test`.
 */
import { mock } from "bun:test";

class WorkflowEntrypoint<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

class NonRetryableError extends Error {
  override name = "NonRetryableError";
}

mock.module("cloudflare:workers", () => ({ WorkflowEntrypoint }));
mock.module("cloudflare:workflows", () => ({ NonRetryableError }));
