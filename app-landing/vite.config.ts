import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * app-landing is built as a self-contained ES module bundle.
 * It exports a default React component conforming to ModuleProps.
 *
 * When deploying, upload dist/bundle.js and a config.json to S3.
 * The shell will load it when no ?config= URL param is present.
 *
 * React and module-core are marked as external so the shell's single
 * React instance is used at runtime via window.__SHELL_DEPS__.
 * For local dev (vite dev server), they are resolved normally.
 */
export default defineConfig(({ command }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      "module-core": path.resolve(__dirname, "../module-core/src/index.ts"),
    },
  },
  build:
    command === "build"
      ? {
          lib: {
            entry: path.resolve(__dirname, "src/index.tsx"),
            formats: ["es"],
            fileName: "bundle",
          },
          rollupOptions: {
            // Externalize shared deps — provided by the shell at runtime.
            external: ["react", "react/jsx-runtime", "react-dom", "module-core"],
          },
        }
      : undefined,
}));
