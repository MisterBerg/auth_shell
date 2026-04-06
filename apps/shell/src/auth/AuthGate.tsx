import React, { useEffect, useState, useRef, Suspense, useMemo, Component, type ErrorInfo, type ReactNode } from "react";
import { loadModule } from "module-core";
import type { ModuleConfig } from "module-core";
import { useConfigStore } from "../stores/configStore.ts";
import { useAuthStore } from "../stores/authStore.ts";
import { useAwsS3Client } from "module-core";
import { useRegisterResources } from "module-core";
import { CONFIG } from "../config.ts";
import { initAuthShell } from "./googleCognito.ts";
import { getModuleLocationFromUrl } from "../remote/urlConfig.ts";
import { EditModeBar } from "./EditModeBar.tsx";

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

function getCurrentModuleLocation() {
  const fromUrl = getModuleLocationFromUrl();
  if (fromUrl) return { ...fromUrl, isDefault: false };
  return {
    bucket: CONFIG.defaultAppBucket,
    configPath: CONFIG.defaultAppConfigPath,
    isDefault: true,
  };
}

export const AuthGate: React.FC = () => {
  const { config, setConfig } = useConfigStore();
  const { isSignedIn, awsCredentialProvider, loading, error, signInWithMicrosoft } =
    useAuthStore();
  const getS3Client = useAwsS3Client();
  const registerResources = useRegisterResources();

  const getS3ClientRef = useRef(getS3Client);
  const registerResourcesRef = useRef(registerResources);
  useEffect(() => {
    getS3ClientRef.current = getS3Client;
    registerResourcesRef.current = registerResources;
  });

  const [moduleLocation, setModuleLocation] = useState(getCurrentModuleLocation);
  // Resolved root config — passed to EditModeBar so it can write root replacements
  const [rootConfig, setRootConfig] = useState<ModuleConfig | null>(null);

  useEffect(() => {
    if (!config) {
      setConfig(CONFIG);
      initAuthShell({ config: CONFIG });
    }
  }, [config, setConfig]);

  useEffect(() => {
    const onPopState = () => setModuleLocation(getCurrentModuleLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const onNavigate = () => {
      setModuleLocation(getCurrentModuleLocation());
      setRootConfig(null); // clear stale config until new module resolves
    };
    window.addEventListener("shell:navigate", onNavigate);
    return () => window.removeEventListener("shell:navigate", onNavigate);
  }, []);

  const ready = isSignedIn && !!awsCredentialProvider;

  const LazyApp = useMemo(() => {
    if (!ready) return null;

    const { bucket, configPath, isDefault } = moduleLocation;
    const useDevAlias = isDefault && import.meta.env.DEV;

    return React.lazy(async (): Promise<{ default: React.ComponentType }> => {
      if (useDevAlias) {
        const { default: LandingApp } = await import("app-landing");
        const devConfig: ModuleConfig = {
          id: "app-landing-dev",
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
      // Surface the resolved config so EditModeBar can perform root replacement
      setRootConfig(moduleConfig);
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
  const showEditBar = !moduleLocation.isDefault;

  return (
    <>
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

      {showEditBar && <EditModeBar rootConfig={rootConfig} />}
    </>
  );
};
