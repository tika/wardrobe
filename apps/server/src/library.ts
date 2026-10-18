import { randomUUID } from "node:crypto";
import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { HEX_COLOR, isPart, type ItemEdit, type WardrobeItem } from "@wardrobe/core";

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}

export async function atomicJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await rename(tmp, file);
  } catch (error) {
    if (!["EBUSY", "EXDEV", "EPERM"].includes((error as NodeJS.ErrnoException).code || "")) {
      await rm(tmp, { force: true });
      throw error;
    }
    await copyFile(tmp, file);
    await rm(tmp, { force: true });
  }
}

export function libraryFile(dataDir: string) {
  return path.join(dataDir, "library.json");
}

export async function loadLibrary(dataDir: string): Promise<WardrobeItem[]> {
  return readJson<WardrobeItem[]>(libraryFile(dataDir), []);
}

export async function saveLibrary(dataDir: string, items: WardrobeItem[]): Promise<void> {
  await atomicJson(libraryFile(dataDir), items);
}

/** Validates a client edit, keeping only the editable fields that are well formed. */
export function normalizeEdit(input: unknown): Partial<ItemEdit> {
  const value = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const edit: Partial<ItemEdit> = {};
  if (typeof value.name === "string") edit.name = value.name.trim().slice(0, 120);
  if (isPart(value.part)) edit.part = value.part;
  if (typeof value.color === "string" && HEX_COLOR.test(value.color)) edit.color = value.color.toLowerCase();
  if (value.secondaryColor === null || value.secondaryColor === "") edit.secondaryColor = null;
  else if (typeof value.secondaryColor === "string" && HEX_COLOR.test(value.secondaryColor)) edit.secondaryColor = value.secondaryColor.toLowerCase();
  if (Array.isArray(value.tags)) {
    edit.tags = value.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean).slice(0, 12);
  }
  return edit;
}
