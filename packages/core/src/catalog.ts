import type { Part } from "./types";

export interface PartInfo {
  id: Part;
  label: string;
  singular: string;
}

export const PARTS: readonly PartInfo[] = [
  { id: "upperbody", label: "Tops", singular: "Top" },
  { id: "wholebody_up", label: "Jackets", singular: "Jacket" },
  { id: "lowerbody", label: "Bottoms", singular: "Bottom" },
  { id: "accessories_up", label: "Accessories", singular: "Accessory" },
  { id: "shoes", label: "Shoes", singular: "Shoes" },
];

export const PART_IDS: readonly Part[] = PARTS.map((part) => part.id);
export const PART_MAP = Object.fromEntries(PARTS.map((part) => [part.id, part])) as Record<Part, PartInfo>;
export const PART_ORDER = Object.fromEntries(PARTS.map((part, index) => [part.id, index])) as Record<Part, number>;

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function isPart(value: unknown): value is Part {
  return typeof value === "string" && (PART_IDS as readonly string[]).includes(value);
}

export function sortItems<T extends { id: string; part: Part }>(items: T[], byPart = true): T[] {
  return [...items].sort((a, b) => {
    if (byPart) {
      const typeDifference = (PART_ORDER[a.part] ?? 99) - (PART_ORDER[b.part] ?? 99);
      if (typeDifference) return typeDifference;
    }
    return a.id.localeCompare(b.id);
  });
}
