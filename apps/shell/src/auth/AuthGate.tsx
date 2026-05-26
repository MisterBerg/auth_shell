import React, {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  Component,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { S3Client, GetObjectCommand, type S3ClientConfig } from "@aws-sdk/client-s3";
import { CONFIG, type AppConfig } from "../config.ts";
import { useAuthStore, type AwsCredentials } from "../stores/authStore.ts";
import { initAuthShell } from "./googleCognito.ts";

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
  shellConfig: AppConfig;
  auth: {
    awsCredentialProvider: () => Promise<AwsCredentials>;
    userProfile?: { email?: string; name?: string; picture?: string };
    signOut: () => void;
  };
  runtimeEnv: PublicRuntimeEnv;
};

type ProtectedShellCoreComponent = React.ComponentType<ProtectedShellCoreProps>;

let iifeQueue: Promise<unknown> = Promise.resolve();
const s3ClientCache = new Map<string, S3Client>();

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
      const message = formatLoadError(this.state.error as Error);
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
            {message}
          </pre>
        </div>
      );
    }

    return this.props.children;
  }
}

function formatLoadError(error: Error): string {
  const message = error.message || String(error);
  if (isClockSkewError(message)) {
    return [
      message,
      "",
      "This usually means the browser/client clock and the S3 service clock differ too much for AWS request signing.",
      "Check the OS date/time on the machine running this browser, then restart the local stack if you are using local Podman services.",
    ].join("\n");
  }
  return message;
}

function isClockSkewError(message: string): boolean {
  return /request time.*server'?s time|RequestTimeTooSkewed|RequestExpired|Signature not yet current/i.test(message);
}

function getRuntimeEnv(): PublicRuntimeEnv {
  return {
    isLocalDev: Boolean(import.meta.env.DEV),
    localBuckets: (
      (import.meta.env.VITE_LOCAL_BUCKETS as string | undefined) ?? ""
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    localS3Endpoint: import.meta.env.VITE_LOCAL_S3_ENDPOINT as string | undefined,
    localDdbEndpoint: import.meta.env.VITE_LOCAL_DYNAMODB_ENDPOINT as string | undefined,
    localAccessKeyId: import.meta.env.VITE_LOCAL_AWS_ACCESS_KEY_ID as string | undefined,
    localSecretAccessKey: import.meta.env.VITE_LOCAL_AWS_SECRET_ACCESS_KEY as
      | string
      | undefined,
    localRegion: import.meta.env.VITE_LOCAL_AWS_REGION as string | undefined,
  };
}

function isLocalBucket(runtimeEnv: PublicRuntimeEnv, bucket?: string): boolean {
  return Boolean(bucket) && runtimeEnv.localBuckets.includes(bucket!);
}

async function getS3Client(
  bucket: string | undefined,
  awsCredentialProvider: () => Promise<AwsCredentials>,
  runtimeEnv: PublicRuntimeEnv
): Promise<S3Client> {
  const useLocal =
    import.meta.env.DEV && !!runtimeEnv.localS3Endpoint && isLocalBucket(runtimeEnv, bucket);

  const cacheKey = useLocal ? `local:${runtimeEnv.localS3Endpoint}` : "remote";
  const cached = s3ClientCache.get(cacheKey);
  if (cached && !useLocal) return cached;

  let client: S3Client;
  if (useLocal) {
    const systemClockOffset = await getLocalS3ClockOffset(runtimeEnv.localS3Endpoint!);
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
      systemClockOffset,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  } else {
    const config: S3ClientConfig = {
      region: CONFIG.region,
      credentials: awsCredentialProvider,
    };
    client = new S3Client(config);
  }

  if (!useLocal) {
    s3ClientCache.set(cacheKey, client);
  }
  return client;
}

async function getLocalS3ClockOffset(endpoint: string): Promise<number> {
  return readLocalS3ClockOffset(endpoint);
}

async function readLocalS3ClockOffset(endpoint: string): Promise<number> {
  void endpoint;
  const appHostOffset = await readDateHeaderClockOffset(window.location.origin);
  if (appHostOffset !== null) {
    logClockOffset("[AuthGate] Local S3 via app host", appHostOffset);
    return appHostOffset;
  }

  return 0;
}

async function readDateHeaderClockOffset(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { method: "HEAD", cache: "no-store" });
    const dateHeader = response.headers.get("date");
    if (!dateHeader) return null;
    const serverMs = Date.parse(dateHeader);
    if (!Number.isFinite(serverMs)) return null;
    return serverMs - Date.now();
  } catch {
    return null;
  }
}

function logClockOffset(label: string, offset: number): void {
  if (Math.abs(offset) > 30_000) {
    console.warn(`${label} clock offset detected: ${Math.round(offset / 1000)}s`);
  }
}

function loadIife(jsCode: string): Promise<Record<string, unknown>> {
  const next = iifeQueue.then(
    () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const blob = new Blob([jsCode], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);
        const script = document.createElement("script");
        script.src = url;
        script.onload = () => {
          URL.revokeObjectURL(url);
          script.remove();
          const exports = (window as unknown as Record<string, unknown>)["RemoteModule"] as
            | Record<string, unknown>
            | undefined;
          if (!exports) {
            reject(new Error("Protected shell core did not assign to window.RemoteModule"));
            return;
          }
          resolve(exports);
        };
        script.onerror = () => {
          URL.revokeObjectURL(url);
          script.remove();
          reject(new Error("Script load error while loading protected shell core"));
        };
        document.head.appendChild(script);
      })
  );

  iifeQueue = next.catch(() => {});
  return next;
}

async function loadProtectedShellCore(
  awsCredentialProvider: () => Promise<AwsCredentials>,
  runtimeEnv: PublicRuntimeEnv
): Promise<ProtectedShellCoreComponent> {
  let jsCode: string;
  try {
    const localText = await readLocalObjectText(
      CONFIG.shellCoreBundle.bucket,
      CONFIG.shellCoreBundle.key,
      runtimeEnv,
    );
    if (localText !== null) {
      jsCode = localText;
    } else {
      const s3 = await getS3Client(CONFIG.shellCoreBundle.bucket, awsCredentialProvider, runtimeEnv);
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: CONFIG.shellCoreBundle.bucket,
          Key: CONFIG.shellCoreBundle.key,
          ResponseCacheControl: "no-store",
        })
      );
      jsCode = await response.Body!.transformToString("utf-8");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "Error";
    throw new Error(
      `Failed to load protected shell core bundle ${CONFIG.shellCoreBundle.bucket}/${CONFIG.shellCoreBundle.key}: ${name}: ${message}`
    );
  }
  const rawModule = await loadIife(jsCode);
  const Component = rawModule["default"] as ProtectedShellCoreComponent | undefined;

  if (!Component) {
    throw new Error(
      `Protected shell core does not export "default". Available exports: ${Object.keys(rawModule).join(", ")}`
    );
  }

  return Component;
}

async function readLocalObjectText(
  bucket: string,
  key: string,
  runtimeEnv: PublicRuntimeEnv,
): Promise<string | null> {
  if (!import.meta.env.DEV || !runtimeEnv.localS3Endpoint || !isLocalBucket(runtimeEnv, bucket)) {
    return null;
  }

  const endpoint = runtimeEnv.localS3Endpoint.replace(/\/$/, "");
  const url = `${endpoint}/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(`${url}?_=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unsigned local S3 GET failed for ${bucket}/${key}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

export const AuthGate: React.FC = () => {
  const { isSignedIn, awsCredentialProvider, userProfile, loading, error, signOut, signInWithGoogle, signInWithMicrosoft } =
    useAuthStore();
  const runtimeEnvRef = useRef(getRuntimeEnv());

  useEffect(() => {
    initAuthShell({ config: CONFIG });
  }, []);

  const ready = isSignedIn && !!awsCredentialProvider;

  const LazyShellCore = useMemo(() => {
    if (!ready || !awsCredentialProvider) return null;

    return React.lazy(async (): Promise<{ default: React.ComponentType }> => {
      const Component = await loadProtectedShellCore(
        awsCredentialProvider,
        runtimeEnvRef.current
      );

      const Bound = () => (
        <Component
          shellConfig={CONFIG}
          auth={{ awsCredentialProvider, userProfile, signOut }}
          runtimeEnv={runtimeEnvRef.current}
        />
      );
      Bound.displayName = "ProtectedShellCore";
      return { default: Bound };
    });
  }, [ready, awsCredentialProvider, userProfile, signOut]);

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
        <p style={{ marginBottom: "1.5rem", textAlign: "center", maxWidth: "26rem" }}>
          Sign in with Google to continue. Access is granted only after Cognito accepts your Google token and returns AWS credentials.
        </p>

        <div id="google-signin-container" style={{ marginBottom: "0.75rem" }} />

        <button
          onClick={signInWithGoogle}
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
          Sign in with Google
        </button>

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
              maxWidth: "24rem",
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
            Loading protected shell...
          </div>
        }
      >
        <LazyShellCore />
      </Suspense>
    </ModuleErrorBoundary>
  );
};
