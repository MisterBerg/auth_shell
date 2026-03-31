import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler"]],
      },
    }),
  ],
  resolve: {
    alias: {
      // Resolve the module-core workspace package directly from source
      // so Vite handles transpilation — no separate build step needed.
      "module-core": path.resolve(__dirname, "../module-core/src/index.ts"),
      "app-landing": path.resolve(__dirname, "../app-landing/src/index.tsx"),
    },
  },
});
