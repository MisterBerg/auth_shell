import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * module-template vite config — copy this when starting a new module.
 *
 * Builds a self-contained ES module that exports a default React component.
 * React and module-core are externalized so the shell provides them at runtime.
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
            external: ["react", "react/jsx-runtime", "react-dom", "module-core"],
          },
        }
      : undefined,
}));
