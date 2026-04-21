/**
 * Dev-only entry point. Mounts the landing app with stub context providers
 * so it can be developed and tested without the shell app or real AWS.
 *
 * This file is NOT included in the production bundle (vite lib mode uses
 * src/index.tsx as the entry). It is only served by `vite dev`.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { AuthProvider, ResourceRegistryProvider, EditModeProvider } from "module-core";
import type { AuthContextValue, ModuleConfig } from "module-core";
import LandingApp from "./index.tsx";

const mockAuthValue: AuthContextValue = {
  awsCredentialProvider: () =>
    Promise.resolve({
      accessKeyId: "DEV_KEY",
      secretAccessKey: "DEV_SECRET",
      sessionToken: "DEV_TOKEN",
    }),
  userProfile: {
    name: "Dev User",
    email: "dev@example.com",
    picture: "https://ui-avatars.com/api/?name=Dev+User&background=3b82f6&color=fff",
  },
  signOut: () => console.info("[dev] signOut called"),
  getS3Client: () => Promise.reject(new Error("S3 not available in dev harness")),
  getDdbClient: () => Promise.reject(new Error("DynamoDB not available in dev harness")),
};

const mockConfig: ModuleConfig = {
  id: "app-landing-dev",
  app: { bucket: "dev-bucket", key: "apps/landing/bundle.js" },
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ResourceRegistryProvider>
      <EditModeProvider>
        <AuthProvider {...mockAuthValue}>
          <LandingApp config={mockConfig} />
        </AuthProvider>
      </EditModeProvider>
    </ResourceRegistryProvider>
  </React.StrictMode>
);
