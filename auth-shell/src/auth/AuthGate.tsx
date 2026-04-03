import React, { useEffect, useState, useRef, Suspense, useMemo, Component, type ErrorInfo, type ReactNode } from "react";
import { loadModule } from "module-core";
import { useConfigStore } from "../stores/configStore.ts";
import { useAuthStore } from "../stores/authStore.ts";
import { useAwsS3Client } from "module-core";
import { useRegisterResources } from "module-core";
import { CONFIG } from "../config.ts";
import { initAuthShell } from "./googleCognito.ts";
import { getModuleLocationFromUrl } from "../remote/urlConfig.ts";
import type { ModuleConfig } from "module-core";

class ModuleErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[AuthGate] Module load failed:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "2rem", fontFamily: "monospace", color: "#fca5a5", background: "#0b1120", minHeight: "100vh" }}>
          <strong>Failed to load module</strong>
          <pre style={{ marginTop: "1rem", fontSize: "0.8rem", whiteSpace: "pre-wrap" }}>
            {(this.state.error as Error).message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Reads the current URL and returns the module location.
 * Called on every render so it always reflects the live URL.
 */
function getCurrentModuleLocation() {
  const fromUrl = getModuleLocationFromUrl();
  if (fromUrl) return { ...fromUrl, isDefault: false };
  return {
    bucket: CONFIG.defaultAppBucket,
    configPath: CONFIG.defaultAppConfigPath,
    isDefault: true,
  };
}

/**
 * AuthGate orchestrates the top-level load sequence:
 *
 * 1. Initialise auth (Google GIS + Cognito) on first render.
 * 2. Show sign-in UI until the user is authenticated.
 * 3. Resolve the module to load from URL params (or default).
 * 4. Navigate between modules via history.pushState — no page reloads,
 *    so the auth session is preserved in memory.
 * 5. Render the loaded component inside a Suspense boundary.
 */
export const AuthGate: React.FC = () => {
  const { config, setConfig } = useConfigStore();
  const { isSignedIn, awsCredentialProvider, loading, error, signInWithMicrosoft } =
    useAuthStore();
  const getS3Client = useAwsS3Client();
  const registerResources = useRegisterResources();

  // Stable refs so the LazyApp useMemo doesn't fire on every render
  // (getS3Client and registerResources are new references each render)
  const getS3ClientRef = useRef(getS3Client);
  const registerResourcesRef = useRef(registerResources);
  useEffect(() => {
    getS3ClientRef.current = getS3Client;
    registerResourcesRef.current = registerResources;
  });

  // Track the current URL location as state so navigation triggers re-render
  const [moduleLocation, setModuleLocation] = useState(getCurrentModuleLocation);

  // One-time shell init
  useEffect(() => {
    if (!config) {
      setConfig(CONFIG);
      initAuthShell({ config: CONFIG });
    }
  }, [config, setConfig]);

  // Listen for browser back/forward navigation
  useEffect(() => {
    const onPopState = () => setModuleLocation(getCurrentModuleLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Listen for in-app navigation dispatched by modules (e.g. Jeffspace opening a project)
  useEffect(() => {
    const onNavigate = () => setModuleLocation(getCurrentModuleLocation());
    window.addEventListener("shell:navigate", onNavigate);
    return () => window.removeEventListener("shell:navigate", onNavigate);
  }, []);

  const ready = isSignedIn && !!awsCredentialProvider;

  // Build the lazy component whenever auth becomes ready or the location changes
  const LazyApp = useMemo(() => {
    if (!ready) return null;

    const { bucket, configPath, isDefault } = moduleLocation;
    const useDevAlias = isDefault && import.meta.env.DEV;

    return React.lazy(async (): Promise<{ default: React.ComponentType }> => {
      // Dev-mode shortcut: load app-landing directly from source instead of S3
      // so the default landing page works without a deployed bucket.
      if (useDevAlias) {
        const { default: LandingApp } = await import("app-landing");
        const devConfig: ModuleConfig = {
          id: "app-landing-dev",
          // Use the same local bucket names as the seed script so that
          // isLocalBucket() routes writes to MinIO rather than real AWS.
          app: { bucket: "hep-dev-registry", key: "bundle.js" },
          meta: { projectsBucket: "hep-dev-modules" },
        };
        const Bound = () => <LandingApp config={devConfig} />;
        Bound.displayName = "RootModule[dev]";
        return { default: Bound };
      }

      const { config: moduleConfig, Component } = await loadModule(
        bucket,
        configPath,
        getS3ClientRef.current,
        registerResourcesRef.current
      );
      const Bound = () => <Component config={moduleConfig as ModuleConfig} />;
      Bound.displayName = "RootModule";
      return { default: Bound };
    });
  }, [ready, moduleLocation]);

  // Sign-in screen
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

  const locationKey = `${moduleLocation.bucket}/${moduleLocation.configPath}`;

  return (
    <ModuleErrorBoundary key={locationKey}>
      <Suspense
        key={locationKey}
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
    </ModuleErrorBoundary>
  );
};
