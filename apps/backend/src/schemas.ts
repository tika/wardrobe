import { HEX_COLOR, PART_IDS, type Part } from "@wardrobe/core";
import { z } from "zod";
import { normalizeBoundingBox } from "./images";

const hex = z.string().regex(HEX_COLOR).toLowerCase();
const part = z.enum(PART_IDS as [Part, ...Part[]]);
const name = z.string().trim().transform((value) => value.slice(0, 120));
const tags = z.array(z.string().trim()).transform((values) => values.filter(Boolean).slice(0, 12));

/** Item details from the vision model or the review form. Bad fields fall back to defaults instead of failing. */
export const metadataSchema = z.object({
  name: name.transform((value) => value || "New piece").catch("New piece"),
  part: part.catch("upperbody"),
  color: hex.catch("#d8d0c2"),
  secondaryColor: hex.nullable().catch(null),
  tags: tags.transform((values) => values.map((tag) => tag.toLowerCase().slice(0, 40))).catch([]),
  boundingBox: z.unknown().optional().transform(normalizeBoundingBox),
});

/** Edits to a saved wardrobe item; every field is optional. */
export const itemEditSchema = z.object({
  name,
  part,
  color: hex,
  secondaryColor: z.union([hex, z.literal("").transform(() => null), z.null()]),
  tags,
}).partial();

export const imageUploadSchema = z.object({ imageDataUrl: z.string().min(1) });
export const metadataPatchSchema = z.object({ metadata: z.record(z.string(), z.unknown()) });
export const regenerateSchema = z.object({ prompt: z.string().trim().transform((value) => value.slice(0, 1200) || null).optional() });
export const toleranceSchema = z.coerce.number().transform((value) => Math.max(18, Math.min(110, Math.round(value)))).catch(46);
export const cleanupSchema = z.object({ tolerance: toleranceSchema });
