import { crop, PhotonImage, resize, SamplingFilter } from "@cf-wasm/photon";
import { HEX_COLOR, type BoundingBox } from "@wardrobe/core";

export interface ChromaVerification {
  contaminatedPixels: number;
  maxSpill: number;
}

interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Decodes PNG, JPEG or WebP into raw RGBA pixels. Photon images live in WASM memory, so they are freed right away. */
function decode(bytes: Uint8Array): RawImage {
  const image = PhotonImage.new_from_byteslice(bytes);
  try {
    return { data: image.get_raw_pixels(), width: image.get_width(), height: image.get_height() };
  } finally {
    image.free();
  }
}

function encodePng({ data, width, height }: RawImage): Uint8Array {
  const image = new PhotonImage(data, width, height);
  try {
    return image.get_bytes();
  } finally {
    image.free();
  }
}

function transform(raw: RawImage, operation: (image: PhotonImage) => PhotonImage): RawImage {
  const source = new PhotonImage(raw.data, raw.width, raw.height);
  const result = operation(source);
  try {
    return { data: result.get_raw_pixels(), width: result.get_width(), height: result.get_height() };
  } finally {
    source.free();
    if (result !== source) result.free();
  }
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

/** Longest side the pipeline works with; larger photos only cost memory and Gemini tokens. */
export const MAX_IMAGE_SIZE = 2048;

/**
 * Re-encodes any supported image as PNG, scaled down to MAX_IMAGE_SIZE.
 * Clients upload upright images (they apply EXIF rotation), so none is needed here.
 */
export function normalizeImage(bytes: Uint8Array): Uint8Array {
  const image = decode(bytes);
  const scale = MAX_IMAGE_SIZE / Math.max(image.width, image.height);
  if (scale >= 1) return encodePng(image);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  premultiply(image.data);
  const resized = transform(image, (photon) => resize(photon, width, height, SamplingFilter.Lanczos3));
  premultiply(resized.data, true);
  return encodePng(resized);
}

/** Crops one detected item (box on a 1000×1000 grid) with a little padding around it. */
export function cropDetectedItem(bytes: Uint8Array, boundingBox: BoundingBox | undefined): Uint8Array {
  const image = decode(bytes);
  const box = normalizeBoundingBox(boundingBox);
  const rawLeft = (box.x / 1000) * image.width;
  const rawTop = (box.y / 1000) * image.height;
  const rawWidth = (box.width / 1000) * image.width;
  const rawHeight = (box.height / 1000) * image.height;
  const padding = Math.max(12, Math.round(Math.max(rawWidth, rawHeight) * 0.08));
  const left = Math.max(0, Math.floor(rawLeft - padding));
  const top = Math.max(0, Math.floor(rawTop - padding));
  const right = Math.min(image.width, Math.max(left + 1, Math.ceil(rawLeft + rawWidth + padding)));
  const bottom = Math.min(image.height, Math.max(top + 1, Math.ceil(rawTop + rawHeight + padding)));
  return encodePng(transform(image, (photon) => crop(photon, left, top, right, bottom)));
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

function channelLevel(data: Uint8Array, index: number, channels: number[]): number {
  return channels.reduce((total, channel) => total + data[index + channel]!, 0) / channels.length;
}

function removeKeyedSpill(data: Uint8Array, index: number, keyedChannels: number[], neutralLevel: number) {
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

function removeResidualSpill(data: Uint8Array, keyedChannels: number[], neutralChannels: number[]) {
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const neutralLevel = channelLevel(data, index, neutralChannels);
    if (channelLevel(data, index, keyedChannels) - neutralLevel > 0) removeKeyedSpill(data, index, keyedChannels, neutralLevel);
  }
}

/** Makes a flat chroma-key background transparent, removes colour spill, and frames the garment on a square canvas. */
export function processChromaBackground(bytes: Uint8Array, key: string, tolerance = 46) {
  const feather = 80;
  const { target, keyedChannels, neutralChannels } = keyChannels(key);
  const image = decode(bytes);
  const { data } = image;
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
  const framed = frameTransparentGarment(image);
  removeResidualSpill(framed.data, keyedChannels, neutralChannels);
  return { bytes: encodePng(framed), verification: verifyNoChromaSpill(framed.data, key), tolerance };
}

export function removeChromaBackground(bytes: Uint8Array, key: string): Uint8Array {
  const result = processChromaBackground(bytes, key);
  if (result.verification.contaminatedPixels > 1) {
    throw new Error(`Background cleanup left ${result.verification.contaminatedPixels} chroma-contaminated pixels`);
  }
  return result.bytes;
}

/** Converts between straight and premultiplied alpha so resizing doesn't bleed transparent pixels' colour into edges. */
function premultiply(data: Uint8Array, inverse = false) {
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3]!;
    if (alpha === 255) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = data[index + channel]!;
      data[index + channel] = inverse ? (alpha ? Math.min(255, Math.round((value * 255) / alpha)) : 0) : Math.round((value * alpha) / 255);
    }
  }
}

/** Trims to the visible garment, scales it to fill `occupancy` of a transparent square canvas, and centres it. */
export function frameTransparentGarment(image: RawImage, canvasSize = 1024, occupancy = 0.88): RawImage {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0, pixel = 0; index < image.data.length; index += 4, pixel += 1) {
    if (image.data[index + 3]! <= 8) continue;
    const x = pixel % image.width;
    const y = Math.floor(pixel / image.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error("Background removal did not leave a visible garment");

  const trimmedWidth = maxX - minX + 1;
  const trimmedHeight = maxY - minY + 1;
  const targetSize = Math.max(1, Math.round(canvasSize * Math.max(0.5, Math.min(0.96, occupancy))));
  const scale = Math.min(targetSize / trimmedWidth, targetSize / trimmedHeight);
  const width = Math.max(1, Math.round(trimmedWidth * scale));
  const height = Math.max(1, Math.round(trimmedHeight * scale));

  premultiply(image.data);
  const resized = transform(image, (photon) => {
    const trimmed = crop(photon, minX, minY, maxX + 1, maxY + 1);
    try {
      return resize(trimmed, width, height, SamplingFilter.Lanczos3);
    } finally {
      trimmed.free();
    }
  });
  premultiply(resized.data, true);

  const canvas = new Uint8Array(canvasSize * canvasSize * 4);
  const left = Math.floor((canvasSize - width) / 2);
  const top = Math.floor((canvasSize - height) / 2);
  for (let row = 0; row < height; row += 1) {
    canvas.set(resized.data.subarray(row * width * 4, (row + 1) * width * 4), ((top + row) * canvasSize + left) * 4);
  }
  return { data: canvas, width: canvasSize, height: canvasSize };
}

function verifyNoChromaSpill(data: Uint8Array, key: string): ChromaVerification {
  const { keyedChannels, neutralChannels } = keyChannels(key);
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
