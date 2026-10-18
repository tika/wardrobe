// Downloads the wardrobe (library.json, every cutout and modeled photo, and the model reference)
// into a local folder so agents can style and generate from it.
// Usage: bun run library:pull -- --out <dir>
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { API_PATHS } from "@wardrobe/core";
import { apiClient } from "./client";

const { values } = parseArgs({ options: { out: { type: "string" } } });
if (!values.out) throw new Error("--out is required");

const api = apiClient();
const out = path.resolve(values.out);
await mkdir(path.join(out, "images"), { recursive: true });

async function download(assetPath: string, file: string): Promise<string | null> {
  const response = await fetch(api.assetUrl(assetPath), { headers: api.headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not download ${assetPath} (${response.status})`);
  await writeFile(file, new Uint8Array(await response.arrayBuffer()));
  return file;
}

const items = await api.wardrobe();
const library = [];
for (const item of items) {
  const image = await download(item.image, path.join(out, "images", `${item.id}-garment.png`));
  const modeledImage = item.modeledImage ? await download(item.modeledImage, path.join(out, "images", `${item.id}-modeled.png`)) : null;
  library.push({ ...item, image, thumbnail: image, modeledImage });
}
await writeFile(path.join(out, "library.json"), `${JSON.stringify(library, null, 2)}\n`);
const modelReference = await download(API_PATHS.modelReference, path.join(out, "model-reference.png"));

console.log(JSON.stringify({ items: library.length, library: path.join(out, "library.json"), modelReference }, null, 2));
