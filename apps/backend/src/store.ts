import type { R2Bucket } from "@cloudflare/workers-types";
import { API_PATHS, type ImportJob, type ItemEdit, type WardrobeItem } from "@wardrobe/core";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import type { Bindings } from "./env";

/** R2 keys for every stored image. */
export const keys = {
  job: (jobId: string, name: string) => `jobs/${jobId}/${name}`,
  library: (name: string) => `library/${name}`,
  garment: (itemId: string) => `library/${itemId}-garment.png`,
  modeled: (itemId: string) => `library/${itemId}-modeled.png`,
  modelReference: "settings/model-reference.png",
};

/** URL paths clients load images from; the API serves them out of R2. */
export const urls = {
  job: (jobId: string, name: string) => `${API_PATHS.assets}/${jobId}/${name}`,
  garment: (itemId: string) => `${API_PATHS.library}/${itemId}-garment.png`,
  modeled: (itemId: string) => `${API_PATHS.library}/${itemId}-modeled.png`,
};

/** File name at the end of an asset URL path, e.g. "crop.png". */
export const fileName = (url: string) => url.slice(url.lastIndexOf("/") + 1);

type ItemRow = typeof schema.items.$inferSelect;
type JobRow = typeof schema.jobs.$inferSelect;

const toJob = (row: JobRow): ImportJob => ({ ...row, originalAssetUrl: urls.job(row.id, "original.png") });

function toItem(row: ItemRow): WardrobeItem {
  return {
    id: row.id,
    name: row.name,
    part: row.part,
    color: row.color,
    secondaryColor: row.secondaryColor,
    palette: row.palette,
    tags: row.tags,
    image: urls.garment(row.id),
    thumbnail: urls.garment(row.id),
    modeledImage: row.hasModeled ? urls.modeled(row.id) : null,
    importJobId: row.importJobId,
  };
}

export function createStore(env: Pick<Bindings, "DB" | "BUCKET">) {
  const db = drizzle(env.DB);
  const bucket: R2Bucket = env.BUCKET;

  const items = {
    async list(): Promise<WardrobeItem[]> {
      return (await db.select().from(schema.items).orderBy(asc(schema.items.createdAt))).map(toItem);
    },
    async get(id: string): Promise<WardrobeItem | null> {
      const [row] = await db.select().from(schema.items).where(eq(schema.items.id, id));
      return row ? toItem(row) : null;
    },
    /** Creates or replaces an item; a later save without a modeled photo keeps the existing one. */
    async save(item: Omit<WardrobeItem, "image" | "thumbnail" | "modeledImage"> & { hasModeled: boolean }): Promise<WardrobeItem> {
      const { hasModeled, ...values } = item;
      const [row] = await db.insert(schema.items).values({ ...values, hasModeled })
        .onConflictDoUpdate({ target: schema.items.id, set: { ...values, ...(hasModeled && { hasModeled }) } })
        .returning();
      return toItem(row!);
    },
    async update(id: string, edit: Partial<ItemEdit>): Promise<WardrobeItem | null> {
      const current = await items.get(id);
      if (!current) return null;
      const next = { ...current, ...edit };
      const palette = [...new Set([next.color, next.secondaryColor, ...current.palette].filter((color): color is string => Boolean(color)))].slice(0, 5);
      const [row] = await db.update(schema.items).set({ ...edit, palette }).where(eq(schema.items.id, id)).returning();
      return row ? toItem(row) : null;
    },
    async remove(id: string): Promise<boolean> {
      const deleted = await db.delete(schema.items).where(eq(schema.items.id, id)).returning({ id: schema.items.id });
      if (deleted.length) await bucket.delete([keys.garment(id), keys.modeled(id)]);
      return deleted.length > 0;
    },
  };

  const jobs = {
    async list(): Promise<ImportJob[]> {
      return (await db.select().from(schema.jobs).orderBy(asc(schema.jobs.createdAt))).map(toJob);
    },
    async get(id: string): Promise<ImportJob | null> {
      const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
      return row ? toJob(row) : null;
    },
    async save(job: ImportJob): Promise<ImportJob> {
      const values = { id: job.id, status: job.status, metadata: job.metadata, stages: job.stages, createdAt: job.createdAt, updatedAt: new Date().toISOString() };
      await db.insert(schema.jobs).values(values).onConflictDoUpdate({ target: schema.jobs.id, set: values });
      return { ...job, updatedAt: values.updatedAt };
    },
    /** Deletes the job and every working file under jobs/{id}/. */
    async remove(id: string): Promise<void> {
      await db.delete(schema.jobs).where(eq(schema.jobs.id, id));
      const listing = await bucket.list({ prefix: keys.job(id, "") });
      if (listing.objects.length) await bucket.delete(listing.objects.map((object) => object.key));
    },
  };

  const files = {
    async get(key: string): Promise<Uint8Array | null> {
      const object = await bucket.get(key);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    async put(key: string, bytes: Uint8Array): Promise<void> {
      await bucket.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
    },
    async copy(from: string, to: string): Promise<void> {
      const bytes = await files.get(from);
      if (!bytes) throw new Error(`Missing file ${from}`);
      await files.put(to, bytes);
    },
    async exists(key: string): Promise<boolean> {
      return (await bucket.head(key)) !== null;
    },
    /** Streams a stored image back to the client. */
    async respond(key: string, cacheControl: string): Promise<Response | null> {
      const object = await bucket.get(key);
      if (!object) return null;
      return new Response(object.body as unknown as ReadableStream, {
        headers: { "Content-Type": object.httpMetadata?.contentType || "image/png", "Cache-Control": cacheControl, ETag: object.httpEtag },
      });
    },
  };

  return { items, jobs, files };
}

export type Store = ReturnType<typeof createStore>;
