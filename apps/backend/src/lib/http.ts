import { zValidator } from "@hono/zod-validator";
import type { ErrorHandler, NotFoundHandler, ValidationTargets } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { GeminiError } from "../gemini";

export type ErrorCode = "bad_request" | "unauthorized" | "not_found" | "conflict" | "payload_too_large" | "upstream" | "setup_required" | "internal";

/** Every error response has this shape: `{ error: { code, message, issues? } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 503,
    readonly code: ErrorCode,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);

/** `zValidator` with errors in the API's error shape instead of raw ZodError JSON. */
export const validate = <Target extends keyof ValidationTargets, Schema extends z.ZodType>(target: Target, schema: Schema) =>
  zValidator(target, schema, (result) => {
    if (!result.success) throw new ApiError(400, "bad_request", `Invalid ${target}`, result.error.issues);
  });

export const onError: ErrorHandler = (error, c) => {
  if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message, issues: error.issues } }, error.status);
  if (error instanceof GeminiError) return c.json({ error: { code: "upstream", message: error.message } }, 502);
  if (error instanceof HTTPException) return c.json({ error: { code: "bad_request", message: error.message } }, error.status);
  console.error("[wardrobe]", error);
  return c.json({ error: { code: "internal", message: "Internal server error" } }, 500);
};

export const onNotFound: NotFoundHandler = (c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404);
