import React, { useEffect, Suspense, useMemo } from "react";
import { loadModule } from "module-core";
import { useConfigStore } from "../stores/configStore.ts";
import { useAuthStore } from "../stores/authStore.ts";
import { useAwsS3Client } from "module-core";
import { useRegisterResources } from "module-core";
import { CONFIG } from "../config.ts";
import { initAuthShell } from "./googleCognito.ts";
import { getModuleLocationFromUrl } from "../remote/urlConfig.ts";
import type { ModuleConfig } from "module-core";

/**
 * AuthGate orchestrates the top-level load sequence:
 *
 * 1. Initialise auth (Google GIS + Cognito) on first render.
 * 2. Show sign-in UI until the user is authenticated.
 * 3. Resolve the module to load:
 *      - If ?bucket=&config= present → load that module
 *      - Otherwise              → load the default org landing page
 * 4. Two-step load via module-core's loadModule():
 *      a. Fetch config.json from S3
 *      b. Fetch and dynamic-import the JS bundle
 * 5. Render the loaded component inside a Suspense boundary.
 */
export const AuthGate: React.FC = () => {
  const { config, setConfig } = useConfigStore();
  const { isSignedIn, awsCredentialProvider, loading, error, signInWithMicrosoft } =
    useAuthStore();
  const getS3Client = useAwsS3Client();
  const registerResources = useRegisterResources();

  // One-time shell init
  useEffect(() => {
    if (!config) {
      setConfig(CONFIG);
      initAuthShell({ config: CONFIG });
    }
  }, [config, setConfig]);

  // Resolve which module to load from URL or fall back to default
  const moduleLocation = useMemo(() => {
    const fromUrl = getModuleLocationFromUrl();
    if (fromUrl) return fromUrl;
    return {
      bucket: CONFIG.defaultAppBucket,
      configPath: CONFIG.defaultAppConfigPath,
    };
  }, []);

  const ready = isSignedIn && !!awsCredentialProvider;

  // Build the lazy component once auth is ready and the location is known
  const LazyApp = useMemo(() => {
    if (!ready) return null;

    const isDefaultApp =
      !getModuleLocationFromUrl() &&
      import.meta.env.DEV;

    return React.lazy(async (): Promise<{ default: React.ComponentType }> => {
      // Dev-mode shortcut: load app-landing directly from source instead of S3
      // so the default landing page works without a deployed bucket.
      if (isDefaultApp) {
        const { default: LandingApp } = await import("app-landing");
        const devConfig: ModuleConfig = {
          id: "app-landing-dev",
          app: { bucket: "dev", key: "bundle.js" },
        };
        const Bound = () => <LandingApp config={devConfig} />;
        Bound.displayName = "RootModule[dev]";
        return { default: Bound };
      }

      const s3 = await getS3Client();
      const { config: moduleConfig, Component } = await loadModule(
        moduleLocation.bucket,
        moduleLocation.configPath,
        s3,
        registerResources
      );
      const Bound = () => <Component config={moduleConfig as ModuleConfig} />;
      Bound.displayName = "RootModule";
      return { default: Bound };
    });
  }, [ready, moduleLocation, getS3Client, registerResources]);

  // Sign-in screen (shown until authenticated)
  if (!ready || !LazyApp) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#0b1120",
          color: "#e5e7eb",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", marginBottom: "0.75rem" }}>
          Org Auth Shell
        </h1>
        <p style={{ marginBottom: "1.5rem", textAlign: "center" }}>
          Sign in to continue.
        </p>

        {/* Google button rendered by googleCognito.ts */}
        <div id="google-signin-container" style={{ marginBottom: "0.75rem" }} />

        <button
          onClick={signInWithMicrosoft}
          disabled={loading}
          style={{
            padding: "0.6rem 1.1rem",
            borderRadius: "999px",
            border: "1px solid #4b5563",
            cursor: "pointer",
            fontWeight: 500,
            fontSize: "0.95rem",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.5rem",
            background: "transparent",
            color: "#e5e7eb",
            minWidth: "220px",
            marginTop: "0.5rem",
          }}
        >
          Sign in with Microsoft (soon)
        </button>

        {error && (
          <div
            style={{
              marginTop: "1rem",
              fontSize: "0.85rem",
              color: "#fca5a5",
              textAlign: "center",
              maxWidth: "20rem",
            }}
          >
            {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#020617",
            color: "#e5e7eb",
          }}
        >
          Loading…
        </div>
      }
    >
      <LazyApp />
    </Suspense>
  );
};
