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

import { execFileSync, spawn } from "child_process";
import { createRequire } from "module";
import { join, resolve } from "path";
import { randomBytes } from "crypto";

const ROOT = resolve(process.cwd());
const SHELL_DIR = join(ROOT, "apps", "shell");
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";
const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve("tsx/cli");

function main() {
  const developer = parseDeveloper();

  runTsx("scripts/compose-up.ts");
  runTsx("scripts/seed-local.ts", [`--developer=${developer}`]);
  runTsx("scripts/update-locals.ts");

  const agentBridgeToken = randomBytes(24).toString("hex");
  const bridgeChild = spawn(process.execPath, [TSX_CLI, "scripts/agent-bridge.ts"], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      AGENT_BRIDGE_TOKEN: agentBridgeToken,
      AGENT_BRIDGE_WORKSPACE_ROOT: ROOT,
      AGENT_BRIDGE_ALLOWED_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
    },
  });

  console.log("\nStarting shell dev server...");
  console.log(`Project URL: http://localhost:5173/?bucket=hep-dev-modules&config=projects/${developer}-dev/config.json\n`);
  console.log(`Agent bridge: http://127.0.0.1:4317\n`);

  const child = spawn(NPM_COMMAND, ["run", "dev", "--", "--host", "0.0.0.0"], {
    cwd: SHELL_DIR,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      VITE_AGENT_BRIDGE_URL: "http://127.0.0.1:4317",
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
  });
}

function runTsx(scriptPath: string, scriptArgs: string[] = []): void {
  run(process.execPath, [TSX_CLI, scriptPath, ...scriptArgs]);
}

main();
