import { createWardrobeClient } from "@wardrobe/core";
import Constants from "expo-constants";

/**
 * The Wardrobe server: EXPO_PUBLIC_API_URL when set, otherwise the computer running
 * the Expo dev server (the phone already reaches it on the LAN) on the default port.
 */
function serverUrl(): string {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL;
  const host = Constants.expoConfig?.hostUri?.split(":")[0] || "localhost";
  return `http://${host}:4747`;
}

export const api = createWardrobeClient({ baseUrl: serverUrl() });
