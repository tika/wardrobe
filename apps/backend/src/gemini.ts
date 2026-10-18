import { Buffer } from "node:buffer";
import { GoogleGenAI } from "@google/genai";
import { PART_IDS, type Part } from "@wardrobe/core";
import { z } from "zod";
import { normalizeImage } from "./images";
import { DETECTION_PROMPT } from "./prompts";

export interface ImageFormat {
  /** For example "1:1" or "3:2". */
  aspectRatio: string;
  /** "1K", "2K" or "4K". */
  imageSize: string;
}

export interface GeminiConfig {
  apiKey: string;
  /** Defaults to Nano Banana Pro. */
  imageModel?: string;
  visionModel?: string;
}

export const DEFAULT_IMAGE_MODEL = "gemini-3-pro-image";
export const DEFAULT_VISION_MODEL = "gemini-3.8-flash";

/** A failed Gemini call, carrying Gemini's own explanation (the SDK's message is not readable). */
export class GeminiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GeminiError";
  }

  /** Rate limits and server errors may succeed later; bad requests and bad keys won't. */
  get retryable(): boolean {
    return this.status === undefined || this.status === 429 || this.status >= 500;
  }
}

function geminiError(error: unknown): GeminiError {
  const { status, body } = error as { status?: number; body?: string };
  let detail: string | undefined;
  try {
    const parsed = JSON.parse(body ?? "");
    detail = (Array.isArray(parsed) ? parsed[0] : parsed)?.error?.message;
  } catch {
    // Not a JSON error body; fall back to the SDK's message.
  }
  return new GeminiError(`Gemini: ${detail || (error instanceof Error ? error.message : String(error))}`, status);
}

const imagePart = (png: Uint8Array) => ({ type: "image" as const, mime_type: "image/png" as const, data: Buffer.from(png).toString("base64") });

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

export function createGemini(config: GeminiConfig) {
  if (!config.apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const client = new GoogleGenAI({ apiKey: config.apiKey });

  /** Generates one image from a prompt and reference images (in prompt order) and returns it as PNG. */
  async function generateImage({ prompt, images, aspectRatio, imageSize }: { prompt: string; images: Uint8Array[] } & ImageFormat): Promise<Uint8Array> {
    const references = images.map(normalizeImage);
    const interaction = await client.interactions.create({
      model: config.imageModel || DEFAULT_IMAGE_MODEL,
      input: [{ type: "text", text: prompt }, ...references.map(imagePart)],
      response_format: { type: "image", aspect_ratio: aspectRatio, image_size: imageSize },
    }).catch((error) => { throw geminiError(error); });
    const image = interaction.output_image?.data;
    if (!image) throw new Error(`Gemini returned no image${interaction.output_text ? `: ${interaction.output_text}` : ""}`);
    return normalizeImage(Buffer.from(image, "base64"));
  }

  /** Finds every wearable item in a photo. Boxes come back as Gemini's [ymin, xmin, ymax, xmax] on a 0–1000 grid. */
  async function detectClothing(image: Uint8Array) {
    const interaction = await client.interactions.create({
      model: config.visionModel || DEFAULT_VISION_MODEL,
      input: [{ type: "text", text: DETECTION_PROMPT }, imagePart(image)],
      response_format: { type: "text", mime_type: "application/json", schema: z.toJSONSchema(detectionSchema) },
    }).catch((error) => { throw geminiError(error); });
    if (!interaction.output_text) throw new Error("Gemini returned no clothing analysis");
    const { items } = detectionSchema.parse(JSON.parse(interaction.output_text));
    return items.map(({ box_2d: [ymin = 0, xmin = 0, ymax = 1000, xmax = 1000], ...item }) => ({
      ...item,
      boundingBox: { x: xmin, y: ymin, width: xmax - xmin, height: ymax - ymin },
    }));
  }

  return { generateImage, detectClothing };
}

export type Gemini = ReturnType<typeof createGemini>;
