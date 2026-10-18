import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { API_PATHS, type ImportJob, type SetupStatus, type Stage, type StageName, type WardrobeItem } from "@wardrobe/core";
import { HTTPException } from "hono/http-exception";
import { modelReferencePath, modelReferenceSetting } from "./config";
import { chooseChromaKey, cropDetectedItem, normalizeImage, processChromaBackground, removeChromaBackground } from "./images";
import { loadLibrary, readJson, saveLibrary, writeJson } from "./library";
import { apiKeyName, detectClothing, generateImage, hasApiKey, type ImageFormat } from "./gemini";
import { buildGarmentPrompt, MODELED_PROMPT, withDirection } from "./prompts";
import { metadataSchema } from "./schemas";

type GeneratedStage = Exclude<StageName, "crop">;

const FORMATS: Record<GeneratedStage, ImageFormat> = {
  garment: { aspectRatio: "1:1", imageSize: "1K" },
  modeled: { aspectRatio: "3:2", imageSize: "2K" },
};

/** Job record on disk: the public ImportJob plus server-only file bookkeeping. */
interface StoredJob extends ImportJob {
  internal: { originalFile: string; cropFile: string };
}

function stageState(): Stage {
  return { status: "pending", decision: null, attempts: 0, assetUrl: null, failedAssetUrl: null, cleanupPreviewUrl: null, cleanupTolerance: 46, cleanupDiagnostics: null, error: null, prompt: null, updatedAt: null };
}

function publicJob({ internal: _internal, ...job }: StoredJob): ImportJob {
  return job;
}

const now = () => new Date().toISOString();
const isRejected = (job: ImportJob) => job.stages.crop.status === "rejected" || job.stages.garment.status === "rejected" || job.stages.modeled.status === "rejected";
const assetName = (url: string) => path.basename(new URL(url, "http://localhost").pathname);
/** File name of a stage's current image inside its job folder. */
const stageFile = (job: ImportJob, stageName: StageName) => {
  const stage = job.stages[stageName];
  return stage.assetUrl ? assetName(stage.assetUrl) : `${stageName}-${stage.attempts}.png`;
};

/**
 * The import pipeline: crop → garment cutout → modeled photo, each reviewed by the user.
 * Jobs live as folders under data/jobs so work survives restarts.
 */
export function createJobStore(dataDir: string) {
  const jobsDir = path.join(dataDir, "jobs");
  const libraryAssetDir = path.join(dataDir, "imported");
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(libraryAssetDir, { recursive: true });
  const running = new Map<string, Promise<void>>();
  const jobFile = (id: string) => path.join(jobsDir, id, "job.json");
  const removeJobDir = (id: string) => rm(path.join(jobsDir, id), { recursive: true, force: true });

  async function setupStatus(): Promise<SetupStatus> {
    const hasModelReference = (await stat(modelReferencePath()).catch(() => null))?.isFile() ?? false;
    const apiKey = hasApiKey();
    return { ready: apiKey && hasModelReference, hasApiKey: apiKey, hasModelReference, modelReference: modelReferenceSetting() };
  }

  const load = (id: string) => readJson<StoredJob | null>(jobFile(id), null);

  async function get(id: string): Promise<StoredJob> {
    const job = await load(id);
    if (!job) throw new HTTPException(404, { message: "Job not found" });
    return job;
  }

  async function save(job: StoredJob) {
    job.updatedAt = now();
    await writeJson(jobFile(job.id), job);
  }

  async function persistImported(job: StoredJob, includeModeled: boolean): Promise<WardrobeItem> {
    const id = `import-${job.id}`;
    const garmentName = `${id}-garment.png`;
    await copyFile(path.join(jobsDir, job.id, stageFile(job, "garment")), path.join(libraryAssetDir, garmentName));
    let modeledImage: string | null = null;
    if (includeModeled) {
      const modeledName = `${id}-modeled.png`;
      await copyFile(path.join(jobsDir, job.id, stageFile(job, "modeled")), path.join(libraryAssetDir, modeledName));
      modeledImage = `${API_PATHS.library}/${modeledName}`;
    }
    const { metadata } = job;
    const records = await loadLibrary(dataDir);
    const existing = records.find((record) => record.id === id);
    const record: WardrobeItem = {
      id,
      name: metadata.name,
      part: metadata.part,
      color: metadata.color,
      secondaryColor: metadata.secondaryColor,
      palette: [metadata.color, metadata.secondaryColor].filter((color): color is string => Boolean(color)),
      tags: metadata.tags,
      image: `${API_PATHS.library}/${garmentName}`,
      thumbnail: `${API_PATHS.library}/${garmentName}`,
      modeledImage: modeledImage || existing?.modeledImage || null,
      importJobId: job.id,
    };
    await saveLibrary(dataDir, [...records.filter((item) => item.id !== id), record]);
    return record;
  }

  async function runGeneration(jobId: string, stageName: GeneratedStage) {
    const job = await get(jobId);
    const stage = job.stages[stageName];
    Object.assign(stage, { status: "processing", decision: null, error: null, attempts: stage.attempts + 1, updatedAt: now() });
    await save(job);
    const dir = path.join(jobsDir, job.id);
    let failedAssetUrl: string | null = null;
    let chromaKey: string | null = null;
    let result: Partial<Stage>;
    try {
      let bytes: Buffer;
      if (stageName === "garment") {
        chromaKey = chooseChromaKey(job.metadata.color);
        const source = await readFile(path.join(dir, job.internal.cropFile));
        bytes = await generateImage({ ...FORMATS.garment, prompt: withDirection(buildGarmentPrompt(job.metadata, chromaKey), stage.prompt), images: [source] });
        const rawName = `garment-${stage.attempts}-source.png`;
        await writeFile(path.join(dir, rawName), bytes);
        failedAssetUrl = `${API_PATHS.assets}/${job.id}/${rawName}`;
        bytes = await removeChromaBackground(bytes, chromaKey);
      } else {
        const model = await readFile(modelReferencePath()).catch(() => {
          throw new Error(`Model reference not found at ${modelReferencePath()}. Set WARDROBE_MODEL_REFERENCE or add data/model-reference.png.`);
        });
        const garment = await readFile(path.join(dir, stageFile(job, "garment")));
        bytes = await generateImage({ ...FORMATS.modeled, prompt: withDirection(MODELED_PROMPT, stage.prompt), images: [model, garment] });
      }
      const outputName = `${stageName}-${stage.attempts}.png`;
      await writeFile(path.join(dir, outputName), bytes);
      result = { status: "review", assetUrl: `${API_PATHS.assets}/${job.id}/${outputName}`, failedAssetUrl: null, cleanupPreviewUrl: null, cleanupDiagnostics: null };
    } catch (error) {
      result = { status: "failed", error: error instanceof Error ? error.message : String(error), ...(failedAssetUrl && { failedAssetUrl }) };
    }
    const fresh = await get(jobId);
    Object.assign(fresh.stages[stageName], result, { updatedAt: now() }, chromaKey && { chromaKey });
    await save(fresh);
  }

  /** Starts image generation in the background; concurrent calls for the same stage share one run. */
  function generate(jobId: string, stageName: GeneratedStage): void {
    const lock = `${jobId}:${stageName}`;
    if (running.has(lock)) return;
    const task = runGeneration(jobId, stageName)
      .catch((error) => console.error(`[wardrobe] ${stageName} generation for ${jobId} failed:`, error))
      .finally(() => running.delete(lock));
    running.set(lock, task);
  }

  async function create(image: Buffer): Promise<ImportJob[]> {
    const setup = await setupStatus();
    if (!setup.ready) {
      const missing = [
        !setup.hasApiKey && `${apiKeyName} in .env`,
        !setup.hasModelReference && `a PNG photo of yourself at ${setup.modelReference}`,
      ].filter(Boolean).join(" and ");
      throw new HTTPException(503, { message: `Setup required: add ${missing}, then restart the app.` });
    }
    const original = await normalizeImage(image);
    const detected = (await detectClothing(original)).map((item) => metadataSchema.parse(item));
    const jobs: ImportJob[] = [];
    for (const metadata of detected) {
      const id = randomUUID();
      const internal = { originalFile: "original.png", cropFile: "crop.png" };
      await mkdir(path.join(jobsDir, id), { recursive: true });
      await writeFile(path.join(jobsDir, id, internal.originalFile), original);
      await writeFile(path.join(jobsDir, id, internal.cropFile), await cropDetectedItem(original, metadata.boundingBox));
      const job: StoredJob = {
        id,
        status: "active",
        metadata,
        stages: { crop: { ...stageState(), status: "review", assetUrl: `${API_PATHS.assets}/${id}/${internal.cropFile}`, updatedAt: now() }, garment: stageState(), modeled: stageState() },
        originalAssetUrl: `${API_PATHS.assets}/${id}/${internal.originalFile}`,
        createdAt: now(),
        updatedAt: now(),
        internal,
      };
      await save(job);
      jobs.push(publicJob(job));
    }
    return jobs;
  }

  /** Lists open jobs, clearing out finished or rejected ones. */
  async function list(): Promise<ImportJob[]> {
    const jobs = (await Promise.all((await readdir(jobsDir)).map(load))).filter((job): job is StoredJob => Boolean(job));
    const finished = jobs.filter((job) => job.status === "complete" || isRejected(job));
    await Promise.all(finished.map((job) => removeJobDir(job.id)));
    return jobs.filter((job) => !finished.includes(job)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(publicJob);
  }

  async function updateMetadata(id: string, patch: Record<string, unknown>): Promise<ImportJob> {
    const job = await get(id);
    job.metadata = metadataSchema.parse({ ...job.metadata, ...patch });
    await save(job);
    return publicJob(job);
  }

  async function regenerate(id: string, stageName: StageName, prompt: string | null): Promise<ImportJob> {
    if (stageName === "crop") throw new HTTPException(400, { message: "Upload the image again to create new crops" });
    const job = await get(id);
    Object.assign(job.stages[stageName], { prompt, status: "queued", decision: null });
    await save(job);
    generate(job.id, stageName);
    return publicJob(job);
  }

  async function decide(id: string, stageName: StageName, decision: "approve" | "reject"): Promise<ImportJob> {
    const job = await get(id);
    const stage = job.stages[stageName];
    if (stage.status !== "review") throw new HTTPException(409, { message: "Stage is not ready for review" });
    const approved = decision === "approve";
    const previous = { status: stage.status, decision: stage.decision, jobStatus: job.status };
    Object.assign(stage, { decision: approved ? "approved" : "rejected", status: approved ? "approved" : "rejected", error: null, updatedAt: now() });
    const next: GeneratedStage | null = !approved ? null
      : stageName === "crop" && job.stages.garment.status === "pending" ? "garment"
        : stageName === "garment" && job.stages.modeled.status === "pending" ? "modeled"
          : null;
    if (approved && stageName === "modeled") job.status = "complete";
    await save(job);
    if (approved && stageName !== "crop") {
      try {
        await persistImported(job, stageName === "modeled");
      } catch (error) {
        Object.assign(stage, { status: previous.status, decision: previous.decision });
        job.status = previous.jobStatus;
        await save(job);
        throw error;
      }
    }
    if (!approved || job.status === "complete") await removeJobDir(job.id);
    if (next) generate(job.id, next);
    return publicJob(job);
  }

  /** Re-runs background removal on a failed garment's raw image, locally, without calling the image model. */
  async function cleanup(id: string, tolerance: number, accept: boolean): Promise<ImportJob> {
    const job = await get(id);
    const stage = job.stages.garment;
    if (stage.status !== "failed" || !stage.failedAssetUrl) throw new HTTPException(409, { message: "No failed garment source is available for cleanup" });
    const source = await readFile(path.join(jobsDir, job.id, assetName(stage.failedAssetUrl)));
    const key = stage.chromaKey || chooseChromaKey(job.metadata.color);
    const cleaned = await processChromaBackground(source, key, tolerance);
    const previewName = `garment-${stage.attempts}-cleanup-${tolerance}.png`;
    const previewUrl = `${API_PATHS.assets}/${job.id}/${previewName}`;
    await writeFile(path.join(jobsDir, job.id, previewName), cleaned.bytes);
    Object.assign(stage, { chromaKey: key, cleanupTolerance: cleaned.tolerance, cleanupDiagnostics: cleaned.verification, cleanupPreviewUrl: previewUrl, updatedAt: now() });
    if (accept) Object.assign(stage, { status: "review", decision: null, error: null, assetUrl: previewUrl });
    await save(job);
    return publicJob(job);
  }

  /** Resumes work that a restart interrupted. */
  async function start() {
    for (const id of await readdir(jobsDir)) {
      const job = await load(id);
      if (!job) continue;
      if (job.status === "complete") {
        try {
          await persistImported(job, true);
          await removeJobDir(job.id);
        } catch {
          job.status = "active";
          Object.assign(job.stages.modeled, { status: "review", decision: null, error: null });
          await save(job);
        }
      } else if (isRejected(job)) {
        await removeJobDir(job.id);
      } else if (job.stages.crop.status !== "approved") {
        continue;
      } else if (["processing", "queued"].includes(job.stages.garment.status)) {
        job.stages.garment.status = "pending";
        await save(job);
        generate(job.id, "garment");
      } else if (job.stages.garment.status === "approved" && ["pending", "processing", "queued"].includes(job.stages.modeled.status)) {
        job.stages.modeled.status = "pending";
        await save(job);
        generate(job.id, "modeled");
      }
    }
  }

  return { setupStatus, list, get: async (id: string) => publicJob(await get(id)), create, remove: removeJobDir, updateMetadata, regenerate, decide, cleanup, start, jobsDir, libraryAssetDir };
}
