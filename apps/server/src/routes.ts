import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { API_PATHS, HEX_COLOR, isPart, type ImportJob, type ItemMetadata, type Stage, type StageName, type WardrobeItem } from "@wardrobe/core";
import { modelReferencePath, modelReferenceSetting } from "./config";
import { chooseChromaKey, cleanupTolerance, cropDetectedItem, normalizeBoundingBox, normalizeImage, processChromaBackground, removeChromaBackground } from "./images";
import { atomicJson, loadLibrary, normalizeEdit, saveLibrary } from "./library";
import { apiKeyName, detectClothing, generateImage, hasApiKey } from "./openai";
import { buildGarmentPrompt, MODELED_PROMPT, withDirection } from "./prompts";

const DECISIONS = new Set(["approve", "reject"]);

/** Job record on disk: the public ImportJob plus server-only file bookkeeping. */
interface StoredJob extends ImportJob {
  internal: { originalFile: string; cropFile: string; originalMime: string };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req: IncomingMessage, limit = 25 * 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "Expected a JSON request body"); }
}

function publicJob(job: StoredJob): ImportJob {
  const { internal: _internal, ...copy } = structuredClone(job);
  return copy;
}

function decodeImage(input: Record<string, unknown>) {
  const raw = input.imageDataUrl || input.imageBase64;
  if (!raw || typeof raw !== "string") throw new HttpError(400, "imageDataUrl or imageBase64 is required");
  const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
  const data = Buffer.from(match?.[2] || raw, "base64");
  if (!data.length) throw new HttpError(400, "Image payload is empty");
  return data;
}

export function normalizeMetadata(value: unknown = {}): ItemMetadata {
  const metadata = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const hex = (color: unknown) => typeof color === "string" && HEX_COLOR.test(color) ? color.toLowerCase() : null;
  return {
    name: typeof metadata.name === "string" ? metadata.name.trim().slice(0, 120) || "New piece" : "New piece",
    part: isPart(metadata.part) ? metadata.part : "upperbody",
    color: hex(metadata.color) || "#d8d0c2",
    secondaryColor: hex(metadata.secondaryColor),
    tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 12) : [],
    boundingBox: normalizeBoundingBox(metadata.boundingBox),
  };
}

function stageState(): Stage {
  return { status: "pending", decision: null, attempts: 0, assetUrl: null, failedAssetUrl: null, cleanupPreviewUrl: null, cleanupTolerance: 46, cleanupDiagnostics: null, error: null, prompt: null, updatedAt: null };
}

const isRejected = (job: ImportJob) => job.stages.crop?.status === "rejected" || job.stages.garment.status === "rejected" || job.stages.modeled.status === "rejected";
const assetName = (url: string) => path.basename(new URL(url, "http://localhost").pathname);
/** File name of a stage's current image inside its job folder. */
const stageFile = (job: ImportJob, stageName: StageName) => {
  const stage = job.stages[stageName];
  return stage.assetUrl ? assetName(stage.assetUrl) : `${stageName}-${stage.attempts}.png`;
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createWardrobeApi({ dataDir }: { dataDir: string }) {
  const jobsDir = path.join(dataDir, "jobs");
  const libraryAssetDir = path.join(dataDir, "imported");
  const running = new Map<string, Promise<void>>();

  async function setupStatus() {
    let hasModelReference = false;
    try {
      hasModelReference = (await stat(modelReferencePath())).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const apiKey = hasApiKey();
    return { ready: apiKey && hasModelReference, hasApiKey: apiKey, hasModelReference, modelReference: modelReferenceSetting() };
  }

  async function loadJob(id: string): Promise<StoredJob | null> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    try { return JSON.parse(await readFile(path.join(jobsDir, id, "job.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  async function mustLoadJob(id: string): Promise<StoredJob> {
    const job = await loadJob(id);
    if (!job) throw new HttpError(404, "Job not found");
    return job;
  }

  async function saveJob(job: StoredJob) {
    job.updatedAt = new Date().toISOString();
    await atomicJson(path.join(jobsDir, job.id, "job.json"), job);
  }

  const removeJobDir = (id: string) => rm(path.join(jobsDir, id), { recursive: true, force: true });

  async function persistImported(job: StoredJob, includeModeled = false): Promise<WardrobeItem> {
    const id = `import-${job.id}`;
    await mkdir(libraryAssetDir, { recursive: true });
    const garmentName = `${id}-garment.png`;
    await copyFile(path.join(jobsDir, job.id, stageFile(job, "garment")), path.join(libraryAssetDir, garmentName));
    let modeledImage: string | null = null;
    if (includeModeled) {
      const modeledName = `${id}-modeled.png`;
      await copyFile(path.join(jobsDir, job.id, stageFile(job, "modeled")), path.join(libraryAssetDir, modeledName));
      modeledImage = `${API_PATHS.library}/${modeledName}`;
    }
    const metadata = job.metadata;
    const records = await loadLibrary(dataDir);
    const existing = records.find((record) => record.id === id);
    const record: WardrobeItem = {
      id,
      name: metadata.name || "New piece",
      part: metadata.part || "upperbody",
      color: metadata.color || "#d8d0c2",
      secondaryColor: metadata.secondaryColor || null,
      palette: [metadata.color, metadata.secondaryColor].filter((color): color is string => Boolean(color)),
      tags: Array.isArray(metadata.tags) ? metadata.tags : [],
      image: `${API_PATHS.library}/${garmentName}`,
      thumbnail: `${API_PATHS.library}/${garmentName}`,
      modeledImage: modeledImage || existing?.modeledImage || null,
      importJobId: job.id,
    };
    await saveLibrary(dataDir, [...records.filter((item) => item.id !== id), record]);
    return record;
  }

  function generate(jobId: string, stageName: Exclude<StageName, "crop">): Promise<void> {
    const lock = `${jobId}:${stageName}`;
    const existing = running.get(lock);
    if (existing) return existing;
    const task = (async () => {
      const current = await mustLoadJob(jobId);
      const stage = current.stages[stageName];
      stage.status = "processing"; stage.decision = null; stage.error = null; stage.attempts += 1; stage.updatedAt = new Date().toISOString();
      await saveJob(current);
      let failedAssetUrl: string | null = null;
      let chromaKeyUsed: string | null = null;
      try {
        const dir = path.join(jobsDir, current.id);
        const output = path.join(dir, `${stageName}-${stage.attempts}.png`);
        let bytes: Buffer;
        if (stageName === "garment") {
          const sourceFile = current.internal.cropFile || current.internal.originalFile;
          const source = { data: await readFile(path.join(dir, sourceFile)), name: sourceFile };
          chromaKeyUsed = chooseChromaKey(current.metadata.color);
          const prompt = withDirection(buildGarmentPrompt(current.metadata, chromaKeyUsed), stage.prompt);
          bytes = await generateImage({ kind: "garment", prompt, images: [source] });
          const rawName = `${stageName}-${stage.attempts}-source.png`;
          await writeFile(path.join(dir, rawName), bytes);
          failedAssetUrl = `${API_PATHS.assets}/${current.id}/${rawName}`;
          bytes = await removeChromaBackground(bytes, chromaKeyUsed);
        } else {
          const garment = { data: await readFile(path.join(dir, stageFile(current, "garment"))), name: "garment.png" };
          const modelPath = modelReferencePath();
          let modelData: Buffer;
          try {
            modelData = await readFile(modelPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Model reference not found at ${modelPath}. Set WARDROBE_MODEL_REFERENCE or add data/model-reference.png.`);
            throw error;
          }
          const prompt = withDirection(MODELED_PROMPT, stage.prompt);
          bytes = await generateImage({ kind: "modeled", prompt, images: [{ data: modelData, name: "model.png" }, garment] });
        }
        await writeFile(output, bytes);
        const fresh = await mustLoadJob(current.id);
        const freshStage = fresh.stages[stageName];
        freshStage.status = "review";
        freshStage.assetUrl = `${API_PATHS.assets}/${fresh.id}/${path.basename(output)}`;
        freshStage.failedAssetUrl = null;
        freshStage.cleanupPreviewUrl = null;
        freshStage.cleanupDiagnostics = null;
        if (chromaKeyUsed) freshStage.chromaKey = chromaKeyUsed;
        freshStage.updatedAt = new Date().toISOString();
        await saveJob(fresh);
      } catch (error) {
        const fresh = await mustLoadJob(current.id);
        const freshStage = fresh.stages[stageName];
        freshStage.status = "failed"; freshStage.error = message(error); freshStage.updatedAt = new Date().toISOString();
        if (failedAssetUrl) freshStage.failedAssetUrl = failedAssetUrl;
        if (chromaKeyUsed) freshStage.chromaKey = chromaKeyUsed;
        await saveJob(fresh);
      }
    })().catch((error) => console.error(`[wardrobe] ${stageName} generation for ${jobId} failed:`, error))
      .finally(() => running.delete(lock));
    running.set(lock, task);
    return task;
  }

  async function sendFile(res: ServerResponse, file: string, cacheControl: string) {
    const bytes = await readFile(file);
    res.setHeader("Content-Type", file.endsWith(".svg") ? "image/svg+xml" : "image/png");
    res.setHeader("Cache-Control", cacheControl);
    res.end(bytes);
  }

  async function createJobs(req: IncomingMessage, res: ServerResponse) {
    const setup = await setupStatus();
    if (!setup.ready) {
      const missing = [
        !setup.hasApiKey && `${apiKeyName} in .env`,
        !setup.hasModelReference && `a PNG photo of yourself at ${setup.modelReference}`,
      ].filter(Boolean).join(" and ");
      return json(res, 503, { error: `Setup required: add ${missing}, then restart the app.` });
    }
    const normalizedImage = await normalizeImage(decodeImage(await body(req)));
    const detected = (await detectClothing(normalizedImage)).map(normalizeMetadata);
    const jobs: ImportJob[] = [];
    for (const metadata of detected) {
      const id = randomUUID();
      const dir = path.join(jobsDir, id);
      await mkdir(dir, { recursive: true });
      const originalFile = "original.png";
      const cropFile = "crop.png";
      await writeFile(path.join(dir, originalFile), normalizedImage);
      await writeFile(path.join(dir, cropFile), await cropDetectedItem(normalizedImage, metadata.boundingBox));
      const now = new Date().toISOString();
      const job: StoredJob = {
        id,
        status: "active",
        metadata,
        stages: { crop: { ...stageState(), status: "review", assetUrl: `${API_PATHS.assets}/${id}/${cropFile}`, updatedAt: now }, garment: stageState(), modeled: stageState() },
        originalAssetUrl: `${API_PATHS.assets}/${id}/${originalFile}`,
        createdAt: now,
        updatedAt: now,
        internal: { originalFile, cropFile, originalMime: "image/png" },
      };
      await saveJob(job);
      jobs.push(publicJob(job));
    }
    return json(res, 202, { jobs, noClothingDetected: jobs.length === 0 });
  }

  async function listJobs(res: ServerResponse) {
    const ids = await readdir(jobsDir).catch(() => []);
    const loadedJobs = (await Promise.all(ids.map((id) => loadJob(id)))).filter((job): job is StoredJob => Boolean(job));
    const hiddenJobs = loadedJobs.filter((job) => job.status === "complete" || isRejected(job));
    await Promise.all(hiddenJobs.map((job) => removeJobDir(job.id)));
    const jobs = loadedJobs.filter((job) => !hiddenJobs.includes(job)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return json(res, 200, jobs.map(publicJob));
  }

  async function jobAction(req: IncomingMessage, res: ServerResponse, job: StoredJob, action: string) {
    if (!action && req.method === "GET") return json(res, 200, publicJob(job));
    if (!action && req.method === "DELETE") {
      await removeJobDir(job.id);
      return json(res, 200, { deleted: true, id: job.id });
    }
    if (action === "metadata" && (req.method === "PATCH" || req.method === "PUT")) {
      const input = await body(req);
      if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) throw new HttpError(400, "metadata must be an object");
      job.metadata = normalizeMetadata({ ...job.metadata, ...input.metadata });
      await saveJob(job);
      return json(res, 200, publicJob(job));
    }
    const cleanupAction = action.match(/^stages\/garment\/(cleanup-preview|cleanup-accept)$/);
    if (cleanupAction && req.method === "POST") {
      const stage = job.stages.garment;
      if (stage.status !== "failed" || !stage.failedAssetUrl) throw new HttpError(409, "No failed garment source is available for cleanup");
      const tolerance = cleanupTolerance((await body(req)).tolerance);
      const source = await readFile(path.join(jobsDir, job.id, assetName(stage.failedAssetUrl)));
      const key = stage.chromaKey || chooseChromaKey(job.metadata?.color);
      const cleaned = await processChromaBackground(source, key, { tolerance });
      const previewName = `garment-${stage.attempts}-cleanup-${tolerance}.png`;
      const previewUrl = `${API_PATHS.assets}/${job.id}/${previewName}`;
      await writeFile(path.join(jobsDir, job.id, previewName), cleaned.bytes);
      stage.chromaKey = key;
      stage.cleanupTolerance = cleaned.tolerance;
      stage.cleanupDiagnostics = cleaned.verification;
      stage.cleanupPreviewUrl = previewUrl;
      stage.updatedAt = new Date().toISOString();
      if (cleanupAction[1] === "cleanup-accept") {
        stage.status = "review";
        stage.decision = null;
        stage.error = null;
        stage.assetUrl = previewUrl;
      }
      await saveJob(job);
      return json(res, 200, publicJob(job));
    }
    const stageMatch = action.match(/^stages\/(crop|garment|modeled)\/(approve|reject|regenerate)$/);
    if (!stageMatch || req.method !== "POST") return json(res, 404, { error: "Not found" });
    const stageName = stageMatch[1] as StageName;
    const decision = stageMatch[2]!;
    const stage = job.stages[stageName];
    if (decision === "regenerate") {
      if (stageName === "crop") throw new HttpError(400, "Upload the image again to create new crops");
      const input = await body(req);
      stage.prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) || null : null;
      stage.status = "queued";
      stage.decision = null;
      await saveJob(job);
      void generate(job.id, stageName);
      return json(res, 202, publicJob(job));
    }
    if (!DECISIONS.has(decision) || stage.status !== "review") throw new HttpError(409, "Stage is not ready for review");
    const previous = { status: stage.status, decision: stage.decision, jobStatus: job.status };
    stage.decision = decision === "approve" ? "approved" : "rejected";
    stage.status = stage.decision;
    stage.error = null;
    stage.updatedAt = new Date().toISOString();
    const startGarment = stageName === "crop" && decision === "approve" && job.stages.garment.status === "pending";
    const startModeled = stageName === "garment" && decision === "approve" && job.stages.modeled.status === "pending";
    if (stageName === "modeled" && decision === "approve") job.status = "complete";
    await saveJob(job);
    if (decision === "approve" && stageName !== "crop") {
      try {
        await persistImported(job, stageName === "modeled");
      } catch (error) {
        stage.status = previous.status;
        stage.decision = previous.decision;
        job.status = previous.jobStatus;
        await saveJob(job);
        throw error;
      }
    }
    if (decision === "reject") await removeJobDir(job.id);
    if (startGarment) void generate(job.id, "garment");
    if (startModeled) void generate(job.id, "modeled");
    const response = publicJob(job);
    if (job.status === "complete") await removeJobDir(job.id);
    return json(res, 200, response);
  }

  async function wardrobeItem(req: IncomingMessage, res: ServerResponse, id: string) {
    const records = await loadLibrary(dataDir);
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) return json(res, 404, { error: "Wardrobe item not found" });
    if (req.method === "PATCH") {
      const edit = normalizeEdit(await body(req));
      const updated = { ...records[index]!, ...edit };
      updated.palette = [...new Set([updated.color, updated.secondaryColor, ...records[index]!.palette].filter((color): color is string => Boolean(color)))].slice(0, 5);
      records[index] = updated;
      await saveLibrary(dataDir, records);
      return json(res, 200, updated);
    }
    if (req.method === "DELETE") {
      await saveLibrary(dataDir, records.filter((record) => record.id !== id));
      await Promise.all([
        rm(path.join(libraryAssetDir, `${id}-garment.png`), { force: true }),
        rm(path.join(libraryAssetDir, `${id}-modeled.png`), { force: true }),
      ]);
      return json(res, 200, { deleted: true, id });
    }
    return json(res, 405, { error: "Method not allowed" });
  }

  async function route(req: IncomingMessage, res: ServerResponse, pathname: string) {
    if (pathname === API_PATHS.wardrobe && req.method === "GET") return json(res, 200, await loadLibrary(dataDir));
    if (pathname === API_PATHS.config && req.method === "GET") return json(res, 200, await setupStatus());
    const itemMatch = pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})$/i);
    if (itemMatch) return wardrobeItem(req, res, itemMatch[1]!);
    const libraryAssetMatch = pathname.match(/^\/api\/import\/library\/([\w.-]+)$/i);
    if (libraryAssetMatch && req.method === "GET") {
      return sendFile(res, path.join(libraryAssetDir, path.basename(libraryAssetMatch[1]!)), "public, max-age=31536000, immutable");
    }
    const assetMatch = pathname.match(/^\/api\/import\/assets\/([a-f0-9-]{36})\/([\w.-]+)$/i);
    if (assetMatch && req.method === "GET") return sendFile(res, path.join(jobsDir, assetMatch[1]!, path.basename(assetMatch[2]!)), "no-store");
    if (pathname === API_PATHS.jobs && req.method === "POST") return createJobs(req, res);
    if (pathname === API_PATHS.jobs && req.method === "GET") return listJobs(res);
    const match = pathname.match(/^\/api\/import\/jobs\/([a-f0-9-]{36})(?:\/(.*))?$/i);
    if (!match) return json(res, 404, { error: "Not found" });
    return jobAction(req, res, await mustLoadJob(match[1]!), match[2] || "");
  }

  /** Handles /api/import/* requests. Returns false when the request belongs to someone else. */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const { pathname } = new URL(req.url || "/", "http://localhost");
    if (!pathname.startsWith("/api/import/")) return false;
    try {
      await route(req, res, pathname);
    } catch (error) {
      const statusCode = (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : error instanceof HttpError ? error.status : 500;
      if (statusCode === 500) console.error("[wardrobe]", error);
      json(res, statusCode, { error: statusCode === 500 ? "Internal server error" : message(error), ...(process.env.NODE_ENV !== "production" && statusCode === 500 ? { detail: message(error) } : {}) });
    }
    return true;
  }

  /** Prepares data folders and resumes work that was interrupted by a restart. */
  async function start() {
    await mkdir(jobsDir, { recursive: true });
    await mkdir(libraryAssetDir, { recursive: true });
    for (const id of await readdir(jobsDir).catch(() => [])) {
      const job = await loadJob(id);
      if (!job) continue;
      if (job.status === "complete") {
        try {
          await persistImported(job, true);
          await removeJobDir(job.id);
        } catch {
          job.status = "active";
          job.stages.modeled.status = "review";
          job.stages.modeled.decision = null;
          job.stages.modeled.error = null;
          await saveJob(job);
        }
        continue;
      }
      if (isRejected(job)) {
        await removeJobDir(job.id);
        continue;
      }
      if (job.stages.crop && job.stages.crop.status !== "approved") continue;
      if (["processing", "queued"].includes(job.stages.garment.status)) {
        job.stages.garment.status = "pending";
        await saveJob(job);
        void generate(job.id, "garment");
      } else if (job.stages.garment.status === "approved" && ["pending", "processing", "queued"].includes(job.stages.modeled.status)) {
        job.stages.modeled.status = "pending";
        await saveJob(job);
        void generate(job.id, "modeled");
      }
    }
  }

  return { handle, start };
}
