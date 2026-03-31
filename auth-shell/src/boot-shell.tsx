import React from "react";
import ReactDOM from "react-dom/client";
import { AuthProvider, ResourceRegistryProvider, EditModeProvider } from "module-core";
import type { AuthContextValue } from "module-core";
import { AuthGate } from "./auth/AuthGate.tsx";
import { useAuthStore } from "./stores/authStore.ts";
import { getAwsClients } from "./aws/awsClients.ts";

/**
 * Bridges the Zustand auth store into the module-core AuthContext so every
 * module in the tree can call useAwsS3Client(), useUserProfile(), etc.
 * without knowing anything about auth-shell's internals.
 */
function ShellAuthProvider({ children }: { children: React.ReactNode }) {
  const { awsCredentialProvider, userProfile } = useAuthStore();
  const { getS3Client, getDdbDocClient } = getAwsClients();

  const authValue: AuthContextValue = {
    awsCredentialProvider:
      awsCredentialProvider ?? (() => Promise.reject(new Error("Not signed in"))),
    userProfile,
    getS3Client,
    getDdbClient: getDdbDocClient,
  };

  return <AuthProvider {...authValue}>{children}</AuthProvider>;
}

/**
 * Expose shell-provided singletons on window.__SHELL_DEPS__ so modules built
 * outside this monorepo can treat React and module-core as externals.
 */
import("module-core")
  .then((moduleCore) => {
    (window as unknown as Record<string, unknown>)["__SHELL_DEPS__"] = {
      React,
      ReactDOM,
      moduleCore,
    };
  })
  .catch((e) => console.warn("[shell] Failed to expose __SHELL_DEPS__:", e));

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
