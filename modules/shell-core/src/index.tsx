import React, {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  Component,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  loadModule,
  useAwsS3Client,
  useEditMode,
  useRegisterResources,
  type ModuleConfig,
  type ModuleProps,
} from "module-core";

type ModuleLocation = {
  bucket: string;
  configPath: string;
  isDefault: boolean;
};

class ModuleErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ShellCore] Module load failed:", error, info);
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
          <strong>Failed to load module</strong>
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

function getModuleLocationFromUrl(): ModuleLocation | null {
  const params = new URLSearchParams(window.location.search);
  const bucket = params.get("bucket");
  const configPath = params.get("config");

  if (!bucket || !configPath) return null;

  return { bucket, configPath, isDefault: false };
}

function getCurrentModuleLocation(config: ModuleConfig): ModuleLocation {
  const fromUrl = getModuleLocationFromUrl();
  if (fromUrl) return fromUrl;

  return {
    bucket: (config.meta?.defaultAppBucket as string | undefined) ?? config.app.bucket,
    configPath: (config.meta?.defaultAppConfigPath as string | undefined) ?? "config.json",
    isDefault: true,
  };
}

function EditModeBar() {
  const { editMode, setEditMode } = useEditMode();

  return (
    <>
      <div
        style={{
          position: "fixed",
          bottom: 20,
          left: 20,
          zIndex: 1000,
          pointerEvents: "auto",
        }}
      >
        <button
          onClick={() => setEditMode(!editMode)}
          style={editMode ? doneButtonStyle : editButtonStyle}
          title={editMode ? "Exit interface editing" : "Edit the project interface"}
        >
          {editMode ? "Done" : "Edit Interface"}
        </button>
      </div>

      {editMode && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            background: "#3b82f6",
            zIndex: 999,
            pointerEvents: "none",
          }}
        />
      )}
    </>
  );
}

export default function ProtectedShellCore({ config }: ModuleProps) {
  const getS3Client = useAwsS3Client();
  const registerResources = useRegisterResources();

  const getS3ClientRef = useRef(getS3Client);
  const registerResourcesRef = useRef(registerResources);

  useEffect(() => {
    getS3ClientRef.current = getS3Client;
    registerResourcesRef.current = registerResources;
  });

  const [moduleLocation, setModuleLocation] = useState(() => getCurrentModuleLocation(config));

  useEffect(() => {
    const onPopState = () => setModuleLocation(getCurrentModuleLocation(config));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [config]);

  useEffect(() => {
    const onNavigate = () => setModuleLocation(getCurrentModuleLocation(config));
    window.addEventListener("shell:navigate", onNavigate);
    return () => window.removeEventListener("shell:navigate", onNavigate);
  }, [config]);

  const LazyApp = useMemo(() => {
    const { bucket, configPath } = moduleLocation;

    return React.lazy(async (): Promise<{ default: React.ComponentType }> => {
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
  }, [moduleLocation]);

  const locationKey = `${moduleLocation.bucket}/${moduleLocation.configPath}`;

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

      {!moduleLocation.isDefault && <EditModeBar />}
    </>
  );
}

const baseBtn: React.CSSProperties = {
  padding: "0.5rem 1rem",
  borderRadius: 8,
  border: "none",
  fontSize: "0.875rem",
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "system-ui, -apple-system, sans-serif",
  boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
};

const editButtonStyle: React.CSSProperties = {
  ...baseBtn,
  background: "rgba(15, 25, 41, 0.85)",
  color: "#9ca3af",
  border: "1px solid #1e2d40",
  backdropFilter: "blur(4px)",
};

const doneButtonStyle: React.CSSProperties = {
  ...baseBtn,
  background: "#2563eb",
  color: "#fff",
};
