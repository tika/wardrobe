import { Buffer } from "node:buffer";
import { PART_IDS, type Part, type StageName } from "@wardrobe/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv } from "./env";
import { ApiError, notFound, validate } from "./lib/http";
import { createPipeline } from "./pipeline";
import { cleanupSchema, imageUploadSchema, itemEditSchema, metadataPatchSchema, metadataSchema, regenerateSchema } from "./schemas";
import { keys } from "./store";

const JOB = ":id{[0-9a-f-]{36}}";
const ITEM = ":id{import-[0-9a-f-]{36}}";
const STAGE = ":stage{crop|garment|modeled}";
const IMMUTABLE = "private, max-age=31536000, immutable";

/** Phone photos sent as base64 data URLs can be large. */
const imageBodyLimit = bodyLimit({ maxSize: 25 * 1024 * 1024, onError: () => { throw new ApiError(413, "payload_too_large", "Image is too large"); } });

function decodeImage(dataUrl: string): Uint8Array {
  const image = Buffer.from(dataUrl.replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!image.length) throw new ApiError(400, "bad_request", "Image payload is empty");
  return new Uint8Array(image);
}

const importItemSchema = z.object({
  garment: z.string().min(1),
  modeled: z.string().min(1).optional(),
  metadata: metadataSchema.extend({ part: z.enum(PART_IDS as [Part, ...Part[]]) }),
});

export const routes = new Hono<AppEnv>()
  .get("/config", (c) => createPipeline(c.env).setupStatus().then((status) => c.json(status)))
  .get("/model-reference", async (c) => (await createPipeline(c.env).store.files.respond(keys.modelReference, "no-store")) ?? c.json({ error: { code: "not_found", message: "No reference photo yet" } }, 404))
  .put("/model-reference", imageBodyLimit, validate("json", imageUploadSchema), async (c) => (
    c.json(await createPipeline(c.env).setModelReference(decodeImage(c.req.valid("json").imageDataUrl)))
  ))

  .get("/wardrobe", async (c) => c.json(await createPipeline(c.env).store.items.list()))
  .post("/wardrobe", imageBodyLimit, validate("json", importItemSchema), async (c) => {
    const { garment, modeled, metadata } = c.req.valid("json");
    return c.json(await createPipeline(c.env).importItem({ garment: decodeImage(garment), modeled: modeled ? decodeImage(modeled) : undefined, metadata }), 201);
  })
  .patch(`/wardrobe/${ITEM}`, validate("json", itemEditSchema), async (c) => {
    const item = await createPipeline(c.env).store.items.update(c.req.param("id"), c.req.valid("json"));
    if (!item) throw notFound("Wardrobe item");
    return c.json(item);
  })
  .delete(`/wardrobe/${ITEM}`, async (c) => {
    if (!(await createPipeline(c.env).store.items.remove(c.req.param("id")))) throw notFound("Wardrobe item");
    return c.json({ deleted: true, id: c.req.param("id") });
  })
  .get("/library/:name{[\\w.-]+\\.png}", async (c) => (
    (await createPipeline(c.env).store.files.respond(keys.library(c.req.param("name")), IMMUTABLE)) ?? c.notFound()
  ))
  .get(`/assets/${JOB}/:name{[\\w.-]+\\.png}`, async (c) => (
    (await createPipeline(c.env).store.files.respond(keys.job(c.req.param("id"), c.req.param("name")), "no-store")) ?? c.notFound()
  ))

  .get("/jobs", async (c) => c.json(await createPipeline(c.env).list()))
  .post("/jobs", imageBodyLimit, validate("json", imageUploadSchema), async (c) => {
    const jobs = await createPipeline(c.env).create(decodeImage(c.req.valid("json").imageDataUrl));
    return c.json({ jobs, noClothingDetected: jobs.length === 0 }, 202);
  })
  .get(`/jobs/${JOB}`, async (c) => c.json(await createPipeline(c.env).get(c.req.param("id"))))
  .delete(`/jobs/${JOB}`, async (c) => {
    await createPipeline(c.env).remove(c.req.param("id"));
    return c.json({ deleted: true, id: c.req.param("id") });
  })
  .on(["PATCH", "PUT"], `/jobs/${JOB}/metadata`, validate("json", metadataPatchSchema), async (c) => (
    c.json(await createPipeline(c.env).updateMetadata(c.req.param("id"), c.req.valid("json").metadata))
  ))
  .post(`/jobs/${JOB}/stages/${STAGE}/regenerate`, validate("json", regenerateSchema), async (c) => (
    c.json(await createPipeline(c.env).regenerate(c.req.param("id"), c.req.param("stage") as StageName, c.req.valid("json").prompt ?? null), 202)
  ))
  .post(`/jobs/${JOB}/stages/${STAGE}/:decision{approve|reject}`, async (c) => (
    c.json(await createPipeline(c.env).decide(c.req.param("id"), c.req.param("stage") as StageName, c.req.param("decision") as "approve" | "reject"))
  ))
  .post(`/jobs/${JOB}/stages/garment/cleanup-:action{preview|accept}`, validate("json", cleanupSchema), async (c) => (
    c.json(await createPipeline(c.env).cleanup(c.req.param("id"), c.req.valid("json").tolerance, c.req.param("action") === "accept"))
  ));
