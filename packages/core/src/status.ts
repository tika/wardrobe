import type { ImportJob, StageName } from "./types";

export type StatusTone = "error" | "ready" | "processing" | "complete";

export interface JobStatus {
  tone: StatusTone;
  text: string;
  detail?: string | null;
}

export function deriveStatus(job: ImportJob): JobStatus {
  const { crop, garment, modeled } = job.stages;
  if (job.error || crop.status === "failed" || garment.status === "failed" || modeled.status === "failed") {
    return { tone: "error", text: "Import needs attention", detail: crop.error || garment.error || modeled.error || job.error };
  }
  if (modeled.status === "review") return { tone: "ready", text: "Modeled image ready for review" };
  if (modeled.status === "processing") return { tone: "processing", text: "Styling modeled image" };
  if (garment.status === "review") return { tone: "ready", text: "Ready for review" };
  if (garment.status === "approved") return { tone: "processing", text: "Creating modeled image" };
  if (crop.status === "review") return { tone: "ready", text: "Crop ready for review" };
  if (crop.status === "approved") return { tone: "processing", text: "Creating garment image" };
  if (crop.status === "rejected" || garment.status === "rejected" || modeled.status === "rejected") return { tone: "complete", text: "Import declined" };
  return { tone: "processing", text: "Extracting clothing from image" };
}

export function reviewStageFor(job: ImportJob): StageName | null {
  if (job.stages.modeled.status === "review") return "modeled";
  if (job.stages.garment.status === "review") return "garment";
  if (job.stages.crop.status === "review") return "crop";
  return null;
}

export function hasCleanupFailure(job: ImportJob): boolean {
  return job.stages.garment.status === "failed" && Boolean(job.stages.garment.failedAssetUrl);
}

export function failedStageFor(job: ImportJob): "garment" | "modeled" | null {
  if (job.stages.garment.status === "failed") return "garment";
  if (job.stages.modeled.status === "failed") return "modeled";
  return null;
}

/** True while the server is still generating an image for this job, so clients should poll. */
export function isGenerating(job: ImportJob): boolean {
  const { crop, garment, modeled } = job.stages;
  return (crop.status === "approved" && ["processing", "pending", "queued"].includes(garment.status))
    || ["processing", "queued"].includes(modeled.status)
    || (garment.status === "approved" && modeled.status === "pending");
}

export function isVisibleJob(job: ImportJob): boolean {
  const { crop, garment, modeled } = job.stages;
  return job.status !== "complete" && crop.status !== "rejected" && garment.status !== "rejected" && modeled.status !== "rejected";
}

/** Best available preview image for a job, newest stage first. */
export function jobPreview(job: ImportJob): string {
  return job.stages.garment.assetUrl || job.stages.garment.failedAssetUrl || job.stages.crop.assetUrl || job.originalAssetUrl;
}
