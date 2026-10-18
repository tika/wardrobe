import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "");
  const apiTarget = `http://localhost:${env.PORT || 4747}`;
  return {
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      proxy: { "/api": apiTarget },
    },
    preview: {
      host: "0.0.0.0",
      port: 4173,
      allowedHosts: ["localhost"],
      proxy: { "/api": apiTarget },
    },
    plugins: [react()],
  };
});
