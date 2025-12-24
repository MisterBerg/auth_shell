// src/boot-shell.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { AuthGate } from "./auth/AuthGate";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element #root not found");

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AuthGate />
  </React.StrictMode>
);
