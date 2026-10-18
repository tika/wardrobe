import { defineConfig } from "drizzle-kit";

// Generates SQL migrations from the schema; Alchemy applies them to D1 on deploy.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
});
