import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "module-core": path.resolve(__dirname, "../../core/src/index.ts"),
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
      external: ["react", "react/jsx-runtime", "react-dom", "module-core"],
      output: {
        exports: "named",
        globals: {
          react: "__React",
          "react/jsx-runtime": "__ReactJsxRuntime",
          "react-dom": "__ReactDOM",
          "module-core": "__ModuleCore",
        },
      },
    },
  },
});
