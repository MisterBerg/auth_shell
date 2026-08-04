/**
 * reset-local.ts
 *
 * Full local dev environment reset. Run this to start fresh or to onboard a
 * new machine. Safe to run repeatedly.
 */

import { execFileSync, execSync, spawn } from "child_process";
import { createRequire } from "module";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve("tsx/cli");
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";

const MINIO_HEALTH = "http://localhost:9000/minio/health/live";
const DYNAMODB_SHELL = "http://localhost:8000/shell/";
const MODULES_BUCKET = "hep-dev-modules";
const DEV_PORT = 5173;
const AGENT_BRIDGE_PORT = 4317;

type ComposeCommand = {
  command: string;
  args: string[];
};

function parseArgs() {
  const raw = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [key, value] = arg.replace(/^--/, "").split("=");
      return [key, value ?? true];
    })
  );

  return {
    developer: String(raw["developer"] ?? osUsername()).toLowerCase(),
    noCompose: raw["no-compose"] === true || raw["no-compose"] === "true",
  };
}

function osUsername(): string {
  return process.env["USERNAME"] ?? process.env["USER"] ?? "dev";
}

function heading(step: number, total: number, label: string) {
  const bar = "-".repeat(58);
  console.log(`\n+${bar}+`);
  console.log(`|  ${step} / ${total}  ${label.padEnd(53)}|`);
  console.log(`+${bar}+`);
}

function run(command: string, args: string[], cwd?: string) {
  if (process.platform === "win32" && /\.cmd$/i.test(command)) {
    const shell = process.env["ComSpec"] || "cmd.exe";
    const commandLine = [command, ...args.map(quoteWindowsArg)].join(" ");
    execFileSync(shell, ["/d", "/s", "/c", commandLine], {
      cwd: cwd ?? ROOT,
      stdio: "inherit",
    });
    return;
  }

  execFileSync(command, args, {
    cwd: cwd ?? ROOT,
    stdio: "inherit",
  });
}

function runShell(command: string) {
  execSync(command, {
    cwd: ROOT,
    stdio: "inherit",
  });
}

function runTsx(scriptPath: string, scriptArgs: string[] = []) {
  run(process.execPath, [TSX_CLI, scriptPath, ...scriptArgs]);
}

function plistEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function installAgentRuntimeForCurrentOs() {
  if (process.platform === "darwin") {
    installMacosDevAgentRuntime();
    return;
  }

  if (process.platform === "win32") {
    runTsx("scripts/manage-agent-runtime.ts", ["install"]);
    return;
  }

  console.log(`  Agent runtime install is not implemented for ${process.platform}; skipping.`);
}

function installMacosDevAgentRuntime() {
  const home = process.env["HOME"];
  if (!home) throw new Error("HOME is required to install the macOS dev agent runtime.");

  const uid = execSync("id -u", { encoding: "utf-8" }).trim();
  const appHome = join(home, "Library", "Application Support", "Jeffspace Agent Runtime");
  const runtimeDir = join(appHome, "dev");
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  const logDir = join(home, "Library", "Logs", "Jeffspace Agent Runtime");
  const bridgeBundlePath = join(runtimeDir, "agent-bridge-current.cjs");
  const plistPath = join(launchAgentsDir, "com.jeffspace.agent-runtime.dev.plist");
  const esbuild = require.resolve("esbuild/bin/esbuild");

  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  console.log("  Building current bridge bundle...");
  run(esbuild, [
    "scripts/agent-bridge.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node20",
    `--outfile=${bridgeBundlePath}`,
  ]);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.jeffspace.agent-runtime.dev</string>
  <key>ProgramArguments</key>
  <array>
    <string>${plistEscape(process.execPath)}</string>
    <string>${plistEscape(bridgeBundlePath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_BRIDGE_STATE_ROOT</key>
    <string>${plistEscape(join(appHome, "state"))}</string>
    <key>AGENT_BRIDGE_BROWSE_ROOT</key>
    <string>${plistEscape(home)}</string>
    <key>AGENT_BRIDGE_WORKSPACE_ROOT</key>
    <string>${plistEscape(ROOT)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${plistEscape(join(logDir, "dev-runtime.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${plistEscape(join(logDir, "dev-runtime.err.log"))}</string>
</dict>
</plist>
`;
  writeFileSync(plistPath, plist, "utf-8");

  console.log("  Restarting current bridge LaunchAgent...");
  try {
    execSync(`launchctl bootout gui/${uid}/com.jeffspace.agent-runtime`, { stdio: "ignore" });
  } catch {
    // The packaged runtime is not loaded.
  }
  try {
    execSync(`launchctl bootout gui/${uid}/com.jeffspace.agent-runtime.dev`, { stdio: "ignore" });
  } catch {
    // The dev runtime is not loaded.
  }
  execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { stdio: "inherit" });
  execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/com.jeffspace.agent-runtime.dev`], { stdio: "inherit" });
}

function quoteWindowsArg(value: string): string {
  if (!/[\s"]/u.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function podmanBin(): string {
  for (const candidate of ["podman", "C:\\Program Files\\RedHat\\Podman\\podman.exe"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "pipe" });
      return candidate;
    } catch {
      // try next
    }
  }

  throw new Error(
    "podman not found. Make sure Podman Desktop is installed and podman is on PATH."
  );
}

function ensurePodmanMachine(bin: string) {
  let lsOut = "";
  try {
    lsOut = execSync(`"${bin}" machine ls --format json`, { stdio: "pipe" }).toString();
  } catch {
    return;
  }

  let machines: Array<{ Running?: boolean }> = [];
  try {
    machines = JSON.parse(lsOut) as Array<{ Running?: boolean }>;
  } catch {
    return;
  }

  if (machines.length === 0) return;
  if (machines.some((machine) => machine.Running)) return;

  console.log("  Podman machine is stopped - starting it...");
  run(bin, ["machine", "start"]);
  console.log();
}

function composeCmd(): ComposeCommand {
  const bin = podmanBin();
  ensurePodmanMachine(bin);

  try {
    execFileSync(bin, ["compose", "version"], { stdio: "pipe" });
    return { command: bin, args: ["compose"] };
  } catch {
    throw new Error(
      "podman compose is not available. Install the Podman Compose plugin, then retry."
    );
  }
}

async function waitForService(label: string, url: string, maxMs = 90_000) {
  const deadline = Date.now() + maxMs;
  process.stdout.write(`  Waiting for ${label} `);

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok || res.status < 500) {
        console.log("ok");
        return;
      }
    } catch {
      // not ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    process.stdout.write(".");
  }

  console.log(" x");
  throw new Error(`${label} did not become healthy within ${maxMs / 1000}s`);
}

function killPort(port: number) {
  if (process.platform === "win32") {
    try {
      const out = execSync(`netstat -ano | findstr :${port}`, { stdio: "pipe" }).toString();
      const pids = new Set(
        out.split("\n")
          .map((line) => line.trim().split(/\s+/).pop())
          .filter((pid): pid is string => Boolean(pid) && /^\d+$/.test(pid) && pid !== "0")
      );

      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: "pipe" });
        } catch {
          // already gone
        }
      }
    } catch {
      // nothing on the port
    }
    return;
  }

  try {
    const out = execSync(`lsof -ti tcp:${port}`, { stdio: "pipe" }).toString();
    const pids = new Set(
      out.split("\n").map((line) => line.trim()).filter((line) => /^\d+$/.test(line))
    );

    for (const pid of pids) {
      try {
        execFileSync("kill", ["-9", pid], { stdio: "pipe" });
      } catch {
        // already gone
      }
    }
  } catch {
    // nothing on the port
  }
}

function startDevServer() {
  const shellDir = join(ROOT, "apps", "shell");
  const child = spawn(NPM_COMMAND, ["run", "dev"], {
    cwd: shellDir,
    detached: true,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  child.unref();
}

interface PkgJson {
  scripts?: Record<string, string>;
  jsl?: object;
}

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

async function main() {
  const { developer, noCompose } = parseArgs();
  const total = noCompose ? 6 : 7;
  let step = 0;

  console.log("\n============================================================");
  console.log(`HEP Local Environment Reset - developer: ${developer}`);
  console.log("============================================================");

  heading(++step, total, "Install workspace dependencies");
  run(NPM_COMMAND, ["install", "--cache", "./.npm-cache"]);

  heading(++step, total, "Build and install local agent runtime");
  installAgentRuntimeForCurrentOs();
  await waitForService("Agent Runtime Bridge", `http://localhost:${AGENT_BRIDGE_PORT}/health`, 20_000);

  if (!noCompose) {
    const compose = composeCmd();
    heading(++step, total, "Restart containers");
    console.log("  Stopping existing containers...");
    try {
      run(compose.command, [...compose.args, "down"]);
    } catch {
      // not running - fine
    }
    console.log("\n  Starting containers...");
    run(compose.command, [...compose.args, "up", "-d"]);
  }

  heading(++step, total, "Wait for services to be healthy");
  await waitForService("MinIO (S3)", MINIO_HEALTH);
  await waitForService("DynamoDB", DYNAMODB_SHELL);

  heading(++step, total, "Seed local environment (reset mode)");
  runTsx("scripts/seed-local.ts", [`--developer=${developer}`, "--reset"]);

  const modules = publishableModules();
  heading(++step, total, `Build and publish ${modules.length} modules`);
  console.log(`  ${modules.join("  •  ")}\n`);
  for (const mod of modules) {
    runTsx("scripts/publish-module.ts", ["--local", `--module=${mod}`]);
  }

  heading(++step, total, "Restart dev server");
  console.log(`  Stopping anything on port ${DEV_PORT}...`);
  killPort(DEV_PORT);
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log("  Starting apps/shell dev server in background...");
  startDevServer();

  const projectUrl =
    `http://localhost:${DEV_PORT}/?bucket=${MODULES_BUCKET}&config=projects/${developer}-dev/config.json`;

  console.log("\n============================================================");
  console.log("Reset complete");
  console.log("============================================================");
  console.log(`
Dev server starting at:
  ${projectUrl}

(Give it a few seconds to compile on first launch.)
`);
}

main().catch((err: unknown) => {
  console.error("\nReset failed:", (err as Error).message ?? err);
  process.exit(1);
});
