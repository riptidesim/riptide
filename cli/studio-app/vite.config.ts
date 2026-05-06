import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(here, "..", "assets", "studio"),
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: undefined
      }
    }
  },
  base: "./",
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:4173",
      "/dashboard": "http://127.0.0.1:4173"
    }
  }
});
