import type { CreateJobsResult, ImportJob, ItemEdit, ItemMetadata, SetupStatus, StageAction, StageName, WardrobeItem } from "./types";

export interface ImportItemInput {
  /** Transparent garment cutout as a PNG data URL. */
  garment: string;
  /** Optional modeled photo as a data URL. */
  modeled?: string;
  metadata: Omit<ItemMetadata, "boundingBox">;
}

export const API_PATHS = {
  config: "/api/import/config",
  wardrobe: "/api/import/wardrobe",
  jobs: "/api/import/jobs",
  library: "/api/import/library",
  assets: "/api/import/assets",
  modelReference: "/api/import/model-reference",
} as const;

export class WardrobeApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "WardrobeApiError";
  }
}

export interface WardrobeClientOptions {
  /** Origin of the Wardrobe API. Empty means same-origin (the web app). */
  baseUrl?: string;
  /** Sent with every request, e.g. Cloudflare Access service-token headers for the iOS app and CLIs. */
  headers?: Record<string, string>;
}

export function createWardrobeClient({ baseUrl = "", headers = {} }: WardrobeClientOptions = {}) {
  const origin = baseUrl.replace(/\/$/, "");

  async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
    const { json, ...rest } = init || {};
    const response = await fetch(`${origin}${path}`, {
      ...rest,
      headers: { "Content-Type": "application/json", ...headers, ...rest.headers },
      body: json === undefined ? rest.body : JSON.stringify(json),
    });
    const value = await response.json().catch(() => ({})) as { error?: { message?: string } };
    if (!response.ok) throw new WardrobeApiError(value.error?.message || "The wardrobe request failed.", response.status);
    return value as T;
  }

  return {
    /** Headers to send when loading images directly (e.g. expo-image), since they need the same credentials. */
    headers,
    /** Resolves a server-relative asset path (such as /api/import/library/x.png) to a loadable URL. */
    assetUrl(path: string): string {
      return /^(https?:|data:|blob:|file:)/.test(path) ? path : `${origin}${path}`;
    },
    config: () => request<SetupStatus>(API_PATHS.config),
    uploadModelReference: (imageDataUrl: string) => request<SetupStatus>(API_PATHS.modelReference, { method: "PUT", json: { imageDataUrl } }),
    wardrobe: () => request<WardrobeItem[]>(API_PATHS.wardrobe),
    importItem: (input: ImportItemInput) => request<WardrobeItem>(API_PATHS.wardrobe, { method: "POST", json: input }),
    updateItem: (id: string, edit: Partial<ItemEdit>) => request<WardrobeItem>(`${API_PATHS.wardrobe}/${id}`, { method: "PATCH", json: edit }),
    deleteItem: (id: string) => request<{ deleted: true; id: string }>(`${API_PATHS.wardrobe}/${id}`, { method: "DELETE" }),
    jobs: () => request<ImportJob[]>(API_PATHS.jobs),
    job: (id: string) => request<ImportJob>(`${API_PATHS.jobs}/${id}`),
    createJobs: (imageDataUrl: string) => request<CreateJobsResult>(API_PATHS.jobs, { method: "POST", json: { imageDataUrl } }),
    deleteJob: (id: string) => request<{ deleted: true; id: string }>(`${API_PATHS.jobs}/${id}`, { method: "DELETE" }),
    updateMetadata: (id: string, metadata: Partial<ItemMetadata>) => request<ImportJob>(`${API_PATHS.jobs}/${id}/metadata`, { method: "PATCH", json: { metadata } }),
    stageAction: (id: string, stage: StageName, action: StageAction, prompt?: string) => request<ImportJob>(
      `${API_PATHS.jobs}/${id}/stages/${stage}/${action}`,
      { method: "POST", json: action === "regenerate" ? { prompt: prompt || "" } : undefined },
    ),
    cleanup: (id: string, action: "preview" | "accept", tolerance: number) => request<ImportJob>(
      `${API_PATHS.jobs}/${id}/stages/garment/cleanup-${action}`,
      { method: "POST", json: { tolerance } },
    ),
  };
}

export type WardrobeClient = ReturnType<typeof createWardrobeClient>;

/** Library paths the server assigns once a stage is approved. */
export const libraryPaths = {
  itemId: (jobId: string) => `import-${jobId}`,
  garment: (jobId: string) => `${API_PATHS.library}/import-${jobId}-garment.png`,
  modeled: (jobId: string) => `${API_PATHS.library}/import-${jobId}-modeled.png`,
};
