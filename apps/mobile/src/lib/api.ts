import { createWardrobeClient } from "@wardrobe/core";
import Constants from "expo-constants";
import type { ImageSource } from "expo-image";

/**
 * The Wardrobe API: EXPO_PUBLIC_API_URL when set; in development, the computer running Expo
 * (where `bun run dev` serves the API on port 4747); otherwise the deployed app.
 */
function serverUrl(): string {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL;
  const host = Constants.expoConfig?.hostUri?.split(":")[0];
  return __DEV__ && host ? `http://${host}:4747` : "https://wardrobe.capon.io";
}

/** The deployed API sits behind Cloudflare Access; the app passes with a service token. */
const clientId = process.env.EXPO_PUBLIC_CF_ACCESS_CLIENT_ID;
const clientSecret = process.env.EXPO_PUBLIC_CF_ACCESS_CLIENT_SECRET;

export const api = createWardrobeClient({
  baseUrl: serverUrl(),
  headers: clientId && clientSecret ? { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret } : {},
});

/** An expo-image source for an API image path, with the same credentials as API requests. */
export const imageSource = (path: string): ImageSource => ({ uri: api.assetUrl(path), headers: api.headers });
