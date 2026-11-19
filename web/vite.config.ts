import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from GitHub Pages at /bitgate/.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // Libraries change far less often than the app, so they get their own
        // chunks and stay cached in the browser across deploys.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@stellar")) return "stellar";
          if (id.includes("react")) return "react";
          if (id.includes("@scure") || id.includes("@noble") || id.includes("bech32")) return "bitcoin";
          return "vendor";
        },
      },
    },
  },
});
