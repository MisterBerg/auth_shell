import React from "react";
import ReactDOM from "react-dom/client";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as moduleCore from "module-core";
import { AuthProvider, ResourceRegistryProvider, EditModeProvider } from "module-core";
import type { AuthContextValue } from "module-core";
import { AuthGate } from "./auth/AuthGate.tsx";
import { useAuthStore } from "./stores/authStore.ts";
import { getAwsClients } from "./aws/awsClients.ts";
import { CONFIG } from "./config.ts";

// Expose globals synchronously so IIFE module bundles can reference them
// before any module script executes. Each name matches the `globals` map
// in the module vite.config build options.
const win = window as unknown as Record<string, unknown>;
win["__React"] = React;
win["__ReactJsxRuntime"] = ReactJsxRuntime;
win["__ReactDOM"] = ReactDOM;
win["__ModuleCore"] = moduleCore;

function ShellAuthProvider({ children }: { children: React.ReactNode }) {
  const { awsCredentialProvider, userProfile, signOut } = useAuthStore();
  const { getS3Client, getDdbDocClient } = getAwsClients();

  const authValue: AuthContextValue = {
    awsCredentialProvider:
      awsCredentialProvider ?? (() => Promise.reject(new Error("Not signed in"))),
    userProfile,
    signOut,
    getS3Client,
    getDdbClient: getDdbDocClient,
    tables: CONFIG.tables,
  };

  return <AuthProvider {...authValue}>{children}</AuthProvider>;
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element #root not found");

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ResourceRegistryProvider>
      <EditModeProvider>
        <ShellAuthProvider>
          <AuthGate />
        </ShellAuthProvider>
      </EditModeProvider>
    </ResourceRegistryProvider>
  </React.StrictMode>
);
