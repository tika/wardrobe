import { GoogleGenAI } from "@google/genai";
import { PART_IDS, type Part } from "@wardrobe/core";
import { z } from "zod";
import { setting } from "./config";
import { normalizeImage } from "./images";
import { DETECTION_PROMPT } from "./prompts";

export type ImageKind = "garment" | "modeled";

export const apiKeyName = "GEMINI_API_KEY";
export const hasApiKey = () => Boolean(setting(apiKeyName));

const imageModel = () => setting("GEMINI_IMAGE_MODEL", "gemini-3-pro-image");
const visionModel = () => setting("GEMINI_VISION_MODEL", "gemini-3.8-flash");
const IMAGE_FORMAT = {
  garment: { type: "image", aspect_ratio: "1:1", image_size: "1K" },
  modeled: { type: "image", aspect_ratio: "3:2", image_size: "2K" },
} as const;

let client: GoogleGenAI | undefined;
function gemini(): GoogleGenAI {
  const apiKey = setting(apiKeyName);
  if (!apiKey) throw new Error(`${apiKeyName} is not configured`);
  client ??= new GoogleGenAI({ apiKey });
  return client;
}

const imagePart = (png: Buffer) => ({ type: "image" as const, mime_type: "image/png" as const, data: png.toString("base64") });

/** Generates one image from a prompt and reference images (in prompt order) and returns it as PNG. */
export async function generateImage({ kind, prompt, images }: { kind: ImageKind; prompt: string; images: Buffer[] }): Promise<Buffer> {
  const references = await Promise.all(images.map(normalizeImage));
  const interaction = await gemini().interactions.create({
    model: imageModel(),
    input: [{ type: "text", text: prompt }, ...references.map(imagePart)],
    response_format: IMAGE_FORMAT[kind],
  });
  const image = interaction.output_image?.data;
  if (!image) throw new Error(`Gemini returned no image${interaction.output_text ? `: ${interaction.output_text}` : ""}`);
  return normalizeImage(Buffer.from(image, "base64"));
}

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const detectionSchema = z.object({
  items: z.array(z.object({
    name: z.string(),
    part: z.enum(PART_IDS as [Part, ...Part[]]),
    color: hex,
    secondaryColor: hex.nullable(),
    tags: z.array(z.string()).max(4),
    box_2d: z.array(z.number().int().min(0).max(1000)).length(4).describe("[ymin, xmin, ymax, xmax] normalized to 0-1000"),
  })).max(8),
});

/** Finds every wearable item in a photo. Boxes come back as Gemini's [ymin, xmin, ymax, xmax] on a 0–1000 grid. */
export async function detectClothing(image: Buffer) {
  const interaction = await gemini().interactions.create({
    model: visionModel(),
    input: [{ type: "text", text: DETECTION_PROMPT }, imagePart(image)],
    response_format: { type: "text", mime_type: "application/json", schema: z.toJSONSchema(detectionSchema) },
  });
  if (!interaction.output_text) throw new Error("Gemini returned no clothing analysis");
  const { items } = detectionSchema.parse(JSON.parse(interaction.output_text));
  return items.map(({ box_2d: [ymin = 0, xmin = 0, ymax = 1000, xmax = 1000], ...item }) => ({
    ...item,
    boundingBox: { x: xmin, y: ymin, width: xmax - xmin, height: ymax - ymin },
  }));
}
