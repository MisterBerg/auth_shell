import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  resolve: {
    alias: {
      "module-core": path.resolve(__dirname, "../module-core/src/index.ts"),
    },
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/index.tsx"),
      formats: ["iife"],
      name: "RemoteModule",
      fileName: () => "bundle.js",
    },
    rollupOptions: {
      external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "module-core"],
      output: {
        exports: "named",
        globals: {
          "react": "__React",
          "react/jsx-runtime": "__ReactJsxRuntime",
          "react-dom": "__ReactDOM",
          "react-dom/client": "__ReactDOM",
          "module-core": "__ModuleCore",
        },
      },
    },
  },
});
