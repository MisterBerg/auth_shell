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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const REGION      = "us-east-2";
const SHELL_BUCKET = "jeffspace-shell";
const SHELL_DIR   = join(ROOT, "apps", "shell");
const DIST_DIR    = join(SHELL_DIR, "dist");

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function loadCredentials(): { accessKeyId: string; secretAccessKey: string } {
  const credFile = join(ROOT, ".aws", "credentials", "access_key");
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
  const s3 = new S3Client({ region: REGION, credentials });

  // Build
  console.log("\n[1/3] Building shell app...");
  execSync("npm run build", { cwd: SHELL_DIR, stdio: "inherit" });
  console.log("  ✓ Build complete");

  // Clear existing objects in bucket
  console.log(`\n[2/3] Clearing "${SHELL_BUCKET}"...`);
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
  console.log(`\n[3/3] Uploading to "${SHELL_BUCKET}"...`);
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

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Shell deployed to jeffspace-shell                          ║
╚══════════════════════════════════════════════════════════════╝

  CloudFront will serve the updated files within ~5 minutes.
  If you need to force-invalidate the CloudFront cache:

    aws cloudfront create-invalidation \\
      --distribution-id <YOUR_DIST_ID> \\
      --paths "/*"

  (Distribution ID was printed by provision-aws.ts)
`);
}

main().catch((err) => {
  console.error("\nDeploy failed:", err);
  process.exit(1);
});
