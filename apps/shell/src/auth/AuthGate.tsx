import React, { Suspense, useEffect, useMemo, Component, type ErrorInfo, type ReactNode } from "react";
import { loadBundle } from "module-core";
import type { ModuleConfig } from "module-core";
import { useAwsS3Client } from "module-core";
import { useConfigStore } from "../stores/configStore.ts";
import { useAuthStore } from "../stores/authStore.ts";
import { CONFIG } from "../config.ts";
import { initAuthShell } from "./googleCognito.ts";

class ModuleErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[AuthGate] Protected shell-core load failed:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: "2rem",
            fontFamily: "monospace",
            color: "#fca5a5",
            background: "#0b1120",
            minHeight: "100vh",
          }}
        >
          <strong>Failed to load protected shell core</strong>
          <pre
            style={{
              marginTop: "1rem",
              fontSize: "0.8rem",
              whiteSpace: "pre-wrap",
            }}
          >
            {(this.state.error as Error).message}
          </pre>
        </div>
      );
    }

    return this.props.children;
  }
}

const shellCoreConfig: ModuleConfig = {
  id: "shell-core",
  app: {
    bucket: CONFIG.shellCoreBundle.bucket,
    key: CONFIG.shellCoreBundle.key,
  },
  meta: {
    defaultAppBucket: CONFIG.defaultAppBucket,
    defaultAppConfigPath: CONFIG.defaultAppConfigPath,
  },
};

export const AuthGate: React.FC = () => {
  const { config, setConfig } = useConfigStore();
  const { isSignedIn, awsCredentialProvider, loading, error, signInWithMicrosoft } =
    useAuthStore();
  const getS3Client = useAwsS3Client();

  useEffect(() => {
    if (!config) {
      setConfig(CONFIG);
      initAuthShell({ config: CONFIG });
    }
  }, [config, setConfig]);

  const ready = isSignedIn && !!awsCredentialProvider;

  const LazyShellCore = useMemo(() => {
    if (!ready) return null;

    return React.lazy(async (): Promise<{ default: React.ComponentType }> => {
      const Component = await loadBundle(
        CONFIG.shellCoreBundle.bucket,
        CONFIG.shellCoreBundle.key,
        getS3Client
      );

      const Bound = () => <Component config={shellCoreConfig} />;
      Bound.displayName = "ProtectedShellCore";
      return { default: Bound };
    });
  }, [getS3Client, ready]);

  if (!ready || !LazyShellCore) {
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

  return (
    <ModuleErrorBoundary>
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
            Loading protected shell…
          </div>
        }
      >
        <LazyShellCore />
      </Suspense>
    </ModuleErrorBoundary>
  );
};
