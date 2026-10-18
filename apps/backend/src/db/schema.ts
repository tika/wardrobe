import type { ItemMetadata, Part, Stage, StageName } from "@wardrobe/core";
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Wardrobe pieces. Images live in R2 at library/{id}-garment.png and library/{id}-modeled.png. */
export const items = sqliteTable("items", {
  id: text().primaryKey(),
  name: text().notNull(),
  part: text().$type<Part>().notNull(),
  color: text().notNull(),
  secondaryColor: text(),
  palette: text({ mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  tags: text({ mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  hasModeled: integer({ mode: "boolean" }).notNull().default(false),
  importJobId: text().notNull(),
  createdAt: text().notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

/** Import jobs awaiting review; their images live in R2 under jobs/{id}/. */
export const jobs = sqliteTable("jobs", {
  id: text().primaryKey(),
  status: text().$type<"active" | "complete">().notNull(),
  metadata: text({ mode: "json" }).$type<ItemMetadata>().notNull(),
  stages: text({ mode: "json" }).$type<Record<StageName, Stage>>().notNull(),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
});
