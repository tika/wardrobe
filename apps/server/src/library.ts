import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WardrobeItem } from "@wardrobe/core";
import writeFileAtomic from "write-file-atomic";

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}

export function writeJson(file: string, value: unknown): Promise<void> {
  return writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

const libraryFile = (dataDir: string) => path.join(dataDir, "library.json");

export const loadLibrary = (dataDir: string) => readJson<WardrobeItem[]>(libraryFile(dataDir), []);
export const saveLibrary = (dataDir: string, items: WardrobeItem[]) => writeJson(libraryFile(dataDir), items);
