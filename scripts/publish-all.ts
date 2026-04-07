/**
 * publish-all.ts
 *
 * Publishes every built-in module/layout to the Jeffspace registry.
 * "Built-in" means any workspace whose package.json contains a `jsl` field.
 * Contributed modules from external repos are published individually via
 *   npx tsx scripts/publish-module.ts --module=<name>
 *
 * Usage:
 *   npx tsx scripts/publish-all.ts            # real AWS
 *   npx tsx scripts/publish-all.ts --local    # local Docker
 *   npx tsx scripts/publish-all.ts --dry-run  # list what would be published
 */

import { execSync, spawnSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs() {
  const flags = new Set(process.argv.slice(2).map((a) => a.replace(/^--/, "")));
  return {
    local:  flags.has("local"),
    dryRun: flags.has("dry-run"),
  };
}

// ---------------------------------------------------------------------------
// Credentials (project-local, real AWS only)
// ---------------------------------------------------------------------------

function loadCredentials(): Record<string, string> {
  const credFile = join(ROOT, ".aws", "credentials", "access_key");
  if (!existsSync(credFile)) return {};
  const lines = readFileSync(credFile, "utf-8").trim().split(/\r?\n/);
  const accessKeyId = lines[0]?.trim();
  const secretAccessKey = lines[1]?.trim();
  if (!accessKeyId || !secretAccessKey) return {};
  return { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey };
}

// ---------------------------------------------------------------------------
// Workspace discovery — any workspace with a `jsl` field is publishable
// ---------------------------------------------------------------------------

type WorkspaceEntry = {
  path: string;
  name: string;
  displayName: string;
  category: string;
};

function discoverBuiltins(): WorkspaceEntry[] {
  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
    workspaces?: string[];
  };

  const results: WorkspaceEntry[] = [];
  for (const ws of rootPkg.workspaces ?? []) {
    const wsPath = join(ROOT, ws);
    const pkgPath = join(wsPath, "package.json");
    if (!existsSync(pkgPath)) continue;

    type Pkg = { name?: string; jsl?: { displayName?: string; category?: string } };
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Pkg;
    if (!pkg.jsl) continue; // not a publishable module

    results.push({
      path: ws,
      name: pkg.name ?? ws,
      displayName: pkg.jsl.displayName ?? pkg.name ?? ws,
      category: pkg.jsl.category ?? "component",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { local, dryRun } = parseArgs();
  const builtins = discoverBuiltins();

  console.log(`\nJeffspace built-in module publish`);
  console.log(`Environment: ${local ? "local (Docker)" : "real AWS"}`);
  if (dryRun) console.log("Mode:        dry-run (no builds or uploads)\n");
  else console.log();

  console.log(`Found ${builtins.length} publishable workspace(s):\n`);
  const maxName = Math.max(...builtins.map((b) => b.displayName.length));
  for (const b of builtins) {
    console.log(`  ${b.displayName.padEnd(maxName)}  [${b.category}]  (${b.path})`);
  }
  console.log();

  if (dryRun) {
    console.log("Dry run — exiting without publishing.");
    return;
  }

  const credEnv = local ? {} : loadCredentials();
  const env = {
    ...process.env,
    ...credEnv,
    AWS_REGION: "us-east-2",
    HEP_REGISTRY_BUCKET: "jeffspace-registry",
    HEP_REGISTRY_TABLE: "jeffspace-module-registry",
  };

  const publishScript = join(__dirname, "publish-module.ts");
  const results: Array<{ name: string; status: "ok" | "fail"; error?: string }> = [];

  for (let i = 0; i < builtins.length; i++) {
    const b = builtins[i]!;
    const label = `[${i + 1}/${builtins.length}] ${b.displayName} (${b.name})`;
    console.log(`${"─".repeat(64)}`);
    console.log(label);
    console.log(`${"─".repeat(64)}`);

    const args = ["npx", "tsx", publishScript, `--module=${b.path}`, ...(local ? ["--local"] : [])];
    const result = spawnSync(args[0]!, args.slice(1), {
      cwd: ROOT,
      env,
      stdio: "inherit",
      shell: true,
    });

    if (result.status === 0) {
      results.push({ name: b.displayName, status: "ok" });
    } else {
      results.push({ name: b.displayName, status: "fail", error: `exit code ${result.status ?? "unknown"}` });
      console.error(`\n  ✗ ${b.displayName} failed\n`);
    }
  }

  // Summary
  const ok   = results.filter((r) => r.status === "ok");
  const fail = results.filter((r) => r.status === "fail");

  console.log(`\n${"═".repeat(64)}`);
  console.log(`Publish complete: ${ok.length} succeeded, ${fail.length} failed`);
  if (ok.length)   console.log(`  ✓ ${ok.map((r) => r.name).join(", ")}`);
  if (fail.length) {
    console.log(`  ✗ ${fail.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nBatch publish failed:", err);
  process.exit(1);
});
