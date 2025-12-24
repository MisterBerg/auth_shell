// src/auth/AuthGate.tsx
import React, { useEffect, Suspense, useMemo } from "react";
import { useConfigStore } from "../stores/configStore";
import { useAuthStore } from "../stores/authStore";
import { CONFIG } from "../config";
import { initAuthShell } from "./googleCognito";
import { createRemoteReactAppLoader } from "../remote/loadRemoteAppFromS3";
import { getRemoteAppConfigFromUrl } from "../remote/urlConfig";

export const AuthGate: React.FC = () => {
  const { config, setConfig } = useConfigStore();
  const { isSignedIn, awsCredentialProvider, loading, error, signInWithMicrosoft } =
    useAuthStore();

  // One-time init of config + auth shell
  useEffect(() => {
    if (!config) {
      setConfig(CONFIG);
      initAuthShell({ config: CONFIG });
    }
  }, [config, setConfig]);

  const remoteAppConfig = useMemo(
    () => getRemoteAppConfigFromUrl(),
    []
  );

  const ready = isSignedIn && !!awsCredentialProvider && !!remoteAppConfig;

  const LazyRemoteApp = useMemo(() => {
    if (!ready || !remoteAppConfig) return null;
    const loader = createRemoteReactAppLoader(remoteAppConfig);
    return React.lazy(loader);
  }, [ready, remoteAppConfig]);

  if (!remoteAppConfig) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div>
          <h1 style={{ marginBottom: "0.5rem" }}>Missing app destination</h1>
          <p style={{ fontSize: "0.9rem" }}>
            Please specify <code>?bucket=…&amp;key=…</code> in the URL.
          </p>
        </div>
      </div>
    );
  }

  if (!ready || !LazyRemoteApp) {
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
        Sign in to continue to the requested application.
      </p>

      {/* Google button container (rendered by googleCognito.ts) */}
      <div
        id="google-signin-container"
        style={{ marginBottom: "0.75rem" }}
      />

      {/* Microsoft sign-in placeholder */}
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
          Loading application…
        </div>
      }
    >
      <LazyRemoteApp />
    </Suspense>
  );
};
