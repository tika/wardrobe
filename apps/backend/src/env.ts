import type { D1Database, R2Bucket, Workflow } from "@cloudflare/workers-types";
import type { StageName } from "@wardrobe/core";

export type GeneratedStage = Exclude<StageName, "crop">;
export type GenerateParams = { jobId: string; stage: GeneratedStage };

/** Worker bindings, provisioned by Alchemy (see alchemy.run.ts). */
export type Bindings = {
  /** Every image: job working files, library cutouts and modeled photos, the model reference. */
  BUCKET: R2Bucket;
  /** Wardrobe items and import jobs (schema in src/db/schema.ts). */
  DB: D1Database;
  /** Durable image generation for one job stage (src/workflows/generate.ts). */
  GENERATE: Workflow<GenerateParams>;
  GEMINI_API_KEY: string;
  GEMINI_IMAGE_MODEL: string;
  GEMINI_VISION_MODEL: string;
  /** Only under `alchemy dev`: the simulated Access login from `dev.access` in alchemy.run.ts. */
  ALCHEMY_DEV_ACCESS?: unknown;
};

export type AppEnv = { Bindings: Bindings };
