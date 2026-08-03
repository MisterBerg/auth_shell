/**
 * run-local.ts
 *
 * Starts the full local development stack from the repository root:
 *   1. Start local MinIO/DynamoDB services through compose
 *   2. Ensure local buckets/tables/project seed exist without resetting data
 *   3. Publish changed local modules
 *   4. Start the shell Vite dev server
 *
 * Usage:
 *   npm run run:local
 *   npm run run:local -- --developer=jeff
 */

import { execFileSync, execSync, spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { createRequire } from "module";
import { join, resolve } from "path";

const ROOT = resolve(process.cwd());
const SHELL_DIR = join(ROOT, "apps", "shell");
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";
const SHELL_PORT = 5173;
const BRIDGE_PORT = 4317;
const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve("tsx/cli");

function main() {
  const developer = parseDeveloper();

  killPort(SHELL_PORT);
  killPort(BRIDGE_PORT);

  runTsx("scripts/compose-up.ts");
  run(NPM_COMMAND, ["install", "--include=optional"]);
  ensureNativeBuildDependencies();
  runTsx("scripts/seed-local.ts", [`--developer=${developer}`]);
  runTsx("scripts/update-locals.ts");

  const bridgeChild = spawn(process.execPath, [TSX_CLI, "scripts/agent-bridge.ts"], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      AGENT_BRIDGE_ALLOWED_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
    },
  });

  console.log("\nStarting shell dev server...");
  console.log(`Project URL: http://localhost:${SHELL_PORT}/?bucket=hep-dev-modules&config=projects/${developer}-dev/config.json\n`);
  console.log(`Agent bridge: http://127.0.0.1:${BRIDGE_PORT}\n`);

  const child = spawnCommand(NPM_COMMAND, ["run", "dev", "--", "--host", "0.0.0.0", "--port", String(SHELL_PORT)], {
    cwd: SHELL_DIR,
    env: {
      ...process.env,
      VITE_AGENT_BRIDGE_URL: `http://127.0.0.1:${BRIDGE_PORT}`,
    },
  });

  child.on("exit", (code, signal) => {
    bridgeChild.kill();
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

function spawnCommand(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  if (process.platform === "win32" && /\.cmd$/i.test(command)) {
    const shell = process.env["ComSpec"] || "cmd.exe";
    const commandLine = [command, ...args.map(quoteWindowsArg)].join(" ");
    return spawn(shell, ["/d", "/s", "/c", commandLine], {
      cwd: options.cwd,
      stdio: "inherit",
      env: options.env,
    });
  }

  return spawn(command, args, {
    cwd: options.cwd,
    stdio: "inherit",
    env: options.env,
  });
}

function parseDeveloper(): string {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [key, value] = arg.replace(/^--/, "").split("=");
      return [key, value ?? true];
    })
  );

  return String(args["developer"] ?? process.env["USER"] ?? process.env["USERNAME"] ?? "dev")
    .toLowerCase();
}

function run(command: string, args: string[]): void {
  if (process.platform === "win32" && /\.cmd$/i.test(command)) {
    const shell = process.env["ComSpec"] || "cmd.exe";
    const commandLine = [command, ...args.map(quoteWindowsArg)].join(" ");
    execFileSync(shell, ["/d", "/s", "/c", commandLine], {
      cwd: ROOT,
      stdio: "inherit",
    });
    return;
  }

  execFileSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  });
}

function quoteWindowsArg(value: string): string {
  if (!/[\s"]/u.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function runTsx(scriptPath: string, scriptArgs: string[] = []): void {
  run(process.execPath, [TSX_CLI, scriptPath, ...scriptArgs]);
}

function ensureNativeBuildDependencies(): void {
  ensureRollupNativePackage();
  run(NPM_COMMAND, ["rebuild", "esbuild"]);
}

function ensureRollupNativePackage(): void {
  const packageName = rollupNativePackageName();
  if (!packageName) return;

  try {
    require.resolve(packageName, { paths: [ROOT] });
    return;
  } catch {
    const rollupPkg = require("rollup/package.json") as { version?: string };
    if (!rollupPkg.version) return;
    console.log(`Installing missing Rollup native package for this host: ${packageName}@${rollupPkg.version}`);
    run(NPM_COMMAND, ["install", "--no-save", `${packageName}@${rollupPkg.version}`]);
  }
}

function rollupNativePackageName(): string | null {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "@rollup/rollup-darwin-arm64" : "@rollup/rollup-darwin-x64";
  }
  if (process.platform === "win32") {
    if (process.arch === "arm64") return "@rollup/rollup-win32-arm64-msvc";
    if (process.arch === "ia32") return "@rollup/rollup-win32-ia32-msvc";
    return "@rollup/rollup-win32-x64-msvc";
  }
  return null;
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

main();
