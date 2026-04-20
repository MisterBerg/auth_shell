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

// Local Docker endpoints
const LOCAL = {
  s3Endpoint: "http://localhost:9000",
  ddbEndpoint: "http://localhost:8000",
  region: "us-east-1",
  credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
  registryBucket: "hep-dev-registry",
  registryTable: "module-registry",
};

// Real AWS — reads from environment / AWS credential chain
const REMOTE = {
  region: process.env["AWS_REGION"] ?? "us-east-2",
  registryBucket: process.env["HEP_REGISTRY_BUCKET"] ?? "jeffspace-registry",
  registryTable: process.env["HEP_REGISTRY_TABLE"] ?? "jeffspace-module-registry",
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
  table: string,
  moduleName: string,
  override?: string
): Promise<string> {
  if (override) return override;

  // Check if a latest version exists in the registry
  const existing = await ddb.send(new GetCommand({
    TableName: table,
    Key: { moduleName, version: "latest" },
  }));

  if (existing.Item?.["latestVersion"]) {
    return bumpPatch(existing.Item["latestVersion"] as string);
  }

  // Fall back to package.json version
  const pkgPath = join(resolveModulePath(moduleName), "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    if (pkg.version) return pkg.version;
  }

  return "0.1.0";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function resolveModulePath(nameOrPath: string): string {
  // 1. Direct path (e.g. "layouts/top-left" or legacy "layout-top-left")
  const direct = join(ROOT, nameOrPath);
  if (existsSync(direct)) return direct;

  // 2. Scan workspaces — match by workspace dir basename or package "name"
  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { workspaces?: string[] };
  for (const ws of rootPkg.workspaces ?? []) {
    const wsPath = join(ROOT, ws);
    if (ws === nameOrPath || ws.endsWith(`/${nameOrPath}`)) return wsPath;
    try {
      const pkg = JSON.parse(readFileSync(join(wsPath, "package.json"), "utf-8")) as { name?: string };
      if (pkg.name === nameOrPath) return wsPath;
    } catch { /* skip */ }
  }

  console.error(`Module not found: ${nameOrPath}`);
  process.exit(1);
}

async function main() {
  const { moduleName, local, versionOverride } = parseArgs();

  const modulePath = resolveModulePath(moduleName);
  // Always use the npm package name for S3 keys and registry entries
  const pkg = JSON.parse(readFileSync(join(modulePath, "package.json"), "utf-8")) as { name: string };
  const canonicalName = pkg.name;

  console.log(`\nPublishing module: ${canonicalName}`);
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
  const registryTable  = local ? LOCAL.registryTable  : REMOTE.registryTable;
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
  const version = await resolveVersion(ddb, registryTable, canonicalName, versionOverride);
  console.log(`\nVersion: ${version}`);

  // Step 3: upload
  const bundleContent = readFileSync(bundlePath);
  const s3Prefix = `modules/${canonicalName}`;

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
  type JslMeta = {
    displayName?: string;
    category?: string;
    description?: string;
    pickerHidden?: boolean;
  };
  const jsl: JslMeta = existsSync(pkgPath)
    ? ((JSON.parse(readFileSync(pkgPath, "utf-8")) as { jsl?: JslMeta }).jsl ?? {})
    : {};

  // Version record
  await ddb.send(new PutCommand({
    TableName: registryTable,
    Item: {
      moduleName: canonicalName,
      version,
      ownerId: owner,
      bundleBucket: registryBucket,
      bundlePath: versionedKey,
      displayName: jsl.displayName,
      category: jsl.category,
      description: jsl.description,
      pickerHidden: jsl.pickerHidden,
      publishedAt: now,
    },
  }));

  // Latest pointer record
  await ddb.send(new PutCommand({
    TableName: registryTable,
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
      pickerHidden: jsl.pickerHidden,
      updatedAt: now,
    },
  }));

  console.log(`  ✓ registry record written (${canonicalName}@${version})`);

  console.log(`
Done!
  Module:  ${canonicalName}@${version}
  Bundle:  s3://${registryBucket}/${latestKey}
  Config:  create a config.json pointing to bucket="${registryBucket}" key="${latestKey}"
`);
}

main().catch((err) => {
  console.error("Publish failed:", err);
  process.exit(1);
});
