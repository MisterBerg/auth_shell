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
      "module-core": path.resolve(__dirname, "../../core/src/index.ts"),
      "app-landing": path.resolve(__dirname, "../landing/src/index.tsx"),
    },
  },
  server: {
    proxy: {
      // Proxy DynamoDB Local requests to avoid CORS issues.
      // S3 (MinIO) is accessed directly — buckets are set to public for local dev,
      // which avoids the request-signing path mismatch that a proxy would cause.
      "/__local_ddb": {
        target: "http://localhost:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__local_ddb/, ""),
      },
    },
  },
});
