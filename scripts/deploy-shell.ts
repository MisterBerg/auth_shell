/**
 * deploy-shell.ts
 *
 * Builds the shell app and uploads it to the jeffspace-shell S3 bucket.
 * Run this after `provision-aws.ts` has created the bucket and CloudFront distribution.
 *
 * Usage:
 *   npx tsx scripts/deploy-shell.ts
 */

import { execSync } from "child_process";
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, dirname, join, relative, extname } from "path";
import { fileURLToPath } from "url";

import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import {
  CloudFrontClient,
  ListDistributionsCommand,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const REGION      = "us-east-2";
const SHELL_BUCKET = "jeffspace-shell";
const SHELL_DIR   = join(ROOT, "apps", "shell");
const DIST_DIR    = join(SHELL_DIR, "dist");

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function loadCredentials(): { accessKeyId: string; secretAccessKey: string } | undefined {
  const credFile = join(ROOT, ".aws", "credentials", "access_key");
  try {
    statSync(credFile);
  } catch {
    return undefined;
  }
  const lines = readFileSync(credFile, "utf-8").trim().split(/\r?\n/);
  return { accessKeyId: lines[0]!.trim(), secretAccessKey: lines[1]!.trim() };
}

// ---------------------------------------------------------------------------
// Content-type map
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".woff2": "font/woff2",
  ".woff":  "font/woff",
  ".ttf":   "font/ttf",
};

function contentType(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// File walk
// ---------------------------------------------------------------------------

function walk(dir: string, base = dir): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full, base));
    } else {
      files.push(relative(base, full).replace(/\\/g, "/"));
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const credentials = loadCredentials();
  const s3 = new S3Client(credentials ? { region: REGION, credentials } : { region: REGION });
  const cf = new CloudFrontClient(credentials ? { region: "us-east-1", credentials } : { region: "us-east-1" });

  // Build
  console.log("\n[1/4] Building shell app...");
  execSync("npm run build", { cwd: SHELL_DIR, stdio: "inherit" });
  console.log("  ✓ Build complete");
  buildAgentRuntimeInstallers();

  // Clear existing objects in bucket
  console.log(`\n[2/4] Clearing "${SHELL_BUCKET}"...`);
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: SHELL_BUCKET }));
  const existing = listed.Contents?.map((o) => ({ Key: o.Key! })) ?? [];
  if (existing.length > 0) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: SHELL_BUCKET,
      Delete: { Objects: existing },
    }));
    console.log(`  ✓ Removed ${existing.length} existing objects`);
  } else {
    console.log("  · bucket already empty");
  }

  // Upload dist/
  console.log(`\n[3/4] Uploading to "${SHELL_BUCKET}"...`);
  const files = walk(DIST_DIR);
  let count = 0;
  for (const file of files) {
    const body = readFileSync(join(DIST_DIR, file));
    const ct   = contentType(file);
    // index.html: no-cache so CloudFront always serves the latest entry point
    // Everything else: long cache (Vite hashes asset filenames)
    const cacheControl = file === "index.html"
      ? "no-cache, no-store, must-revalidate"
      : "public, max-age=31536000, immutable";

    await s3.send(new PutObjectCommand({
      Bucket: SHELL_BUCKET,
      Key: file,
      Body: body,
      ContentType: ct,
      CacheControl: cacheControl,
    }));
    count++;
    process.stdout.write(`\r  Uploaded ${count}/${files.length}: ${file.padEnd(60)}`);
  }
  console.log(`\n  ✓ ${count} files uploaded`);

  console.log("\n[4/4] Invalidating CloudFront...");
  const listedDistributions = await cf.send(new ListDistributionsCommand({}));
  const distribution = (listedDistributions.DistributionList?.Items ?? []).find((dist) =>
    (dist.Origins?.Items ?? []).some((origin) => {
      const haystack = `${origin.DomainName ?? ""} ${origin.Id ?? ""}`;
      return haystack.includes(SHELL_BUCKET);
    })
  );
  if (!distribution?.Id) {
    throw new Error(`Could not find CloudFront distribution for ${SHELL_BUCKET}`);
  }
  const invalidation = await cf.send(new CreateInvalidationCommand({
    DistributionId: distribution.Id,
    InvalidationBatch: {
      CallerReference: `deploy-shell-${Date.now()}`,
      Paths: {
        Quantity: 1,
        Items: ["/*"],
      },
    },
  }));
  console.log(`  ✓ CloudFront invalidation started (${distribution.Id} / ${invalidation.Invalidation?.Id})`);

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Shell deployed to jeffspace-shell                          ║
╚══════════════════════════════════════════════════════════════╝

  CloudFront invalidation has been started automatically.
  Distribution: ${distribution.Id}
  Invalidation: ${invalidation.Invalidation?.Id ?? "unknown"}
`);
}

function buildAgentRuntimeInstallers(): void {
  if (process.env["SKIP_AGENT_RUNTIME_INSTALLERS"] === "1") {
    console.log("  · skipped agent runtime installers (SKIP_AGENT_RUNTIME_INSTALLERS=1)");
    return;
  }

  if (process.platform !== "darwin") {
    console.log("  · skipped macOS agent runtime installer build; run on macOS or provide the artifact before deploy");
    return;
  }

  console.log("  · building macOS agent runtime installer");
  execSync("npm run build:agent-runtime:macos", { cwd: ROOT, stdio: "inherit" });
}

main().catch((err) => {
  console.error("\nDeploy failed:", err);
  process.exit(1);
});
