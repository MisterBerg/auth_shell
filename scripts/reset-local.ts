/**
 * reset-local.ts
 *
 * Full local dev environment reset. Run this to start fresh or to onboard a
 * new machine. Safe to run repeatedly.
 *
 * Usage:
 *   npm run reset                          # uses your OS username as developer name
 *   npm run reset -- --developer=jeff      # explicit developer name
 *   npm run reset -- --no-compose          # skip container restart (services already up)
 *
 * Steps:
 *   1. npm install            — ensure all workspace dependencies are present
 *   2. podman compose down/up — stop stale containers, start fresh ones
 *   3. Wait for services      — poll MinIO + DynamoDB health endpoints
 *   4. Seed (--reset mode)    — wipe and recreate S3 buckets, DDB tables, starter project
 *   5. Publish all modules    — build and publish every module to the local registry
 */

import { execSync, spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const MINIO_HEALTH  = "http://localhost:9000/minio/health/live";
const DYNAMODB_SHELL = "http://localhost:8000/shell/";
const MODULES_BUCKET = "hep-dev-modules";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const raw = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? true];
    })
  );
  return {
    developer: ((raw["developer"] as string) ?? osUsername()).toLowerCase(),
    noCompose: raw["no-compose"] === true || raw["no-compose"] === "true",
  };
}

function osUsername(): string {
  return process.env["USERNAME"] ?? process.env["USER"] ?? "dev";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function heading(step: number, total: number, label: string) {
  const bar = "─".repeat(58);
  console.log(`\n┌${bar}┐`);
  console.log(`│  ${step} / ${total}  ${label.padEnd(53)}│`);
  console.log(`└${bar}┘`);
}

function run(cmd: string, cwd?: string) {
  execSync(cmd, { cwd: cwd ?? ROOT, stdio: "inherit" });
}

function installedPackageVersion(pkgName: string): string | undefined {
  const pkgPath = join(ROOT, "node_modules", ...pkgName.split("/"), "package.json");
  if (!existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

function ensurePlatformNativeTooling() {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;

  const installs: string[] = [];
  if (!existsSync(join(ROOT, "node_modules", "@rollup", "rollup-darwin-arm64"))) {
    const version = installedPackageVersion("rollup");
    if (version) installs.push(`@rollup/rollup-darwin-arm64@${version}`);
  }
  if (!existsSync(join(ROOT, "node_modules", "@esbuild", "darwin-arm64"))) {
    const version = installedPackageVersion("esbuild");
    if (version) installs.push(`@esbuild/darwin-arm64@${version}`);
  }

  if (installs.length === 0) return;

  console.log("  Restoring platform-native optional packages…");
  run(`npm install --no-save ${installs.join(" ")}`);
}

// Locate the podman binary. Tries PATH first, then the known Windows install path.
function podmanBin(): string {
  for (const candidate of ["podman", "C:\\Program Files\\RedHat\\Podman\\podman.exe"]) {
    try {
      execSync(`"${candidate}" --version`, { stdio: "pipe" });
      return candidate;
    } catch { /* try next */ }
  }
  throw new Error(
    "podman not found. Make sure Podman Desktop is installed and podman.exe is on PATH."
  );
}

// Ensure the podman machine is running. If a machine exists but is stopped, start it.
function ensurePodmanMachine(bin: string) {
  let lsOut = "";
  try {
    lsOut = execSync(`"${bin}" machine ls --format json`, { stdio: "pipe" }).toString();
  } catch {
    // podman machine commands not supported (Linux native — no VM needed)
    return;
  }

  let machines: { Name: string; LastUp: string; Running: boolean }[] = [];
  try { machines = JSON.parse(lsOut); } catch { return; }
  if (machines.length === 0) return;

  const running = machines.some((m) => m.Running);
  if (running) return;

  console.log("  Podman machine is stopped — starting it…");
  execSync(`"${bin}" machine start`, { stdio: "inherit" });
  console.log();
}

// Locate the compose binary and return the full command prefix.
function composeCmd(): string {
  const bin = podmanBin();
  ensurePodmanMachine(bin);
  try {
    execSync(`"${bin}" compose version`, { stdio: "pipe" });
    return `"${bin}" compose`;
  } catch {
    throw new Error(
      "podman compose not found. Install podman-compose (e.g. npm i -g podman-compose or brew install podman-compose)."
    );
  }
}

async function waitForService(label: string, url: string, maxMs = 90_000) {
  const deadline = Date.now() + maxMs;
  process.stdout.write(`  Waiting for ${label} `);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status < 500) { console.log("✓"); return; }
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 1500));
    process.stdout.write(".");
  }
  console.log(" ✗");
  throw new Error(`${label} did not become healthy within ${maxMs / 1000}s`);
}

// ---------------------------------------------------------------------------
// Dev server management
// ---------------------------------------------------------------------------

const DEV_PORT = 5173;

function killPort(port: number) {
  try {
    // Windows: find PID via netstat, kill it
    const out = execSync(`netstat -ano | findstr :${port}`, { stdio: "pipe" }).toString();
    const pids = new Set(
      out.split("\n")
        .map((l) => l.trim().split(/\s+/).pop())
        .filter((p): p is string => !!p && /^\d+$/.test(p) && p !== "0")
    );
    for (const pid of pids) {
      try { execSync(`taskkill /F /PID ${pid}`, { stdio: "pipe" }); } catch { /* already gone */ }
    }
  } catch { /* nothing on the port */ }
}

function startDevServer() {
  const shellDir = join(ROOT, "apps", "shell");
  const child = spawn("npm", ["run", "dev"], {
    cwd: shellDir,
    detached: true,
    stdio: "ignore",
    shell: true,
  });
  child.unref();
}

// ---------------------------------------------------------------------------
// Module discovery
// ---------------------------------------------------------------------------

interface PkgJson {
  scripts?: Record<string, string>;
  jsl?: object;
}

/** Returns workspace names that have both a `jsl` field and a `build` script — i.e. publishable modules. */
function publishableModules(): string[] {
  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
    workspaces?: string[];
  };
  return (rootPkg.workspaces ?? []).filter((ws) => {
    const pkgPath = join(ROOT, ws, "package.json");
    if (!existsSync(pkgPath)) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PkgJson;
    return pkg.jsl !== undefined && typeof pkg.scripts?.build === "string";
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { developer, noCompose } = parseArgs();
  const TOTAL = noCompose ? 5 : 6;
  let step = 0;

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log(`║  HEP Local Environment Reset — developer: ${developer.padEnd(14)} ║`);
  console.log("╚══════════════════════════════════════════════════════════╝");

  // 1. Install dependencies
  heading(++step, TOTAL, "Install workspace dependencies");
  run("npm install");
  ensurePlatformNativeTooling();

  // 2. Restart containers
  if (!noCompose) {
    const compose = composeCmd();
    heading(++step, TOTAL, "Restart containers");
    console.log("  Stopping existing containers...");
    try { run(`${compose} down`); } catch { /* not running — that's fine */ }
    console.log("\n  Starting containers...");
    run(`${compose} up -d`);
  }

  // 3. Wait for services
  heading(++step, TOTAL, "Wait for services to be healthy");
  await waitForService("MinIO (S3)  ", MINIO_HEALTH);
  await waitForService("DynamoDB    ", DYNAMODB_SHELL);

  // 4. Seed
  heading(++step, TOTAL, "Seed local environment (reset mode)");
  run(`npx tsx scripts/seed-local.ts --developer=${developer} --reset`);

  // 5. Publish modules
  const modules = publishableModules();
  heading(++step, TOTAL, `Build and publish ${modules.length} modules`);
  console.log(`  ${modules.join("  •  ")}\n`);
  for (const mod of modules) {
    run(`npx tsx scripts/publish-module.ts --local --module=${mod}`);
  }

  // 6. Restart dev server
  heading(++step, TOTAL, "Restart dev server");
  console.log(`  Stopping anything on port ${DEV_PORT}…`);
  killPort(DEV_PORT);
  await new Promise((r) => setTimeout(r, 500)); // brief pause so port is free
  console.log("  Starting apps/shell dev server in background…");
  startDevServer();

  // Done
  const projectUrl =
    `http://localhost:${DEV_PORT}/?bucket=${MODULES_BUCKET}&config=projects/${developer}-dev/config.json`;

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  ✓  Reset complete                                       ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`
  Dev server starting at:
    ${projectUrl}

  (Give it a few seconds to compile on first launch.)
`);
}

main().catch((err: unknown) => {
  console.error("\n✗ Reset failed:", (err as Error).message ?? err);
  process.exit(1);
});
