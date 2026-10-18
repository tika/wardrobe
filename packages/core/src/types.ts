export type Part = "upperbody" | "wholebody_up" | "lowerbody" | "accessories_up" | "shoes";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ItemMetadata {
  name: string;
  part: Part;
  color: string;
  secondaryColor: string | null;
  tags: string[];
  boundingBox?: BoundingBox;
}

export interface WardrobeItem {
  id: string;
  name: string;
  part: Part;
  color: string;
  secondaryColor: string | null;
  palette: string[];
  tags: string[];
  image: string;
  thumbnail: string;
  modeledImage: string | null;
  importJobId: string;
}

export type ItemEdit = Pick<WardrobeItem, "name" | "part" | "color" | "secondaryColor" | "tags">;

export type StageName = "crop" | "garment" | "modeled";
export type StageStatus = "pending" | "queued" | "processing" | "review" | "approved" | "rejected" | "failed";
export type StageAction = "approve" | "reject" | "regenerate";

export interface CleanupDiagnostics {
  contaminatedPixels: number;
  maxSpill: number;
}

export interface Stage {
  status: StageStatus;
  decision: "approved" | "rejected" | null;
  attempts: number;
  assetUrl: string | null;
  failedAssetUrl: string | null;
  cleanupPreviewUrl: string | null;
  cleanupTolerance: number;
  cleanupDiagnostics: CleanupDiagnostics | null;
  error: string | null;
  prompt: string | null;
  updatedAt: string | null;
  chromaKey?: string;
}

export interface ImportJob {
  id: string;
  status: "active" | "complete";
  metadata: ItemMetadata;
  stages: Record<StageName, Stage>;
  originalAssetUrl: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface SetupStatus {
  ready: boolean;
  hasApiKey: boolean;
  /** Whether a reference photo of the user has been uploaded for modeled images. */
  hasModelReference: boolean;
}

export interface CreateJobsResult {
  jobs: ImportJob[];
  noClothingDetected: boolean;
}
