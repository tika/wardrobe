import { createWardrobeClient } from "@wardrobe/core";

/** The web app is served from the same origin as the API (directly, or through the Vite proxy). */
export const api = createWardrobeClient();
