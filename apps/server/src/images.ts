import sharp from "sharp";
import { HEX_COLOR, type BoundingBox } from "@wardrobe/core";

export interface ChromaVerification {
  contaminatedPixels: number;
  maxSpill: number;
}

export function normalizeBoundingBox(value: unknown = {}): BoundingBox {
  const box = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const number = (key: string, fallback: number) => Number.isFinite(Number(box[key])) ? Math.round(Number(box[key])) : fallback;
  const x = Math.max(0, Math.min(999, number("x", 0)));
  const y = Math.max(0, Math.min(999, number("y", 0)));
  const width = Math.max(1, Math.min(1000 - x, number("width", 1000 - x)));
  const height = Math.max(1, Math.min(1000 - y, number("height", 1000 - y)));
  return { x, y, width, height };
}

export async function normalizeImage(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes).rotate().toColorspace("srgb").png().toBuffer();
}

export async function cropDetectedItem(bytes: Buffer, boundingBox: BoundingBox | undefined): Promise<Buffer> {
  const normalized = await normalizeImage(bytes);
  const { width = 1, height = 1 } = await sharp(normalized).metadata();
  const box = normalizeBoundingBox(boundingBox);
  const rawLeft = (box.x / 1000) * width;
  const rawTop = (box.y / 1000) * height;
  const rawWidth = (box.width / 1000) * width;
  const rawHeight = (box.height / 1000) * height;
  const padding = Math.max(12, Math.round(Math.max(rawWidth, rawHeight) * 0.08));
  const left = Math.max(0, Math.floor(rawLeft - padding));
  const top = Math.max(0, Math.floor(rawTop - padding));
  const right = Math.min(width, Math.ceil(rawLeft + rawWidth + padding));
  const bottom = Math.min(height, Math.ceil(rawTop + rawHeight + padding));
  return sharp(normalized).extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }).png().toBuffer();
}

export function chooseChromaKey(primary = "#808080"): string {
  const value = HEX_COLOR.test(primary) ? primary : "#808080";
  const source = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  const candidates = [[0, 255, 0], [255, 0, 255], [0, 255, 255]];
  const distance = (color: number[]) => color.reduce((total, channel, index) => total + ((channel - source[index]!) ** 2), 0);
  const selected = candidates.sort((a, b) => distance(b) - distance(a))[0]!;
  return `#${selected.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function keyChannels(key: string) {
  const target = [1, 3, 5].map((offset) => Number.parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.flatMap((channel, index) => channel > 200 ? [index] : []);
  const neutralChannels = target.flatMap((channel, index) => channel < 55 ? [index] : []);
  return { target, keyedChannels, neutralChannels };
}

function channelLevel(data: Buffer, index: number, channels: number[]): number {
  return channels.reduce((total, channel) => total + data[index + channel]!, 0) / channels.length;
}

function removeKeyedSpill(data: Buffer, index: number, keyedChannels: number[], neutralLevel: number) {
  let remaining = Math.ceil(keyedChannels.reduce((total, channel) => total + data[index + channel]!, 0) - (neutralLevel * keyedChannels.length));
  let active = keyedChannels.filter((channel) => data[index + channel]! > 0);
  while (remaining > 0 && active.length) {
    const share = Math.ceil(remaining / active.length);
    const next: number[] = [];
    for (const channel of active) {
      const reduction = Math.min(data[index + channel]!, share, remaining);
      data[index + channel]! -= reduction;
      remaining -= reduction;
      if (data[index + channel]! > 0) next.push(channel);
    }
    active = next;
  }
}

function removeResidualSpill(data: Buffer, keyedChannels: number[], neutralChannels: number[]) {
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const neutralLevel = channelLevel(data, index, neutralChannels);
    if (channelLevel(data, index, keyedChannels) - neutralLevel > 0) removeKeyedSpill(data, index, keyedChannels, neutralLevel);
  }
}

export async function processChromaBackground(bytes: Buffer, key: string, tolerance = 46) {
  const feather = 80;
  const { target, keyedChannels, neutralChannels } = keyChannels(key);
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) {
    const distance = Math.sqrt(
      ((data[index]! - target[0]!) ** 2)
      + ((data[index + 1]! - target[1]!) ** 2)
      + ((data[index + 2]! - target[2]!) ** 2),
    );
    if (distance <= tolerance) {
      data.fill(0, index, index + 4);
      continue;
    }
    if (distance < tolerance + feather) data[index + 3] = Math.round(data[index + 3]! * ((distance - tolerance) / feather));
    const neutralLevel = channelLevel(data, index, neutralChannels);
    const spill = Math.max(0, channelLevel(data, index, keyedChannels) - neutralLevel);
    if (spill > 0) {
      const spillAlpha = Math.max(0, 1 - (Math.max(0, spill - 4) / 150));
      data[index + 3] = Math.round(data[index + 3]! * spillAlpha);
      removeKeyedSpill(data, index, keyedChannels, neutralLevel);
    }
    if (data[index + 3]! <= 8) data.fill(0, index, index + 4);
  }
  removeResidualSpill(data, keyedChannels, neutralChannels);
  const keyedOutput = await sharp(data, { raw: info }).png().toBuffer();
  const framedOutput = await frameTransparentGarment(keyedOutput);
  const { data: framedData, info: framedInfo } = await sharp(framedOutput).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  removeResidualSpill(framedData, keyedChannels, neutralChannels);
  const output = await sharp(framedData, { raw: framedInfo }).png().toBuffer();
  const verification = await verifyNoChromaSpill(output, key);
  return { bytes: output, verification, tolerance };
}

export async function removeChromaBackground(bytes: Buffer, key: string): Promise<Buffer> {
  const result = await processChromaBackground(bytes, key);
  if (result.verification.contaminatedPixels > 1) {
    throw new Error(`Background cleanup left ${result.verification.contaminatedPixels} chroma-contaminated pixels`);
  }
  return result.bytes;
}

export async function frameTransparentGarment(bytes: Buffer, canvasSize = 1024, occupancy = 0.88): Promise<Buffer> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    if (data[index + 3]! <= 8) continue;
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error("Background removal did not leave a visible garment");

  const trimmed = await sharp(data, { raw: info })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .png()
    .toBuffer();
  const targetSize = Math.max(1, Math.round(canvasSize * Math.max(0.5, Math.min(0.96, occupancy))));
  const resized = await sharp(trimmed)
    .resize(targetSize, targetSize, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.floor((canvasSize - resized.info.width) / 2);
  const top = Math.floor((canvasSize - resized.info.height) / 2);
  return sharp({ create: { width: canvasSize, height: canvasSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized.data, left, top }])
    .png()
    .toBuffer();
}

async function verifyNoChromaSpill(bytes: Buffer, key: string): Promise<ChromaVerification> {
  const { keyedChannels, neutralChannels } = keyChannels(key);
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let contaminatedPixels = 0;
  let maxSpill = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const spill = Math.max(0, channelLevel(data, index, keyedChannels) - channelLevel(data, index, neutralChannels));
    maxSpill = Math.max(maxSpill, spill);
    if (spill > 1.5) contaminatedPixels += 1;
  }
  return { contaminatedPixels, maxSpill };
}
