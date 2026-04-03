/**
 * publish-module.ts
 *
 * Builds a module and publishes it to the module registry (S3 + DynamoDB).
 * Use --local to publish to the Docker dev environment instead of real AWS.
 *
 * Usage:
 *   npx tsx scripts/publish-module.ts --module=app-landing --local
 *   npx tsx scripts/publish-module.ts --module=app-landing --version=1.2.0
 *   npx tsx scripts/publish-module.ts --module=app-landing  (real AWS)
 *
 * What it does:
 *   1. Runs `vite build` in the module directory
 *   2. Reads current version from the module's package.json, bumps patch
 *      (or uses --version override)
 *   3. Uploads bundle.js as bundle.v{version}.js and updates bundle.js (latest pointer)
 *   4. Writes/updates the registry record in DynamoDB
 */

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..");
const REGISTRY_TABLE = "module-registry";

// Local Docker endpoints
const LOCAL = {
  s3Endpoint: "http://localhost:9000",
  ddbEndpoint: "http://localhost:8000",
  region: "us-east-1",
  credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
  registryBucket: "hep-dev-registry",
};

// Real AWS — reads from environment / AWS credential chain
const REMOTE = {
  region: process.env["AWS_REGION"] ?? "us-east-2",
  registryBucket: process.env["HEP_REGISTRY_BUCKET"] ?? "",
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? true];
    })
  );

  const moduleName = args["module"] as string | undefined;
  if (!moduleName) {
    console.error("Usage: npx tsx scripts/publish-module.ts --module=<name> [--local] [--version=x.y.z]");
    process.exit(1);
  }

  return {
    moduleName,
    local: args["local"] === true || args["local"] === "true",
    versionOverride: args["version"] as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

function bumpPatch(version: string): string {
  const parts = version.split(".").map(Number);
  parts[2] = (parts[2] ?? 0) + 1;
  return parts.join(".");
}

async function resolveVersion(
  ddb: DynamoDBDocumentClient,
  moduleName: string,
  override?: string
): Promise<string> {
  if (override) return override;

  // Check if a latest version exists in the registry
  const existing = await ddb.send(new GetCommand({
    TableName: REGISTRY_TABLE,
    Key: { moduleName, version: "latest" },
  }));

  if (existing.Item?.["latestVersion"]) {
    return bumpPatch(existing.Item["latestVersion"] as string);
  }

  // Fall back to package.json version
  const pkgPath = join(ROOT, moduleName, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    if (pkg.version) return pkg.version;
  }

  return "0.1.0";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { moduleName, local, versionOverride } = parseArgs();

  const modulePath = join(ROOT, moduleName);
  if (!existsSync(modulePath)) {
    console.error(`Module directory not found: ${modulePath}`);
    process.exit(1);
  }

  console.log(`\nPublishing module: ${moduleName}`);
  console.log(`Environment:       ${local ? "local (Docker)" : "real AWS"}\n`);

  // AWS clients
  const s3 = new S3Client(
    local
      ? { region: LOCAL.region, endpoint: LOCAL.s3Endpoint, credentials: LOCAL.credentials, forcePathStyle: true }
      : { region: REMOTE.region }
  );
  const ddbRaw = new DynamoDBClient(
    local
      ? { region: LOCAL.region, endpoint: LOCAL.ddbEndpoint, credentials: LOCAL.credentials }
      : { region: REMOTE.region }
  );
  const ddb = DynamoDBDocumentClient.from(ddbRaw, {
    marshallOptions: { removeUndefinedValues: true },
  });

  const registryBucket = local ? LOCAL.registryBucket : REMOTE.registryBucket;
  if (!registryBucket) {
    console.error("HEP_REGISTRY_BUCKET env var required for real AWS publish");
    process.exit(1);
  }

  // Step 1: build
  console.log("Building...");
  execSync("npm run build", { cwd: modulePath, stdio: "inherit" });

  const bundlePath = join(modulePath, "dist", "bundle.js");
  if (!existsSync(bundlePath)) {
    console.error(`Build output not found: ${bundlePath}`);
    process.exit(1);
  }

  // Step 2: version
  const version = await resolveVersion(ddb, moduleName, versionOverride);
  console.log(`\nVersion: ${version}`);

  // Step 3: upload
  const bundleContent = readFileSync(bundlePath);
  const s3Prefix = `modules/${moduleName}`;

  // Versioned copy
  const versionedKey = `${s3Prefix}/bundle.v${version}.js`;
  await s3.send(new PutObjectCommand({
    Bucket: registryBucket,
    Key: versionedKey,
    Body: bundleContent,
    ContentType: "application/javascript",
  }));
  console.log(`  ✓ uploaded ${versionedKey}`);

  // Latest pointer
  const latestKey = `${s3Prefix}/bundle.js`;
  await s3.send(new PutObjectCommand({
    Bucket: registryBucket,
    Key: latestKey,
    Body: bundleContent,
    ContentType: "application/javascript",
  }));
  console.log(`  ✓ updated  ${latestKey} (latest pointer)`);

  // Step 4: registry record
  const now = new Date().toISOString();
  const owner = process.env["HEP_PUBLISHER"] ?? `${process.env["USER"] ?? "unknown"}@local.dev`;

  // Read optional jsl metadata from the module's package.json
  const pkgPath = join(modulePath, "package.json");
  type JslMeta = { displayName?: string; category?: string; description?: string };
  const jsl: JslMeta = existsSync(pkgPath)
    ? ((JSON.parse(readFileSync(pkgPath, "utf-8")) as { jsl?: JslMeta }).jsl ?? {})
    : {};

  // Version record
  await ddb.send(new PutCommand({
    TableName: REGISTRY_TABLE,
    Item: {
      moduleName,
      version,
      ownerId: owner,
      bundleBucket: registryBucket,
      bundlePath: versionedKey,
      displayName: jsl.displayName,
      category: jsl.category,
      description: jsl.description,
      publishedAt: now,
    },
  }));

  // Latest pointer record
  await ddb.send(new PutCommand({
    TableName: REGISTRY_TABLE,
    Item: {
      moduleName,
      version: "latest",
      latestVersion: version,
      ownerId: owner,
      bundleBucket: registryBucket,
      bundlePath: latestKey,
      displayName: jsl.displayName,
      category: jsl.category,
      description: jsl.description,
      updatedAt: now,
    },
  }));

  console.log(`  ✓ registry record written (${moduleName}@${version})`);

  console.log(`
Done!
  Module:  ${moduleName}@${version}
  Bundle:  s3://${registryBucket}/${latestKey}
  Config:  create a config.json pointing to bucket="${registryBucket}" key="${latestKey}"
`);
}

main().catch((err) => {
  console.error("Publish failed:", err);
  process.exit(1);
});
