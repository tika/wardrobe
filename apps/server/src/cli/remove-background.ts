// Turns a flat chroma-key background transparent and frames the garment on a 1024px square canvas.
// Usage: npm run image:remove-background -- --input <png> --out <png> --key <#hex> [--tolerance 46]
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { HEX_COLOR } from "@wardrobe/core";
import { processChromaBackground } from "../images";
import { toleranceSchema } from "../schemas";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    out: { type: "string" },
    key: { type: "string" },
    tolerance: { type: "string", default: "46" },
  },
});
if (!values.input || !values.out || !values.key || !HEX_COLOR.test(values.key)) throw new Error("--input, --out and a six-digit --key are required");

const result = await processChromaBackground(await readFile(values.input), values.key.toLowerCase(), toleranceSchema.parse(values.tolerance));
await writeFile(values.out, result.bytes);
console.log(JSON.stringify({ out: values.out, tolerance: result.tolerance, ...result.verification }));
