// Copies the secrets Alchemy generated (the Access service token and the Gemini API key) from a
// deployed stage's state into the root .env (CLIs) and apps/mobile/.env (iOS app). Nothing is printed.
// Usage: bun run env:sync [stage]   (default: prod)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const stage = process.argv[2] ?? "prod";
const backend = path.resolve(import.meta.dir, "..");
const root = path.resolve(backend, "../..");

/** A resource's outputs, as `alchemy state read` returns them. */
function attributes(resource: string): Record<string, unknown> {
  const result = Bun.spawnSync(["bunx", "alchemy", "state", "read", `Wardrobe/${stage}/${resource}`, "--env-file", path.join(root, ".env")], {
    cwd: backend,
    env: { ...process.env, ALCHEMY_STAGE: stage },
  });
  if (result.exitCode !== 0) throw new Error(`Could not read ${resource} for stage "${stage}". Has it been deployed?`);
  return JSON.parse(result.stdout.toString()).attr;
}

/** State keeps redacted values as { __redacted__: value }. */
const reveal = (value: unknown): string => {
  const secret = value && typeof value === "object" && "__redacted__" in value ? (value as { __redacted__: unknown }).__redacted__ : value;
  if (typeof secret !== "string" || !secret) throw new Error("A generated secret is missing from state");
  return secret;
};

/** Sets each key in an env file, replacing existing lines and appending new ones. */
function updateEnv(file: string, values: Record<string, string>) {
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^#?\\s*${key}=.*$`, "m");
    text = pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
  }
  writeFileSync(file, text, { mode: 0o600 });
}

const token = attributes("AppToken");
const gemini = attributes("GeminiKey");
const clientId = reveal(token.clientId);
const clientSecret = reveal(token.clientSecret);

updateEnv(path.join(root, ".env"), { GEMINI_API_KEY: reveal(gemini.keyString), CF_ACCESS_CLIENT_ID: clientId, CF_ACCESS_CLIENT_SECRET: clientSecret });
updateEnv(path.join(root, "apps/mobile/.env"), { EXPO_PUBLIC_CF_ACCESS_CLIENT_ID: clientId, EXPO_PUBLIC_CF_ACCESS_CLIENT_SECRET: clientSecret });
console.log(`Updated .env and apps/mobile/.env from the ${stage} stage.`);
