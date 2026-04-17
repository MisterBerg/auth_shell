/**
 * reset-cloud.ts
 *
 * Full AWS environment reset without reprovisioning infrastructure.
 *
 * What it does:
 *   1. Installs workspace dependencies
 *   2. Clears project and registry S3 buckets
 *   3. Clears project / registry / lock DynamoDB tables
 *   4. Republishes app-landing and all publishable built-ins
 *   5. Rewrites the default landing config.json into jeffspace-modules
 *   6. Redeploys the shell bucket
 *   7. Invalidates CloudFront
 *
 * Usage:
 *   npm run reset:cloud
 */

import { execSync } from "child_process";
import { readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CloudFrontClient,
  ListDistributionsCommand,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const REGION = "us-east-2";
const MODULES_BUCKET = "jeffspace-modules";
const REGISTRY_BUCKET = "jeffspace-registry";
const SHELL_BUCKET = "jeffspace-shell";
const PROJECTS_TABLE = "jeffspace-projects";
const REGISTRY_TABLE = "jeffspace-module-registry";
const LOCKS_TABLE = "jeffspace-projects-locks";
const DEFAULT_APP_CONFIG_PATH = "apps/landing/config.json";
const DEFAULT_APP_BUNDLE_KEY = "modules/app-landing/bundle.js";

function parseArgs() {
  const flags = new Set(process.argv.slice(2).map((arg) => arg.replace(/^--/, "")));
  return {
    help: flags.has("help") || flags.has("h"),
  };
}

function heading(step: number, total: number, label: string) {
  const bar = "═".repeat(66);
  console.log(`\n╔${bar}╗`);
  console.log(`║  ${step} / ${total}  ${label.padEnd(59)}║`);
  console.log(`╚${bar}╝`);
}

function loadCredentials(): { accessKeyId: string; secretAccessKey: string } {
  const credFile = join(ROOT, ".aws", "credentials", "access_key");
  const lines = readFileSync(credFile, "utf-8").trim().split(/\r?\n/);
  const accessKeyId = lines[0]?.trim();
  const secretAccessKey = lines[1]?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(`Could not parse credentials from ${credFile}`);
  }
  return { accessKeyId, secretAccessKey };
}

const credentials = loadCredentials();

const s3 = new S3Client({ region: REGION, credentials });
const ddbRaw = new DynamoDBClient({ region: REGION, credentials });
const ddb = DynamoDBDocumentClient.from(ddbRaw, {
  marshallOptions: { removeUndefinedValues: true },
});
const cf = new CloudFrontClient({ region: "us-east-1", credentials });

function run(cmd: string, envExtra?: Record<string, string>) {
  execSync(cmd, {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_REGION: REGION,
      HEP_REGISTRY_BUCKET: REGISTRY_BUCKET,
      HEP_REGISTRY_TABLE: REGISTRY_TABLE,
      ...envExtra,
    },
  });
}

async function emptyBucket(bucket: string) {
  let continuationToken: string | undefined;
  let removed = 0;

  do {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      })
    );

    const objects = listed.Contents?.map((obj) => ({ Key: obj.Key! })) ?? [];
    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects },
        })
      );
      removed += objects.length;
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  console.log(`  ✓ cleared ${removed} object(s) from ${bucket}`);
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function clearTable(
  tableName: string,
  keyFields: string[]
) {
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  let deleted = 0;

  do {
    const scanned = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: keyFields.join(", "),
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );

    const keys = (scanned.Items ?? []).map((item) => {
      const key = Object.fromEntries(keyFields.map((field) => [field, item[field]]));
      return key;
    });

    for (const batch of chunk(keys, 25)) {
      if (batch.length === 0) continue;
      await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: batch.map((Key) => ({
              DeleteRequest: { Key },
            })),
          },
        })
      );
      deleted += batch.length;
    }

    lastEvaluatedKey = scanned.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  console.log(`  ✓ cleared ${deleted} item(s) from ${tableName}`);
}

async function writeDefaultLandingConfig() {
  const config = {
    id: "app-landing-root",
    app: {
      bucket: REGISTRY_BUCKET,
      key: DEFAULT_APP_BUNDLE_KEY,
    },
    meta: {
      title: "Jeffspace",
      projectsBucket: MODULES_BUCKET,
    },
    resources: [],
    children: [],
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: MODULES_BUCKET,
      Key: DEFAULT_APP_CONFIG_PATH,
      Body: JSON.stringify(config, null, 2),
      ContentType: "application/json",
      CacheControl: "no-store",
    })
  );

  console.log(`  ✓ wrote s3://${MODULES_BUCKET}/${DEFAULT_APP_CONFIG_PATH}`);
}

async function invalidateShellCloudFront() {
  const listed = await cf.send(new ListDistributionsCommand({}));
  const items = listed.DistributionList?.Items ?? [];
  const match = items.find((dist) =>
    (dist.Origins?.Items ?? []).some((origin) => {
      const haystack = `${origin.DomainName ?? ""} ${origin.Id ?? ""}`;
      return haystack.includes(SHELL_BUCKET);
    })
  );

  if (!match?.Id) {
    throw new Error(`Could not find CloudFront distribution for ${SHELL_BUCKET}`);
  }

  const result = await cf.send(
    new CreateInvalidationCommand({
      DistributionId: match.Id,
      InvalidationBatch: {
        CallerReference: `hep-reset-${Date.now()}`,
        Paths: {
          Quantity: 1,
          Items: ["/*"],
        },
      },
    })
  );

  console.log(`  ✓ CloudFront invalidation started (${match.Id} / ${result.Invalidation?.Id})`);
}

async function main() {
  const { help } = parseArgs();
  if (help) {
    console.log(`
Usage:
  npm run reset:cloud

What it does:
  1. npm install
  2. Clears jeffspace-modules and jeffspace-registry
  3. Clears jeffspace-projects, jeffspace-module-registry, and jeffspace-projects-locks
  4. Republishes app-landing
  5. Publishes all built-in modules
  6. Restores jeffspace-modules/apps/landing/config.json
  7. Redeploys the shell
  8. Invalidates CloudFront
`);
    return;
  }

  const TOTAL = 8;
  let step = 0;

  console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  HEP Cloud Environment Reset                                       ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");

  heading(++step, TOTAL, "Install workspace dependencies");
  run("npm install");

  heading(++step, TOTAL, "Clear AWS S3 data buckets");
  await emptyBucket(MODULES_BUCKET);
  await emptyBucket(REGISTRY_BUCKET);

  heading(++step, TOTAL, "Clear AWS DynamoDB tables");
  await clearTable(PROJECTS_TABLE, ["userId", "projectId"]);
  await clearTable(REGISTRY_TABLE, ["moduleName", "version"]);
  await clearTable(LOCKS_TABLE, ["projectId"]);

  heading(++step, TOTAL, "Publish default landing app");
  run("npx tsx scripts/publish-module.ts --module=apps/landing");

  heading(++step, TOTAL, "Publish built-in modules");
  run("npm run publish:all");

  heading(++step, TOTAL, "Restore default landing config");
  await writeDefaultLandingConfig();

  heading(++step, TOTAL, "Deploy shell and invalidate CloudFront");
  run("npm run deploy:shell");
  await invalidateShellCloudFront();

  heading(++step, TOTAL, "Done");
  console.log(`  Modules bucket:  ${MODULES_BUCKET}`);
  console.log(`  Registry bucket: ${REGISTRY_BUCKET}`);
  console.log(`  Shell bucket:    ${SHELL_BUCKET}`);
  console.log(`  Tables:          ${PROJECTS_TABLE}, ${REGISTRY_TABLE}, ${LOCKS_TABLE}`);
  console.log(`  Default config:  s3://${MODULES_BUCKET}/${DEFAULT_APP_CONFIG_PATH}`);
}

main().catch((err) => {
  console.error("\n✗ Cloud reset failed:", (err as Error).message ?? err);
  process.exit(1);
});
