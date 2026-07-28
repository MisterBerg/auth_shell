/**
 * manage-agent-runtime.ts
 *
 * Unified npm entry point for building and managing the local agent runtime.
 *
 * Usage:
 *   tsx scripts/manage-agent-runtime.ts build
 *   tsx scripts/manage-agent-runtime.ts install
 *   tsx scripts/manage-agent-runtime.ts uninstall
 */

import { execFileSync, execSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

type RuntimeAction = "build" | "install" | "uninstall";

function main(): void {
  const action = process.argv[2] as RuntimeAction | undefined;
  if (!action || !["build", "install", "uninstall"].includes(action)) {
    throw new Error("Usage: tsx scripts/manage-agent-runtime.ts <build|install|uninstall>");
  }

  if (process.platform === "win32") {
    runWindows(action);
    return;
  }

  if (process.platform === "darwin") {
    runMacos(action);
    return;
  }

  throw new Error(`Agent runtime management is not implemented for platform: ${process.platform}`);
}

function runWindows(action: RuntimeAction): void {
  if (action === "build") {
    execSync("tsx scripts/build-agent-runtime-windows.ts", { cwd: ROOT, stdio: "inherit" });
    return;
  }

  ensureWindowsBuild();

  const scriptName = action === "install" ? "install.ps1" : "uninstall.ps1";
  const scriptPath = join(ROOT, "build", "agent-runtime", "windows", "stage", scriptName);
  execFileSync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
  ], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

function runMacos(action: RuntimeAction): void {
  if (action === "build") {
    execSync("tsx scripts/build-agent-runtime-macos.ts", { cwd: ROOT, stdio: "inherit" });
    return;
  }

  if (action === "install") {
    execSync("tsx scripts/build-agent-runtime-macos.ts", { cwd: ROOT, stdio: "inherit" });
    const pkgPath = join(ROOT, "build", "agent-runtime", "macos", "jeffspace-agent-runtime-macos-universal.pkg");
    execFileSync("open", [pkgPath], { cwd: ROOT, stdio: "inherit" });
    return;
  }

  throw new Error("macOS uninstall is not automated yet. Remove the LaunchAgent and installed runtime manually.");
}

function ensureWindowsBuild(): void {
  const installScript = join(ROOT, "build", "agent-runtime", "windows", "stage", "install.ps1");
  if (!existsSync(installScript)) {
    execSync("tsx scripts/build-agent-runtime-windows.ts", { cwd: ROOT, stdio: "inherit" });
  }
}

main();
