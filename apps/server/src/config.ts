import { existsSync } from "node:fs";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const envFile = path.join(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

export function setting(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export const dataDir = () => path.resolve(REPO_ROOT, setting("WARDROBE_DATA_DIR", "data"));
export const modelReferenceSetting = () => setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png");
export const modelReferencePath = () => path.resolve(REPO_ROOT, modelReferenceSetting());
