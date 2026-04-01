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
  server: {
    proxy: {
      // Proxy local S3 (MinIO) and DynamoDB requests through the dev server
      // so the browser never makes cross-origin requests — no CORS needed.
      "/__local_s3": {
        target: "http://localhost:9000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__local_s3/, ""),
      },
      "/__local_ddb": {
        target: "http://localhost:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__local_ddb/, ""),
      },
    },
  },
});
