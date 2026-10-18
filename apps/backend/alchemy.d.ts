// alchemy.run.ts runs under Bun (not the Worker runtime), so it needs the
// Node-style `process` global that the Workers `types` config doesn't provide.
declare var process: {
  env: Record<string, string | undefined>;
};
