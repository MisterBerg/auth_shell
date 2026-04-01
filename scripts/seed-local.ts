/**
 * seed-local.ts
 *
 * Creates a developer sandbox in the local Docker environment (MinIO + DynamoDB Local).
 * Run this once after `docker compose up` to scaffold a dev project.
 *
 * Usage:
 *   npx tsx scripts/seed-local.ts --developer=jeff
 *   npx tsx scripts/seed-local.ts --developer=jeff --reset   (wipe and re-seed)
 */

import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MINIO_ENDPOINT = "http://localhost:9000";
const DYNAMODB_ENDPOINT = "http://localhost:8000";
const REGION = "us-east-1";
const LOCAL_CREDS = { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" };

const MODULES_BUCKET = "hep-dev-modules";
const REGISTRY_BUCKET = "hep-dev-registry";
const PROJECTS_TABLE = "org-projects";
const REGISTRY_TABLE = "module-registry";
const LOCKS_TABLE = "org-projects-locks";

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const s3 = new S3Client({
  region: REGION,
  endpoint: MINIO_ENDPOINT,
  credentials: LOCAL_CREDS,
  forcePathStyle: true,
});

const ddbRaw = new DynamoDBClient({
  region: REGION,
  endpoint: DYNAMODB_ENDPOINT,
  credentials: LOCAL_CREDS,
});
const ddb = DynamoDBDocumentClient.from(ddbRaw, {
  marshallOptions: { removeUndefinedValues: true },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? true];
    })
  );
  return {
    developer: (args["developer"] as string) ?? "dev",
    reset: args["reset"] === true || args["reset"] === "true",
  };
}

async function ensureBucket(bucket: string) {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`  ✓ bucket "${bucket}" created`);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "BucketAlreadyOwnedByYou" ||
        (err as { Code?: string }).Code === "BucketAlreadyOwnedByYou") {
      console.log(`  · bucket "${bucket}" already exists`);
    } else {
      throw err;
    }
  }
}

async function emptyBucketPrefix(bucket: string, prefix: string) {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  const objects = list.Contents?.map((o) => ({ Key: o.Key! })) ?? [];
  if (objects.length > 0) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: objects },
    }));
    console.log(`  ✓ cleared ${objects.length} objects under ${bucket}/${prefix}`);
  }
}

async function ensureTable(name: string, pkName: string, skName?: string) {
  try {
    await ddbRaw.send(new DeleteTableCommand({ TableName: name }));
    console.log(`  · dropped table "${name}"`);
  } catch (err: unknown) {
    if (!((err as { name?: string }).name === "ResourceNotFoundException" ||
          err instanceof ResourceNotFoundException)) {
      throw err;
    }
  }
  await ddbRaw.send(new CreateTableCommand({
    TableName: name,
    AttributeDefinitions: [
      { AttributeName: pkName, AttributeType: "S" },
      ...(skName ? [{ AttributeName: skName, AttributeType: "S" }] : []),
    ],
    KeySchema: [
      { AttributeName: pkName, KeyType: "HASH" },
      ...(skName ? [{ AttributeName: skName, KeyType: "RANGE" }] : []),
    ],
    BillingMode: "PAY_PER_REQUEST",
  }));
  console.log(`  ✓ table "${name}" created`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { developer, reset } = parseArgs();
  const projectId = `${developer}-dev`;
  const projectPrefix = `projects/${projectId}/`;

  console.log(`\nSeeding local environment for developer: ${developer}`);
  console.log(`Project prefix: s3://${MODULES_BUCKET}/${projectPrefix}\n`);

  // Buckets
  console.log("Ensuring S3 buckets...");
  await ensureBucket(MODULES_BUCKET);
  await ensureBucket(REGISTRY_BUCKET);

  // Tables
  console.log("\nEnsuring DynamoDB tables...");
  if (reset) {
    await ensureTable(PROJECTS_TABLE, "userId", "projectId");
    await ensureTable(REGISTRY_TABLE, "moduleName", "version");
    await ensureTable(LOCKS_TABLE, "projectId");
  } else {
    // Create only if not already present — tolerate existing tables on non-reset runs
    for (const [table, pk, sk] of [
      [PROJECTS_TABLE, "userId", "projectId"],
      [REGISTRY_TABLE, "moduleName", "version"],
      [LOCKS_TABLE, "projectId", undefined],
    ] as [string, string, string | undefined][]) {
      try {
        await ensureTable(table, pk, sk);
      } catch (err: unknown) {
        if ((err as { name?: string }).name === "ResourceInUseException") {
          console.log(`  · table "${table}" already exists`);
        } else {
          throw err;
        }
      }
    }
  }

  // Clear and re-seed project prefix if reset
  if (reset) {
    console.log(`\nResetting project prefix...`);
    await emptyBucketPrefix(MODULES_BUCKET, projectPrefix);
  }

  // Root config.json
  console.log("\nSeeding project files...");
  const rootConfig = {
    id: projectId,
    app: {
      bucket: REGISTRY_BUCKET,
      key: "modules/app-landing/bundle.js",
    },
    meta: { title: `${developer}'s Dev Project` },
    resources: [],
    children: [],
  };

  await s3.send(new PutObjectCommand({
    Bucket: MODULES_BUCKET,
    Key: `${projectPrefix}config.json`,
    Body: JSON.stringify(rootConfig, null, 2),
    ContentType: "application/json",
  }));
  console.log(`  ✓ ${projectPrefix}config.json`);

  // DynamoDB project record
  console.log("\nSeeding DynamoDB records...");
  await ddb.send(new PutCommand({
    TableName: PROJECTS_TABLE,
    Item: {
      userId: `${developer}@local.dev`,
      projectId,
      role: "owner",
      rootConfigPath: `${projectPrefix}config.json`,
      rootBucket: MODULES_BUCKET,
      displayName: `${developer}'s Dev Project`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }));
  console.log(`  ✓ org-projects record for ${developer}@local.dev / ${projectId}`);

  console.log(`
Done! Start the shell with:

  cd auth-shell
  cp ../.env.local.example .env.local        # if not already done
  # edit .env.local — set VITE_LOCAL_BUCKETS=${MODULES_BUCKET},${REGISTRY_BUCKET}
  npm run dev

Then open: http://localhost:5173/?bucket=${MODULES_BUCKET}&config=${projectPrefix}config.json
`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
