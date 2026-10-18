// Adds accepted cutouts (and optional modeled photos) from an agent manifest to the wardrobe through the API.
// Usage: bun run library:import -- --items <dir> --manifest <file> [--modeled <dir>] [--dry-run]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { PhotonImage } from "@cf-wasm/photon";
import { HEX_COLOR, PART_IDS, type Part } from "@wardrobe/core";
import { z } from "zod";
import { apiClient } from "./client";

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
  items: z.array(z.looseObject({ slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), status: z.string() })),
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

/** Resolves a file name that must sit directly inside dir. */
function inside(dir: string, file: string, slug: string) {
  const resolved = path.resolve(dir, file);
  if (path.dirname(resolved) !== path.resolve(dir)) throw new Error(`${slug}: ${file} must be directly inside ${dir}`);
  return resolved;
}

/** A cutout must be a PNG with both transparent and visible pixels. */
async function readCutout(file: string, slug: string) {
  const bytes = await readFile(file);
  if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error(`${slug}: ${path.basename(file)} is not a PNG`);
  const image = PhotonImage.new_from_byteslice(bytes);
  const pixels = image.get_raw_pixels();
  image.free();
  let transparent = false;
  let visible = false;
  for (let index = 3; index < pixels.length && !(transparent && visible); index += 4) {
    if (pixels[index] === 0) transparent = true;
    else visible = true;
  }
  if (!transparent || !visible) throw new Error(`${slug}: PNG must contain transparent and visible pixels`);
  return bytes;
}

const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;

const manifest = manifestSchema.parse(JSON.parse(await readFile(values.manifest, "utf8")));
const accepted = manifest.items.filter((item) => item.status === "accepted").map((item) => acceptedSchema.parse(item));
if (!accepted.length) throw new Error("Manifest contains no accepted items");

const uploads = [];
for (const item of accepted) {
  const garment = await readCutout(inside(values.items, item.file || `${item.slug}.png`, item.slug), item.slug);
  if (item.modeledFile && !values.modeled) throw new Error(`${item.slug}: --modeled is required when modeledFile is set`);
  const modeled = item.modeledFile ? await readFile(inside(values.modeled!, item.modeledFile, item.slug)) : undefined;
  uploads.push({
    slug: item.slug,
    garment: dataUrl(garment),
    modeled: modeled && dataUrl(modeled),
    metadata: {
      name: item.name || item.slug.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" "),
      part: item.part,
      color: item.color,
      secondaryColor: item.secondaryColor ?? null,
      tags: item.tags,
    },
  });
}

const api = apiClient();
const imported = [];
if (!values["dry-run"]) {
  for (const { slug: _slug, ...upload } of uploads) imported.push(await api.importItem(upload));
}
console.log(JSON.stringify({ dryRun: values["dry-run"], validated: uploads.length, imported: imported.map(({ id, name }) => ({ id, name })) }, null, 2));
