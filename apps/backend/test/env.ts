import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bindings, GenerateParams } from "../src/env";

/**
 * Test doubles for the Worker's bindings. D1 is real SQLite (bun:sqlite) running the
 * generated migrations, so Drizzle's queries run for real; R2 and Workflows are small
 * in-memory fakes.
 */

type Value = string | number | null | boolean | bigint | Uint8Array;

class Statement {
  constructor(private readonly db: Database, readonly sql: string, private readonly params: Value[] = []) {}

  bind(...params: Value[]) {
    return new Statement(this.db, this.sql, params.map((param) => (typeof param === "boolean" ? Number(param) : param)));
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.query(this.sql).get(...(this.params as never[])) as Record<string, unknown> | null;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async all<T>() {
    return { results: this.db.query(this.sql).all(...(this.params as never[])) as T[], success: true, meta: {} };
  }

  async raw<T>() {
    return this.db.query(this.sql).values(...(this.params as never[])) as T[];
  }

  async run() {
    const result = this.db.query(this.sql).run(...(this.params as never[]));
    return { success: true, results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
  }
}

export function createD1() {
  const db = new Database(":memory:");
  const dir = join(import.meta.dir, "../migrations");
  for (const migration of readdirSync(dir).sort()) {
    for (const statement of readFileSync(join(dir, migration, "migration.sql"), "utf8").split("--> statement-breakpoint")) db.run(statement);
  }
  return {
    prepare: (sql: string) => new Statement(db, sql),
    batch: async (statements: Statement[]) => Promise.all(statements.map((statement) => statement.all())),
    exec: async (sql: string) => {
      db.run(sql);
      return { count: 1, duration: 0 };
    },
  };
}

export function createR2() {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const object = (key: string, value: { bytes: Uint8Array; contentType?: string }) => ({
    key,
    httpEtag: `"${key}"`,
    httpMetadata: { contentType: value.contentType },
    body: new Blob([value.bytes]).stream(),
    arrayBuffer: async () => value.bytes.slice().buffer,
  });
  return {
    objects,
    async put(key: string, bytes: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes: new Uint8Array(bytes), contentType: options?.httpMetadata?.contentType });
    },
    async get(key: string) {
      const value = objects.get(key);
      return value ? object(key, value) : null;
    },
    async head(key: string) {
      return objects.has(key) ? { key } : null;
    },
    async delete(keys: string | string[]) {
      for (const key of [keys].flat()) objects.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

/** Records workflow instances instead of running them; tests run them explicitly. */
export function createWorkflow() {
  const created: { id: string; params: GenerateParams }[] = [];
  return {
    created,
    async create({ id, params }: { id: string; params: GenerateParams }) {
      created.push({ id, params });
      return { id };
    },
  };
}

export function createEnv() {
  const bucket = createR2();
  const generate = createWorkflow();
  const env = {
    DB: createD1(),
    BUCKET: bucket,
    GENERATE: generate,
    GEMINI_API_KEY: "test-key",
    GEMINI_IMAGE_MODEL: "gemini-3-pro-image",
    GEMINI_VISION_MODEL: "gemini-3.8-flash",
  } as unknown as Bindings;
  return { env, bucket, generate };
}
