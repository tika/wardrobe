// Imports accepted cutouts (and optional modeled photos) from an agent manifest into the wardrobe library.
// Usage: npm run library:import -- --items <dir> --manifest <file> [--modeled <dir>] [--dry-run]
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { API_PATHS, HEX_COLOR, PART_IDS, type Part, type WardrobeItem } from "@wardrobe/core";
import sharp from "sharp";
import { z } from "zod";
import { dataDir } from "../config";
import { loadLibrary, saveLibrary } from "../library";

const { values } = parseArgs({
  options: {
    items: { type: "string" },
    manifest: { type: "string" },
    modeled: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
if (!values.items || !values.manifest) throw new Error("--items and --manifest are required");

const hex = z.string().regex(HEX_COLOR).toLowerCase();
const manifestSchema = z.object({
  items: z.array(z.looseObject({
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    status: z.string(),
  })),
});
const acceptedSchema = z.object({
  slug: z.string(),
  file: z.string().optional(),
  modeledFile: z.string().min(1).nullish(),
  name: z.string().trim().optional(),
  part: z.enum(PART_IDS as [Part, ...Part[]]),
  color: hex,
  secondaryColor: hex.nullish(),
  tags: z.array(z.string()).optional().transform((tags = []) => tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean).slice(0, 12)),
});

/** A UUID v4-shaped id derived from file content, so re-importing the same cutout updates instead of duplicating. */
function stableUuid(hash: string) {
  const raw = hash.slice(0, 32).split("");
  raw[12] = "4";
  raw[16] = ((Number.parseInt(raw[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = raw.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Resolves a file name that must sit directly inside dir. */
function inside(dir: string, file: string, slug: string) {
  const resolved = path.resolve(dir, file);
  if (path.dirname(resolved) !== path.resolve(dir)) throw new Error(`${slug}: ${file} must be directly inside ${dir}`);
  return resolved;
}

async function validateCutout(file: string, slug: string) {
  const bytes = await readFile(file);
  const image = sharp(bytes);
  if ((await image.metadata()).format !== "png") throw new Error(`${slug}: ${path.basename(file)} is not a PNG`);
  const alpha = (await image.stats()).channels[3];
  if (!alpha || alpha.min !== 0 || alpha.max === 0) throw new Error(`${slug}: PNG must contain transparent and visible pixels`);
  return createHash("sha256").update(bytes).digest("hex");
}

const manifest = manifestSchema.parse(JSON.parse(await readFile(values.manifest, "utf8")));
const accepted = manifest.items.filter((item) => item.status === "accepted").map((item) => acceptedSchema.parse(item));
if (!accepted.length) throw new Error("Manifest contains no accepted items");

const libraryDir = path.join(dataDir(), "imported");
const records = await loadLibrary(dataDir());
const copies: [from: string, to: string][] = [];

for (const item of accepted) {
  const source = inside(values.items, item.file || `${item.slug}.png`, item.slug);
  const uuid = stableUuid(await validateCutout(source, item.slug));
  const id = `import-${uuid}`;
  copies.push([source, path.join(libraryDir, `${id}-garment.png`)]);
  let modeledImage: string | null = null;
  if (item.modeledFile) {
    if (!values.modeled) throw new Error(`${item.slug}: --modeled is required when modeledFile is set`);
    const modeledSource = inside(values.modeled, item.modeledFile, item.slug);
    if ((await sharp(modeledSource).metadata()).format !== "png") throw new Error(`${item.slug}: ${item.modeledFile} is not a PNG`);
    copies.push([modeledSource, path.join(libraryDir, `${id}-modeled.png`)]);
    modeledImage = `${API_PATHS.library}/${id}-modeled.png`;
  }
  const garment = `${API_PATHS.library}/${id}-garment.png`;
  const existing = records.find((record) => record.id === id);
  const record: WardrobeItem = {
    id,
    name: item.name || item.slug.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" "),
    part: item.part,
    color: item.color,
    secondaryColor: item.secondaryColor ?? null,
    palette: [item.color, item.secondaryColor].filter((color): color is string => Boolean(color)),
    tags: item.tags,
    image: garment,
    thumbnail: garment,
    modeledImage: modeledImage || existing?.modeledImage || null,
    importJobId: uuid,
  };
  if (existing) Object.assign(existing, record);
  else records.push(record);
}

if (!values["dry-run"]) {
  await mkdir(libraryDir, { recursive: true });
  for (const [from, to] of copies) await copyFile(from, to);
  await saveLibrary(dataDir(), records);
}

console.log(JSON.stringify({ dryRun: values["dry-run"], imported: accepted.length, total: records.length, library: path.join(dataDir(), "library.json") }, null, 2));
