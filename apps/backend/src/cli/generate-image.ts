// Generates one image with Gemini from a prompt file and ordered reference images.
// Usage: npm run image:generate -- --prompt <file> --image <ref> [--image <ref>...] --out <png> [--aspect 3:2] [--size 2K]
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createGemini } from "../gemini";

const { values } = parseArgs({
  options: {
    prompt: { type: "string" },
    image: { type: "string", multiple: true, default: [] },
    out: { type: "string" },
    aspect: { type: "string", default: "1:1" },
    size: { type: "string", default: "2K" },
  },
});
if (!values.prompt || !values.out) throw new Error("--prompt and --out are required");

const gemini = createGemini({ apiKey: process.env.GEMINI_API_KEY || "", imageModel: process.env.GEMINI_IMAGE_MODEL });
const image = await gemini.generateImage({
  prompt: await readFile(values.prompt, "utf8"),
  images: await Promise.all(values.image.map((file) => readFile(file))),
  aspectRatio: values.aspect,
  imageSize: values.size,
});
await writeFile(values.out, image);
console.log(values.out);
