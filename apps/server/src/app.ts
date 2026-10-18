import { rm } from "node:fs/promises";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createJobStore } from "./jobs";
import { loadLibrary, saveLibrary } from "./library";
import { cleanupSchema, createJobSchema, itemEditSchema, metadataPatchSchema, regenerateSchema } from "./schemas";

const JOB = ":id{[0-9a-f-]{36}}";
const ITEM = ":id{import-[0-9a-f-]{36}}";

/** Parses the JSON body with a schema; a ZodError becomes a 400 in onError. */
async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  const value = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: "Expected a JSON request body" });
  });
  return schema.parse(value);
}

function decodeImage(dataUrl: string): Buffer {
  const image = Buffer.from(dataUrl.replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!image.length) throw new HTTPException(400, { message: "Image payload is empty" });
  return image;
}

export function createApp(dataDir: string) {
  const jobs = createJobStore(dataDir);

  const api = new Hono()
    .get("/config", async (c) => c.json(await jobs.setupStatus()))

    .get("/wardrobe", async (c) => c.json(await loadLibrary(dataDir)))
    .patch(`/wardrobe/${ITEM}`, async (c) => {
      const id = c.req.param("id");
      const records = await loadLibrary(dataDir);
      const item = records.find((record) => record.id === id);
      if (!item) throw new HTTPException(404, { message: "Wardrobe item not found" });
      Object.assign(item, await body(c, itemEditSchema));
      item.palette = [...new Set([item.color, item.secondaryColor, ...item.palette].filter((color): color is string => Boolean(color)))].slice(0, 5);
      await saveLibrary(dataDir, records);
      return c.json(item);
    })
    .delete(`/wardrobe/${ITEM}`, async (c) => {
      const id = c.req.param("id");
      const records = await loadLibrary(dataDir);
      if (!records.some((record) => record.id === id)) throw new HTTPException(404, { message: "Wardrobe item not found" });
      await saveLibrary(dataDir, records.filter((record) => record.id !== id));
      await Promise.all(["garment", "modeled"].map((kind) => rm(path.join(jobs.libraryAssetDir, `${id}-${kind}.png`), { force: true })));
      return c.json({ deleted: true, id });
    })

    .get("/library/*", serveStatic({
      root: jobs.libraryAssetDir,
      rewriteRequestPath: (requestPath) => requestPath.replace(/^.*\/library\//, ""),
      onFound: (_path, c) => { c.header("Cache-Control", "public, max-age=31536000, immutable"); },
    }))
    .get("/assets/*", serveStatic({
      root: jobs.jobsDir,
      rewriteRequestPath: (requestPath) => requestPath.replace(/^.*\/assets\//, ""),
      onFound: (_path, c) => { c.header("Cache-Control", "no-store"); },
    }))

    .get("/jobs", async (c) => c.json(await jobs.list()))
    .post("/jobs", bodyLimit({ maxSize: 25 * 1024 * 1024 }), async (c) => {
      const created = await jobs.create(decodeImage((await body(c, createJobSchema)).imageDataUrl));
      return c.json({ jobs: created, noClothingDetected: created.length === 0 }, 202);
    })
    .get(`/jobs/${JOB}`, async (c) => c.json(await jobs.get(c.req.param("id"))))
    .delete(`/jobs/${JOB}`, async (c) => {
      await jobs.remove(c.req.param("id"));
      return c.json({ deleted: true, id: c.req.param("id") });
    })
    .on(["PATCH", "PUT"], `/jobs/${JOB}/metadata`, async (c) => (
      c.json(await jobs.updateMetadata(c.req.param("id"), (await body(c, metadataPatchSchema)).metadata))
    ))
    .post(`/jobs/${JOB}/stages/:stage{crop|garment|modeled}/regenerate`, async (c) => {
      const stage = c.req.param("stage") as "crop" | "garment" | "modeled";
      return c.json(await jobs.regenerate(c.req.param("id"), stage, (await body(c, regenerateSchema)).prompt ?? null), 202);
    })
    .post(`/jobs/${JOB}/stages/:stage{crop|garment|modeled}/:decision{approve|reject}`, async (c) => {
      const stage = c.req.param("stage") as "crop" | "garment" | "modeled";
      return c.json(await jobs.decide(c.req.param("id"), stage, c.req.param("decision") as "approve" | "reject"));
    })
    .post(`/jobs/${JOB}/stages/garment/cleanup-:action{preview|accept}`, async (c) => (
      c.json(await jobs.cleanup(c.req.param("id"), (await body(c, cleanupSchema)).tolerance, c.req.param("action") === "accept"))
    ))
    .all("*", (c) => c.json({ error: "Not found" }, 404));

  const app = new Hono()
    .route("/api/import", api)
    .onError((error, c) => {
      if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
      if (error instanceof z.ZodError) return c.json({ error: z.prettifyError(error) }, 400);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.json({ error: "Not found" }, 404);
      console.error("[wardrobe]", error);
      return c.json({ error: "Internal server error" }, 500);
    });

  return { app, start: jobs.start };
}
