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
import { createRequire } from "module";
import { join, resolve } from "path";
import { randomBytes } from "crypto";

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
  run(NPM_COMMAND, ["install"]);
  runTsx("scripts/seed-local.ts", [`--developer=${developer}`]);
  runTsx("scripts/update-locals.ts");

  const agentBridgeToken = randomBytes(24).toString("hex");
  const bridgeChild = spawn(process.execPath, [TSX_CLI, "scripts/agent-bridge.ts"], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      AGENT_BRIDGE_TOKEN: agentBridgeToken,
      AGENT_BRIDGE_ALLOWED_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
    },
  });

  console.log("\nStarting shell dev server...");
  console.log(`Project URL: http://localhost:${SHELL_PORT}/?bucket=hep-dev-modules&config=projects/${developer}-dev/config.json\n`);
  console.log(`Agent bridge: http://127.0.0.1:${BRIDGE_PORT}\n`);

  const child = spawn(NPM_COMMAND, ["run", "dev", "--", "--host", "0.0.0.0", "--port", String(SHELL_PORT)], {
    cwd: SHELL_DIR,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      VITE_AGENT_BRIDGE_URL: `http://127.0.0.1:${BRIDGE_PORT}`,
      VITE_AGENT_BRIDGE_TOKEN: agentBridgeToken,
    },
  });

  child.on("exit", (code, signal) => {
    bridgeChild.kill();
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
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
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  });
}

function runTsx(scriptPath: string, scriptArgs: string[] = []): void {
  run(process.execPath, [TSX_CLI, scriptPath, ...scriptArgs]);
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
