import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { useAuthStore } from "../stores/authStore.ts";
import { useConfigStore } from "../stores/configStore.ts";

export interface AwsClients {
  getDdbDocClient: () => Promise<DynamoDBDocumentClient>;
  getS3Client: (bucket?: string) => Promise<S3Client>;
}

// ---------------------------------------------------------------------------
// Local dev endpoint routing
// In production builds these are all undefined and the routing is tree-shaken.
// ---------------------------------------------------------------------------

const localBuckets: ReadonlySet<string> = import.meta.env.DEV
  ? new Set(
      (import.meta.env.VITE_LOCAL_BUCKETS ?? "")
        .split(",")
        .map((b: string) => b.trim())
        .filter(Boolean)
    )
  : new Set();

const localS3Endpoint: string | undefined = import.meta.env.DEV
  ? import.meta.env.VITE_LOCAL_S3_ENDPOINT
  : undefined;

const localDdbEndpoint: string | undefined = import.meta.env.DEV
  ? import.meta.env.VITE_LOCAL_DYNAMODB_ENDPOINT
  : undefined;

const localCredentials =
  import.meta.env.DEV && import.meta.env.VITE_LOCAL_AWS_ACCESS_KEY_ID
    ? {
        accessKeyId: import.meta.env.VITE_LOCAL_AWS_ACCESS_KEY_ID as string,
        secretAccessKey: import.meta.env.VITE_LOCAL_AWS_SECRET_ACCESS_KEY as string,
      }
    : undefined;

const localRegion: string | undefined = import.meta.env.DEV
  ? (import.meta.env.VITE_LOCAL_AWS_REGION as string | undefined)
  : undefined;

function isLocalBucket(bucket?: string): boolean {
  return !!bucket && localBuckets.has(bucket);
}

// ---------------------------------------------------------------------------
// Client cache — one per endpoint (local and remote can both be in use)
// ---------------------------------------------------------------------------

let remoteDdbClient: DynamoDBDocumentClient | null = null;
let localDdbClient: DynamoDBDocumentClient | null = null;
const s3ClientCache = new Map<string, S3Client>(); // keyed by endpoint URL

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installAutoResetOnAuthError(client: { middlewareStack: any }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client.middlewareStack.addRelativeTo(
    (next: any) => async (args: any) => {
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
          console.warn("[awsClients] Auth error — clearing session", err);
          useAuthStore.getState().clearSession();
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

export function getAwsClients(): AwsClients {
  return {
    /**
     * Returns a DynamoDB client. In dev, if VITE_LOCAL_DYNAMODB_ENDPOINT is
     * set, returns a client pointed at DynamoDB Local; otherwise real AWS.
     */
    getDdbDocClient: async () => {
      const useLocal = import.meta.env.DEV && !!localDdbEndpoint;

      if (useLocal) {
        if (!localDdbClient) {
          const raw = new DynamoDBClient({
            region: localRegion ?? "us-east-1",
            endpoint: localDdbEndpoint,
            credentials: localCredentials ?? { accessKeyId: "local", secretAccessKey: "local" },
          });
          localDdbClient = DynamoDBDocumentClient.from(raw, {
            marshallOptions: { removeUndefinedValues: true },
          });
        }
        return localDdbClient;
      }

      const { config } = useConfigStore.getState();
      const { awsCredentialProvider } = useAuthStore.getState();
      if (!config) throw new Error("Config not initialized");
      if (!awsCredentialProvider) throw new Error("AWS credential provider not available");

      if (!remoteDdbClient) {
        const raw = new DynamoDBClient({
          region: config.region,
          credentials: awsCredentialProvider,
        });
        installAutoResetOnAuthError(raw);
        remoteDdbClient = DynamoDBDocumentClient.from(raw, {
          marshallOptions: { removeUndefinedValues: true },
        });
      }
      return remoteDdbClient;
    },

    /**
     * Returns an S3 client appropriate for the given bucket.
     * In dev, buckets listed in VITE_LOCAL_BUCKETS route to MinIO;
     * all others route to real AWS. In production, always real AWS.
     */
    getS3Client: async (bucket?: string) => {
      const useLocal = import.meta.env.DEV && !!localS3Endpoint && isLocalBucket(bucket);
      const cacheKey = useLocal ? `local:${localS3Endpoint}` : "remote";

      if (s3ClientCache.has(cacheKey)) {
        return s3ClientCache.get(cacheKey)!;
      }

      let client: S3Client;

      if (useLocal) {
        client = new S3Client({
          region: localRegion ?? "us-east-1",
          endpoint: localS3Endpoint,
          credentials: localCredentials ?? { accessKeyId: "local", secretAccessKey: "local" },
          forcePathStyle: true, // required for MinIO
          // MinIO drops the connection (rather than returning a clean error) for the
          // x-amz-checksum-* headers the browser SDK adds automatically to PUT requests.
          // Disable automatic checksum calculation for local dev only.
          requestChecksumCalculation: "WHEN_REQUIRED",
          responseChecksumValidation: "WHEN_REQUIRED",
        });
      } else {
        const { config } = useConfigStore.getState();
        const { awsCredentialProvider } = useAuthStore.getState();
        if (!config) throw new Error("Config not initialized");
        if (!awsCredentialProvider) throw new Error("AWS credential provider not available");

        const s3Config: S3ClientConfig = {
          region: config.region,
          credentials: awsCredentialProvider,
        };
        client = new S3Client(s3Config);
        installAutoResetOnAuthError(client);
      }

      s3ClientCache.set(cacheKey, client);
      return client;
    },
  };
}
