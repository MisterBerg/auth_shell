import React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as ReactJsxRuntime from "react/jsx-runtime";
import { AuthGate } from "./auth/AuthGate.tsx";

// Expose globals synchronously so IIFE module bundles can reference them
// before any module script executes. Each name matches the `globals` map
// in the module vite.config build options.
const win = window as unknown as Record<string, unknown>;
win["__React"] = React;
win["__ReactJsxRuntime"] = ReactJsxRuntime;
win["__ReactDOM"] = ReactDOM;

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element #root not found");

ReactDOMClient.createRoot(rootElement).render(
  <React.StrictMode>
    <AuthGate />
  </React.StrictMode>
);
