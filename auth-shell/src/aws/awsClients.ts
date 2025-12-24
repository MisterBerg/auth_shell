// src/aws/awsClients.ts
import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { useAuthStore } from "../stores/authStore";
import { useConfigStore } from "../stores/configStore";

export interface AwsClients {
  getDdbDocClient: () => Promise<DynamoDBDocumentClient>;
  getS3Client: () => Promise<S3Client>;
}

// naive singletons for underlying clients, but creds are from provider
let ddbDocClient: DynamoDBDocumentClient | null = null;
let s3Client: S3Client | null = null;

function installAutoResetOnAuthError(client: { middlewareStack: any }) {
  client.middlewareStack.addRelativeTo(
    (next: any) => async (args: any) => {
      try {
        return await next(args);
      } catch (err: any) {
        const code = err?.name || err?.Code || err?.code;

        if (
          code === "ExpiredTokenException" ||
          code === "UnrecognizedClientException" ||
          code === "InvalidIdentityTokenException" ||
          code === "NotAuthorizedException"
        ) {
          console.warn("Auth-related AWS error, clearing session", err);
          useAuthStore.getState().clearSession();
        }

        throw err;
      }
    },
    {
      relation: "after",
      toMiddleware: "awsAuthMiddleware", // best-effort; name may differ
      name: "autoResetOnAuthError",
      override: true,
    }
  );
}

export function getAwsClients(): AwsClients {
  return {
    getDdbDocClient: async () => {
      const { config } = useConfigStore.getState();
      const { awsCredentialProvider } = useAuthStore.getState();

      if (!config) throw new Error("Config not initialized");
      if (!awsCredentialProvider)
        throw new Error("AWS credential provider not available");

      if (!ddbDocClient) {
        const baseConfig: DynamoDBClientConfig = {
          region: config.region,
          credentials: awsCredentialProvider,
        };
        const rawClient = new DynamoDBClient(baseConfig);
        installAutoResetOnAuthError(rawClient);
        ddbDocClient = DynamoDBDocumentClient.from(rawClient, {
          marshallOptions: { removeUndefinedValues: true },
        });
      }

      return ddbDocClient;
    },

    getS3Client: async () => {
      const { config } = useConfigStore.getState();
      const { awsCredentialProvider } = useAuthStore.getState();

      if (!config) throw new Error("Config not initialized");
      if (!awsCredentialProvider)
        throw new Error("AWS credential provider not available");

      if (!s3Client) {
        const s3Config: S3ClientConfig = {
          region: config.region,
          credentials: awsCredentialProvider,
        };
        const client = new S3Client(s3Config);
        installAutoResetOnAuthError(client);
        s3Client = client;
      }

      return s3Client;
    },
  };
}
