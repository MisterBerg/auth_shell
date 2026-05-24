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
import { join, resolve } from "path";

const ROOT = resolve(process.cwd());
const SHELL_DIR = join(ROOT, "apps", "shell");

function main() {
  const developer = parseDeveloper();

  run("npx", ["tsx", "scripts/compose-up.ts"]);
  run("npx", ["tsx", "scripts/seed-local.ts", `--developer=${developer}`]);
  run("npx", ["tsx", "scripts/update-locals.ts"]);

  console.log("\nStarting shell dev server...");
  console.log(`Project URL: http://localhost:5173/?bucket=hep-dev-modules&config=projects/${developer}-dev/config.json\n`);

  const child = spawn("npm", ["run", "dev", "--", "--host", "0.0.0.0"], {
    cwd: SHELL_DIR,
    stdio: "inherit",
    shell: true,
  });

  child.on("exit", (code, signal) => {
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

main();
