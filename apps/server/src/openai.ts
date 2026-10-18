import { setting } from "./config";
import { normalizeImage } from "./images";
import { DETECTION_PROMPT } from "./prompts";

export type ImageKind = "garment" | "modeled";

const baseUrl = () => setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");
export const apiKeyName = "OPENAI_API_KEY";
export const hasApiKey = () => Boolean(setting(apiKeyName));

function requireKey(): string {
  const key = setting(apiKeyName);
  if (!key) throw new Error(`${apiKeyName} is not configured`);
  return key;
}

export async function generateImage({ kind, prompt, images }: { kind: ImageKind; prompt: string; images: Buffer[] }): Promise<Buffer> {
  const model = setting(kind === "garment" ? "OPENAI_GARMENT_MODEL" : "OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2"));
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("size", kind === "garment" ? "1024x1024" : "1536x1024");
  form.set("quality", setting("OPENAI_IMAGE_QUALITY", "high"));
  form.set("output_format", "png");
  for (const [index, image] of images.entries()) {
    const normalized = await normalizeImage(image);
    form.append("image[]", new Blob([new Uint8Array(normalized)], { type: "image/png" }), `image-${index + 1}.png`);
  }
  const response = await fetch(`${baseUrl()}/images/edits`, {
    method: "POST", headers: { Authorization: `Bearer ${requireKey()}` }, body: form,
  });
  const result: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI image request failed (${response.status})`);
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new Error("OpenAI response did not contain image data");
  return Buffer.from(encoded, "base64");
}

export async function detectClothing(image: Buffer): Promise<unknown[]> {
  const hex = { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" };
  const response = await fetch(`${baseUrl()}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: setting("OPENAI_VISION_MODEL", "gpt-5.4-mini"),
      input: [{ role: "user", content: [
        { type: "input_text", text: DETECTION_PROMPT },
        { type: "input_image", image_url: `data:image/png;base64,${image.toString("base64")}` },
      ] }],
      text: { format: { type: "json_schema", name: "wardrobe_items", strict: true, schema: { type: "object", additionalProperties: false, properties: { items: { type: "array", minItems: 0, maxItems: 8, items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, part: { type: "string", enum: ["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"] }, color: hex, secondaryColor: { anyOf: [hex, { type: "null" }] }, tags: { type: "array", items: { type: "string" }, maxItems: 4 }, boundingBox: { type: "object", additionalProperties: false, properties: { x: { type: "integer", minimum: 0, maximum: 999 }, y: { type: "integer", minimum: 0, maximum: 999 }, width: { type: "integer", minimum: 1, maximum: 1000 }, height: { type: "integer", minimum: 1, maximum: 1000 } }, required: ["x", "y", "width", "height"] } }, required: ["name", "part", "color", "secondaryColor", "tags", "boundingBox"] } } }, required: ["items"] } } },
    }),
  });
  const result: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI analysis failed (${response.status})`);
  const outputText = result.output_text || result.output?.flatMap((item: { content?: unknown[] }) => item.content || []).find((item: { type: string }) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI analysis returned no structured result");
  const parsed = JSON.parse(outputText);
  if (!Array.isArray(parsed.items)) throw new Error("OpenAI analysis returned an invalid clothing list");
  return parsed.items;
}
