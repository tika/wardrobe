import { beforeEach, describe, expect, mock, test } from "bun:test";
import { PhotonImage } from "@cf-wasm/photon";
import type { ImportJob, WardrobeItem } from "@wardrobe/core";
import { createEnv } from "./env";

/** What the fake Gemini answers; tests swap these per case. */
const gemini = {
  detect: () => ({ items: [
    { name: "Red Tee", part: "upperbody", color: "#c81e1e", secondaryColor: null, tags: ["Cotton"], box_2d: [100, 200, 600, 800] },
    { name: "Blue Jeans", part: "lowerbody", color: "#1e3a8a", secondaryColor: null, tags: [], box_2d: [500, 250, 1000, 750] },
  ] }) as unknown,
  fail: null as null | { status: number; message: string },
  requests: [] as { model: string; response_format: Record<string, unknown>; images: number }[],
};

function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) pixels.set(paint(x, y), (y * width + x) * 4);
  const image = new PhotonImage(pixels, width, height);
  const bytes = image.get_bytes();
  image.free();
  return bytes;
}

/** A red garment on whatever chroma key the prompt asked for; the modeled photo is a plain 3:2 image. */
function fakeImage(prompt: string, aspect: string) {
  if (aspect === "3:2") return png(60, 40, () => [180, 160, 140, 255]);
  const hex = prompt.match(/solid (#[0-9a-f]{6}) chroma-key/i)?.[1] ?? "#00ff00";
  const key = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return png(64, 64, (x, y) => (x > 16 && x < 48 && y > 12 && y < 52 ? [200, 30, 30, 255] : [key[0]!, key[1]!, key[2]!, 255]));
}

mock.module("@google/genai", () => ({
  GoogleGenAI: class {
    interactions = {
      create: async (request: { model: string; input: { type: string; text?: string }[]; response_format: Record<string, unknown> }) => {
        gemini.requests.push({ model: request.model, response_format: request.response_format, images: request.input.filter((part) => part.type === "image").length });
        if (gemini.fail) throw Object.assign(new Error("400 API error occurred"), { status: gemini.fail.status, body: JSON.stringify([{ error: { message: gemini.fail.message } }]) });
        if (request.response_format.type === "text") return { output_text: JSON.stringify(gemini.detect()) };
        const image = fakeImage(request.input[0]!.text!, String(request.response_format.aspect_ratio));
        return { output_image: { mime_type: "image/png", data: Buffer.from(image).toString("base64") } };
      },
    };
  },
}));

const { default: worker, GenerateStage } = await import("../src/index");

let ctx: ReturnType<typeof createEnv>;
const access = { aud: "test", getIdentity: async () => ({ email: "owner@example.com" }) };

/** Calls the Worker like Cloudflare would, after Access let the request through. */
async function call(method: string, path: string, body?: unknown, { signedIn = true } = {}) {
  const response = await worker.fetch(
    new Request(`https://wardrobe.test/api/import${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }) as never,
    ctx.env,
    (signedIn ? { access, waitUntil() {}, passThroughOnException() {} } : { waitUntil() {}, passThroughOnException() {} }) as never,
  );
  const text = await response.text();
  return { status: response.status, json: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
}

/** Runs every workflow instance created so far, as Cloudflare would. */
async function runWorkflows() {
  const step = { do: async (_name: string, ...args: unknown[]) => (args.at(-1) as () => Promise<unknown>)() };
  for (const instance of ctx.generate.created.splice(0)) {
    await new GenerateStage({} as never, ctx.env).run({ payload: instance.params } as never, step as never);
  }
}

const photo = `data:image/png;base64,${Buffer.from(png(100, 100, () => [240, 240, 240, 255])).toString("base64")}`;

beforeEach(() => {
  ctx = createEnv();
  gemini.fail = null;
  gemini.requests = [];
});

describe("access", () => {
  test("refuses requests that did not pass Cloudflare Access", async () => {
    const response = await call("GET", "/wardrobe", undefined, { signedIn: false });
    expect(response.status).toBe(401);
    expect(response.json.error.code).toBe("unauthorized");
  });
});

describe("import pipeline", () => {
  test("requires a reference photo before importing", async () => {
    expect((await call("GET", "/config")).json).toEqual({ ready: false, hasApiKey: true, hasModelReference: false });
    const response = await call("POST", "/jobs", { imageDataUrl: photo });
    expect(response.status).toBe(503);
    expect(response.json.error.code).toBe("setup_required");
  });

  test("goes from photo to a modeled wardrobe item", async () => {
    expect((await call("PUT", "/model-reference", { imageDataUrl: photo })).json.ready).toBe(true);

    const created = await call("POST", "/jobs", { imageDataUrl: photo });
    expect(created.status).toBe(202);
    const jobs: ImportJob[] = created.json.jobs;
    expect(jobs.map((job) => job.metadata.name)).toEqual(["Red Tee", "Blue Jeans"]);
    // Gemini's [ymin, xmin, ymax, xmax] box becomes x/y/width/height.
    expect(jobs[0]!.metadata.boundingBox).toEqual({ x: 200, y: 100, width: 600, height: 500 });
    expect(jobs[0]!.metadata.tags).toEqual(["cotton"]);
    const id = jobs[0]!.id;
    expect(ctx.bucket.objects.has(`jobs/${id}/crop.png`)).toBe(true);

    // Approving the crop starts the garment workflow.
    const approvedCrop = await call("POST", `/jobs/${id}/stages/crop/approve`);
    expect(approvedCrop.json.stages.garment.status).toBe("processing");
    expect(ctx.generate.created).toEqual([{ id: `${id}-garment-1`, params: { jobId: id, stage: "garment" } }]);
    await runWorkflows();

    const garment: ImportJob = (await call("GET", `/jobs/${id}`)).json;
    expect(garment.stages.garment.status).toBe("review");
    expect(garment.stages.garment.chromaKey).toBe("#00ffff");
    const cutout = PhotonImage.new_from_byteslice(ctx.bucket.objects.get(`jobs/${id}/garment-1.png`)!.bytes);
    expect([cutout.get_width(), cutout.get_height()]).toEqual([1024, 1024]);
    expect(cutout.get_raw_pixels()[3]).toBe(0);
    cutout.free();
    expect(gemini.requests.at(-1)).toMatchObject({ model: "gemini-3-pro-image", response_format: { aspect_ratio: "1:1", image_size: "1K" }, images: 1 });

    // Approving the garment adds the item and starts the modeled photo.
    await call("PATCH", `/jobs/${id}/metadata`, { metadata: { name: "Crimson Tee" } });
    await call("POST", `/jobs/${id}/stages/garment/approve`);
    let items: WardrobeItem[] = (await call("GET", "/wardrobe")).json;
    expect(items).toMatchObject([{ id: `import-${id}`, name: "Crimson Tee", modeledImage: null }]);
    await runWorkflows();
    expect(gemini.requests.at(-1)).toMatchObject({ response_format: { aspect_ratio: "3:2", image_size: "2K" }, images: 2 });

    // Approving the modeled photo finishes the job and clears its working files.
    const done = await call("POST", `/jobs/${id}/stages/modeled/approve`);
    expect(done.json.status).toBe("complete");
    items = (await call("GET", "/wardrobe")).json;
    expect(items[0]!.modeledImage).toBe(`/api/import/library/import-${id}-modeled.png`);
    expect((await call("GET", "/jobs")).json.map((job: ImportJob) => job.id)).toEqual([jobs[1]!.id]);
    expect([...ctx.bucket.objects.keys()].some((key) => key.startsWith(`jobs/${id}/`))).toBe(false);
  });

  test("reports Gemini's reason and does not retry a bad request", async () => {
    await call("PUT", "/model-reference", { imageDataUrl: photo });
    const [job] = (await call("POST", "/jobs", { imageDataUrl: photo })).json.jobs;
    gemini.fail = { status: 400, message: "API key not valid." };
    await call("POST", `/jobs/${job.id}/stages/crop/approve`);
    await runWorkflows();
    const failed: ImportJob = (await call("GET", `/jobs/${job.id}`)).json;
    expect(failed.stages.garment).toMatchObject({ status: "failed", error: "Gemini: API key not valid." });

    const detect = await call("POST", "/jobs", { imageDataUrl: photo });
    expect(detect.status).toBe(502);
    expect(detect.json.error).toEqual({ code: "upstream", message: "Gemini: API key not valid." });
  });

  test("rejecting a stage drops the job and its files", async () => {
    await call("PUT", "/model-reference", { imageDataUrl: photo });
    const [job] = (await call("POST", "/jobs", { imageDataUrl: photo })).json.jobs;
    await call("POST", `/jobs/${job.id}/stages/crop/reject`);
    expect((await call("GET", `/jobs/${job.id}`)).status).toBe(404);
    expect([...ctx.bucket.objects.keys()].some((key) => key.startsWith(`jobs/${job.id}/`))).toBe(false);
  });
});

describe("wardrobe", () => {
  const cutout = `data:image/png;base64,${Buffer.from(png(32, 32, (x) => (x < 16 ? [30, 58, 138, 255] : [0, 0, 0, 0]))).toString("base64")}`;
  const metadata = { name: "Navy Tee", part: "upperbody", color: "#1E3A8A", secondaryColor: null, tags: ["Cotton"] };

  test("importing the same cutout twice updates one item", async () => {
    const first = await call("POST", "/wardrobe", { garment: cutout, metadata });
    expect(first.status).toBe(201);
    await call("POST", "/wardrobe", { garment: cutout, metadata: { ...metadata, name: "Navy Crew" } });
    const items: WardrobeItem[] = (await call("GET", "/wardrobe")).json;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "Navy Crew", color: "#1e3a8a", tags: ["cotton"] });
  });

  test("edits are validated and update the palette", async () => {
    const { json: item } = await call("POST", "/wardrobe", { garment: cutout, metadata });
    expect((await call("PATCH", `/wardrobe/${item.id}`, { color: "blue" })).status).toBe(400);
    const edited = await call("PATCH", `/wardrobe/${item.id}`, { secondaryColor: "#FFFFFF", tags: [" denim "] });
    expect(edited.json).toMatchObject({ secondaryColor: "#ffffff", tags: ["denim"], palette: ["#1e3a8a", "#ffffff"] });
  });

  test("deleting an item removes its images", async () => {
    const { json: item } = await call("POST", "/wardrobe", { garment: cutout, metadata });
    expect((await call("DELETE", `/wardrobe/${item.id}`)).status).toBe(200);
    expect(ctx.bucket.objects.has(`library/${item.id}-garment.png`)).toBe(false);
    expect((await call("DELETE", `/wardrobe/${item.id}`)).status).toBe(404);
  });
});
