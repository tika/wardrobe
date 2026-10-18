import type { ImportJob, ItemMetadata, SetupStatus, Stage, StageName, WardrobeItem } from "@wardrobe/core";
import type { Bindings, GeneratedStage } from "./env";
import { createGemini, type ImageFormat } from "./gemini";
import { chooseChromaKey, cropDetectedItem, normalizeImage, processChromaBackground, removeChromaBackground } from "./images";
import { ApiError, notFound } from "./lib/http";
import { buildGarmentPrompt, MODELED_PROMPT, withDirection } from "./prompts";
import { metadataSchema } from "./schemas";
import { createStore, fileName, keys, urls } from "./store";

const FORMATS: Record<GeneratedStage, ImageFormat> = {
  garment: { aspectRatio: "1:1", imageSize: "1K" },
  modeled: { aspectRatio: "3:2", imageSize: "2K" },
};

function stageState(): Stage {
  return { status: "pending", decision: null, attempts: 0, assetUrl: null, failedAssetUrl: null, cleanupPreviewUrl: null, cleanupTolerance: 46, cleanupDiagnostics: null, error: null, prompt: null, updatedAt: null };
}

const now = () => new Date().toISOString();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A UUID v4-shaped id derived from content, so importing the same cutout twice updates one item. */
async function contentUuid(bytes: Uint8Array): Promise<string> {
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const raw = hash.slice(0, 32).split("");
  raw[12] = "4";
  raw[16] = ((Number.parseInt(raw[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = raw.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** The library record for an item with these details. */
const itemFields = (id: string, metadata: ItemMetadata, importJobId: string, hasModeled: boolean) => ({
  id,
  name: metadata.name,
  part: metadata.part,
  color: metadata.color,
  secondaryColor: metadata.secondaryColor,
  palette: [metadata.color, metadata.secondaryColor].filter((color): color is string => Boolean(color)),
  tags: metadata.tags,
  hasModeled,
  importJobId,
});

/**
 * The import pipeline: crop → garment cutout → modeled photo, each reviewed by the user.
 * Image generation runs in the GenerateStage workflow, which calls `generate` and `finish`.
 */
export function createPipeline(env: Bindings) {
  const store = createStore(env);
  const gemini = () => createGemini({ apiKey: env.GEMINI_API_KEY, imageModel: env.GEMINI_IMAGE_MODEL, visionModel: env.GEMINI_VISION_MODEL });

  async function job(id: string): Promise<ImportJob> {
    const found = await store.jobs.get(id);
    if (!found) throw notFound("Job");
    return found;
  }

  async function setupStatus(): Promise<SetupStatus> {
    const hasApiKey = Boolean(env.GEMINI_API_KEY);
    const hasModelReference = await store.files.exists(keys.modelReference);
    return { ready: hasApiKey && hasModelReference, hasApiKey, hasModelReference };
  }

  async function setModelReference(image: Uint8Array) {
    await store.files.put(keys.modelReference, normalizeImage(image));
    return setupStatus();
  }

  /** Marks a stage as running and hands it to the workflow. */
  async function startGeneration(current: ImportJob, stageName: GeneratedStage): Promise<ImportJob> {
    const stage = current.stages[stageName];
    Object.assign(stage, { status: "processing", decision: null, error: null, attempts: stage.attempts + 1, updatedAt: now() });
    const saved = await store.jobs.save(current);
    await env.GENERATE.create({ id: `${current.id}-${stageName}-${stage.attempts}`, params: { jobId: current.id, stage: stageName } });
    return saved;
  }

  /** Runs one generation attempt. Throws on Gemini errors (so the workflow retries); cleanup failures come back as a failed result. */
  async function generate(jobId: string, stageName: GeneratedStage): Promise<Partial<Stage>> {
    const current = await job(jobId);
    const stage = current.stages[stageName];
    const outputName = `${stageName}-${stage.attempts}.png`;
    if (stageName === "garment") {
      const chromaKey = chooseChromaKey(current.metadata.color);
      const crop = await store.files.get(keys.job(jobId, "crop.png"));
      if (!crop) throw new Error("The crop for this job is missing");
      const raw = await gemini().generateImage({ ...FORMATS.garment, prompt: withDirection(buildGarmentPrompt(current.metadata, chromaKey), stage.prompt), images: [crop] });
      const rawName = `garment-${stage.attempts}-source.png`;
      await store.files.put(keys.job(jobId, rawName), raw);
      try {
        await store.files.put(keys.job(jobId, outputName), removeChromaBackground(raw, chromaKey));
      } catch (error) {
        return { status: "failed", error: message(error), failedAssetUrl: urls.job(jobId, rawName), chromaKey };
      }
      return { status: "review", assetUrl: urls.job(jobId, outputName), failedAssetUrl: null, cleanupPreviewUrl: null, cleanupDiagnostics: null, chromaKey };
    }
    const model = await store.files.get(keys.modelReference);
    if (!model) throw new Error("Upload a reference photo of yourself before creating modeled images");
    const garment = await store.files.get(keys.job(jobId, fileName(current.stages.garment.assetUrl!)));
    if (!garment) throw new Error("The garment image for this job is missing");
    const photo = await gemini().generateImage({ ...FORMATS.modeled, prompt: withDirection(MODELED_PROMPT, stage.prompt), images: [model, garment] });
    await store.files.put(keys.job(jobId, outputName), photo);
    return { status: "review", assetUrl: urls.job(jobId, outputName) };
  }

  /** Records a workflow's result on the job; a job deleted mid-run has its late files cleared instead. */
  async function finish(jobId: string, stageName: GeneratedStage, result: Partial<Stage>) {
    const current = await store.jobs.get(jobId);
    if (!current) return store.jobs.remove(jobId);
    Object.assign(current.stages[stageName], result, { updatedAt: now() });
    await store.jobs.save(current);
  }

  async function create(image: Uint8Array): Promise<ImportJob[]> {
    const setup = await setupStatus();
    if (!setup.ready) {
      const missing = [!setup.hasApiKey && "a Gemini API key", !setup.hasModelReference && "a reference photo of yourself"].filter(Boolean).join(" and ");
      throw new ApiError(503, "setup_required", `Setup required: add ${missing}.`);
    }
    const original = normalizeImage(image);
    const detected = (await gemini().detectClothing(original)).map((item) => metadataSchema.parse(item));
    const created: ImportJob[] = [];
    for (const metadata of detected) {
      const id = crypto.randomUUID();
      await store.files.put(keys.job(id, "original.png"), original);
      await store.files.put(keys.job(id, "crop.png"), cropDetectedItem(original, metadata.boundingBox));
      created.push(await store.jobs.save({
        id,
        status: "active",
        metadata,
        stages: { crop: { ...stageState(), status: "review", assetUrl: urls.job(id, "crop.png"), updatedAt: now() }, garment: stageState(), modeled: stageState() },
        originalAssetUrl: urls.job(id, "original.png"),
        createdAt: now(),
        updatedAt: now(),
      }));
    }
    return created;
  }

  async function updateMetadata(id: string, patch: Record<string, unknown>): Promise<ImportJob> {
    const current = await job(id);
    current.metadata = metadataSchema.parse({ ...current.metadata, ...patch });
    return store.jobs.save(current);
  }

  async function regenerate(id: string, stageName: StageName, prompt: string | null): Promise<ImportJob> {
    if (stageName === "crop") throw new ApiError(400, "bad_request", "Upload the image again to create new crops");
    const current = await job(id);
    current.stages[stageName].prompt = prompt;
    return startGeneration(current, stageName);
  }

  /** Copies the approved images into the library and saves the item. */
  async function persist(current: ImportJob, withModeled: boolean): Promise<WardrobeItem> {
    const id = `import-${current.id}`;
    await store.files.copy(keys.job(current.id, fileName(current.stages.garment.assetUrl!)), keys.garment(id));
    if (withModeled) await store.files.copy(keys.job(current.id, fileName(current.stages.modeled.assetUrl!)), keys.modeled(id));
    return store.items.save(itemFields(id, current.metadata, current.id, withModeled));
  }

  async function decide(id: string, stageName: StageName, decision: "approve" | "reject"): Promise<ImportJob> {
    const current = await job(id);
    const stage = current.stages[stageName];
    if (stage.status !== "review") throw new ApiError(409, "conflict", "Stage is not ready for review");
    if (decision === "reject") {
      await store.jobs.remove(id);
      Object.assign(stage, { status: "rejected", decision: "rejected", updatedAt: now() });
      return current;
    }
    if (stageName !== "crop") await persist(current, stageName === "modeled");
    Object.assign(stage, { status: "approved", decision: "approved", error: null, updatedAt: now() });
    if (stageName === "modeled") {
      await store.jobs.remove(id);
      return { ...current, status: "complete" };
    }
    return startGeneration(current, stageName === "crop" ? "garment" : "modeled");
  }

  /** Re-runs background removal on a failed garment's raw image, without calling the image model. */
  async function cleanup(id: string, tolerance: number, accept: boolean): Promise<ImportJob> {
    const current = await job(id);
    const stage = current.stages.garment;
    if (stage.status !== "failed" || !stage.failedAssetUrl) throw new ApiError(409, "conflict", "No failed garment source is available for cleanup");
    const source = await store.files.get(keys.job(id, fileName(stage.failedAssetUrl)));
    if (!source) throw notFound("Garment source");
    const key = stage.chromaKey || chooseChromaKey(current.metadata.color);
    const cleaned = processChromaBackground(source, key, tolerance);
    const previewName = `garment-${stage.attempts}-cleanup-${tolerance}.png`;
    await store.files.put(keys.job(id, previewName), cleaned.bytes);
    Object.assign(stage, { chromaKey: key, cleanupTolerance: cleaned.tolerance, cleanupDiagnostics: cleaned.verification, cleanupPreviewUrl: urls.job(id, previewName), updatedAt: now() });
    if (accept) Object.assign(stage, { status: "review", decision: null, error: null, assetUrl: urls.job(id, previewName) });
    return store.jobs.save(current);
  }

  /** Adds a finished cutout (and optional modeled photo) straight to the library, as the agent importer does. */
  async function importItem(input: { garment: Uint8Array; modeled?: Uint8Array; metadata: ItemMetadata }): Promise<WardrobeItem> {
    const uuid = await contentUuid(input.garment);
    const id = `import-${uuid}`;
    await store.files.put(keys.garment(id), normalizeImage(input.garment));
    if (input.modeled) await store.files.put(keys.modeled(id), normalizeImage(input.modeled));
    return store.items.save(itemFields(id, input.metadata, uuid, Boolean(input.modeled)));
  }

  return {
    store, setupStatus, setModelReference, create, updateMetadata, regenerate, decide, cleanup, importItem, generate, finish,
    list: () => store.jobs.list(),
    get: job,
    remove: (id: string) => store.jobs.remove(id),
  };
}
