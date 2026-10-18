import { createWardrobeClient } from "@wardrobe/core";

/**
 * API client for the CLIs. Bun loads .env from the working directory, so run them from the repo root.
 * Requests pass Cloudflare Access with a service token (CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET).
 */
export function apiClient() {
  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  return createWardrobeClient({
    baseUrl: process.env.WARDROBE_API_URL || "https://wardrobe.capon.io",
    headers: clientId && clientSecret ? { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret } : {},
  });
}
