import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mockApiPath = path.resolve(here, "src", "studioMockApi.ts");
const studioSrc = path.resolve(here, "..", "cli", "studio-app", "src");
const demoNodeModules = path.resolve(here, "node_modules");

export default defineConfig({
  plugins: [
    react(),
    {
      name: "static-demo-studio-overrides",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer) return null;
        const normalizedImporter = importer.split(path.sep).join("/");
        if (!normalizedImporter.includes("/cli/studio-app/src/")) return null;
        if (source === "./api" || source === "../api" || source === "./api.ts" || source === "../api.ts") {
          return mockApiPath;
        }
        return null;
      },
      transform(code, id) {
        if (!id.split(path.sep).join("/").includes("/cli/studio-app/src/styles.css")) return null;
        return code.replace(/@import\s+url\(["'][^"']+["']\);\s*/g, "");
      }
    }
  ],
  publicDir: path.resolve(here, "..", "cli", "studio-app", "public"),
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      {
        find: /^react$/,
        replacement: path.resolve(demoNodeModules, "react")
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: path.resolve(demoNodeModules, "react", "jsx-runtime.js")
      },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: path.resolve(demoNodeModules, "react", "jsx-dev-runtime.js")
      },
      {
        find: /^react-dom$/,
        replacement: path.resolve(demoNodeModules, "react-dom")
      },
      {
        find: /^react-dom\/client$/,
        replacement: path.resolve(demoNodeModules, "react-dom", "client.js")
      },
      {
        find: path.resolve(studioSrc, "api.ts"),
        replacement: mockApiPath
      }
    ]
  },
  base: "./",
  build: {
    outDir: path.resolve(here, "dist"),
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
  server: {
    host: "127.0.0.1",
    port: 5175,
    fs: {
      allow: [here, path.resolve(here, "..")]
    }
  },
  preview: {
    host: "127.0.0.1",
    port: 4175
  }
});
