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
import * as moduleCore from "module-core";
import {
  AuthProvider,
  EditModeProvider,
  ResourceRegistryProvider,
  loadModule,
  useEditMode,
  useRegisterResources,
  type AuthContextValue,
  type ModuleConfig,
} from "module-core";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";

declare global {
  interface Window {
    __ModuleCore?: unknown;
  }
}

window.__ModuleCore = moduleCore;

type UserProfile = {
  email?: string;
  name?: string;
  picture?: string;
};

type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
};

type ShellConfig = {
  region: string;
  defaultAppBucket: string;
  defaultAppConfigPath: string;
  tables: {
    registry: string;
    projects: string;
  };
};

type PublicRuntimeEnv = {
  isLocalDev: boolean;
  localBuckets: string[];
  localS3Endpoint?: string;
  localDdbEndpoint?: string;
  localAccessKeyId?: string;
  localSecretAccessKey?: string;
  localRegion?: string;
};

type ProtectedShellCoreProps = {
  shellConfig: ShellConfig;
  auth: {
    awsCredentialProvider: () => Promise<AwsCredentials>;
    userProfile?: UserProfile;
    signOut: () => void;
  };
  runtimeEnv: PublicRuntimeEnv;
};

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

function getCurrentModuleLocation(config: ShellConfig): ModuleLocation {
  const fromUrl = getModuleLocationFromUrl();
  if (fromUrl) return fromUrl;

  return {
    bucket: config.defaultAppBucket,
    configPath: config.defaultAppConfigPath,
    isDefault: true,
  };
}

function isLocalBucket(runtimeEnv: PublicRuntimeEnv, bucket?: string): boolean {
  return Boolean(bucket) && runtimeEnv.localBuckets.includes(bucket!);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installAutoResetOnAuthError(client: any, signOut: () => void) {
  client.middlewareStack.addRelativeTo(
    (next: (args: unknown) => Promise<unknown>) => async (args: unknown) => {
      try {
        return await next(args);
      } catch (err: unknown) {
        const code = (err as { name?: string; Code?: string; code?: string })?.name
          ?? (err as { Code?: string })?.Code
          ?? (err as { code?: string })?.code;

        if (
          code === "ExpiredTokenException" ||
          code === "UnrecognizedClientException" ||
          code === "InvalidIdentityTokenException" ||
          code === "NotAuthorizedException"
        ) {
          console.warn("[ShellCore] Auth error — signing out", err);
          signOut();
        }
        throw err;
      }
    },
    {
      relation: "after",
      toMiddleware: "awsAuthMiddleware",
      name: "autoResetOnAuthError",
      override: true,
    }
  );
}

function createAwsClients(
  config: ShellConfig,
  runtimeEnv: PublicRuntimeEnv,
  awsCredentialProvider: () => Promise<AwsCredentials>,
  signOut: () => void
) {
  let remoteDdbClient: DynamoDBDocumentClient | null = null;
  let localDdbClient: DynamoDBDocumentClient | null = null;
  const s3ClientCache = new Map<string, S3Client>();

  return {
    getDdbDocClient: async () => {
      const useLocal = runtimeEnv.isLocalDev && Boolean(runtimeEnv.localDdbEndpoint);

      if (useLocal) {
        if (!localDdbClient) {
          const raw = new DynamoDBClient({
            region: runtimeEnv.localRegion ?? "us-east-1",
            endpoint: runtimeEnv.localDdbEndpoint,
            credentials: runtimeEnv.localAccessKeyId
              ? {
                  accessKeyId: runtimeEnv.localAccessKeyId,
                  secretAccessKey: runtimeEnv.localSecretAccessKey ?? "",
                }
              : { accessKeyId: "local", secretAccessKey: "local" },
          });
          localDdbClient = DynamoDBDocumentClient.from(raw, {
            marshallOptions: { removeUndefinedValues: true },
          });
        }
        return localDdbClient;
      }

      if (!remoteDdbClient) {
        const raw = new DynamoDBClient({
          region: config.region,
          credentials: awsCredentialProvider,
        });
        installAutoResetOnAuthError(raw, signOut);
        remoteDdbClient = DynamoDBDocumentClient.from(raw, {
          marshallOptions: { removeUndefinedValues: true },
        });
      }
      return remoteDdbClient;
    },

    getS3Client: async (bucket?: string) => {
      const useLocal =
        runtimeEnv.isLocalDev &&
        Boolean(runtimeEnv.localS3Endpoint) &&
        isLocalBucket(runtimeEnv, bucket);

      const cacheKey = useLocal ? `local:${runtimeEnv.localS3Endpoint}` : "remote";
      const cached = s3ClientCache.get(cacheKey);
      if (cached) return cached;

      let client: S3Client;

      if (useLocal) {
        client = new S3Client({
          region: runtimeEnv.localRegion ?? "us-east-1",
          endpoint: runtimeEnv.localS3Endpoint,
          credentials: runtimeEnv.localAccessKeyId
            ? {
                accessKeyId: runtimeEnv.localAccessKeyId,
                secretAccessKey: runtimeEnv.localSecretAccessKey ?? "",
              }
            : { accessKeyId: "local", secretAccessKey: "local" },
          forcePathStyle: true,
          requestChecksumCalculation: "WHEN_REQUIRED",
          responseChecksumValidation: "WHEN_REQUIRED",
        });
      } else {
        const s3Config: S3ClientConfig = {
          region: config.region,
          credentials: awsCredentialProvider,
        };
        client = new S3Client(s3Config);
        installAutoResetOnAuthError(client, signOut);
      }

      s3ClientCache.set(cacheKey, client);
      return client;
    },
  };
}

function ShellAuthProvider({
  shellConfig,
  auth,
  runtimeEnv,
  children,
}: ProtectedShellCoreProps & { children: React.ReactNode }) {
  const { getS3Client, getDdbDocClient } = useMemo(
    () =>
      createAwsClients(
        shellConfig,
        runtimeEnv,
        auth.awsCredentialProvider,
        auth.signOut
      ),
    [auth.awsCredentialProvider, auth.signOut, runtimeEnv, shellConfig]
  );

  const authValue: AuthContextValue = {
    awsCredentialProvider: auth.awsCredentialProvider,
    userProfile: auth.userProfile,
    signOut: auth.signOut,
    getS3Client,
    getDdbClient: getDdbDocClient,
    tables: shellConfig.tables,
  };

  return <AuthProvider {...authValue}>{children}</AuthProvider>;
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

function ShellCoreApp({
  shellConfig,
  runtimeEnv,
}: {
  shellConfig: ShellConfig;
  runtimeEnv: PublicRuntimeEnv;
}) {
  const getS3Client = moduleCore.useAwsS3Client();
  const registerResources = useRegisterResources();

  const getS3ClientRef = useRef(getS3Client);
  const registerResourcesRef = useRef(registerResources);

  useEffect(() => {
    getS3ClientRef.current = getS3Client;
    registerResourcesRef.current = registerResources;
  });

  const [moduleLocation, setModuleLocation] = useState(() =>
    getCurrentModuleLocation(shellConfig)
  );

  useEffect(() => {
    const onPopState = () => setModuleLocation(getCurrentModuleLocation(shellConfig));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [shellConfig]);

  useEffect(() => {
    const onNavigate = () => setModuleLocation(getCurrentModuleLocation(shellConfig));
    window.addEventListener("shell:navigate", onNavigate);
    return () => window.removeEventListener("shell:navigate", onNavigate);
  }, [shellConfig]);

  const LazyApp = useMemo(() => {
    if (moduleLocation.isDefault && runtimeEnv.isLocalDev) {
      return React.lazy(async (): Promise<{ default: React.ComponentType }> => {
        const { default: LandingApp } = await import("app-landing");
        const devConfig: ModuleConfig = {
          id: "app-landing-dev",
          app: { bucket: "hep-dev-registry", key: "bundle.js" },
          meta: { projectsBucket: "hep-dev-modules" },
        };
        const Bound = () => <LandingApp config={devConfig} />;
        Bound.displayName = "RootModule[dev]";
        return { default: Bound };
      });
    }

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
  }, [moduleLocation, runtimeEnv.isLocalDev]);

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

export default function ProtectedShellCore(props: ProtectedShellCoreProps) {
  return (
    <ResourceRegistryProvider>
      <EditModeProvider>
        <ShellAuthProvider {...props}>
          <ShellCoreApp shellConfig={props.shellConfig} runtimeEnv={props.runtimeEnv} />
        </ShellAuthProvider>
      </EditModeProvider>
    </ResourceRegistryProvider>
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
