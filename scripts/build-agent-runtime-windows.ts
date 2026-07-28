/**
 * build-agent-runtime-windows.ts
 *
 * Builds a Windows installer bundle for the Jeffspace local agent bridge.
 *
 * The generated artifact is a zip file containing install/uninstall scripts.
 * Installation registers a per-user Scheduled Task that launches the bridge at
 * logon and keeps all runtime files under %LOCALAPPDATA%.
 */

import { execFileSync } from "child_process";
import {
  cpSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const VERSION = process.env["AGENT_RUNTIME_VERSION"] ?? "0.1.0";
const RUNTIME_NAME = "jeffspace-agent-runtime";
const ZIP_NAME = "jeffspace-agent-runtime-windows-x64.zip";
const BUILD_ROOT = join(ROOT, "build", "agent-runtime", "windows");
const STAGE_ROOT = join(BUILD_ROOT, "stage");
const RUNTIME_ROOT = join(STAGE_ROOT, "runtime");
const FINAL_ZIP = join(BUILD_ROOT, ZIP_NAME);
const SHELL_DOWNLOAD_DIR = join(ROOT, "apps", "shell", "dist", "downloads", "agent-runtime");

function main(): void {
  assertWindows();

  rmSync(BUILD_ROOT, { recursive: true, force: true });
  mkdirSync(RUNTIME_ROOT, { recursive: true });

  bundleBridge();
  writeRuntimeLauncher();
  writeInstallCmd();
  writeUninstallCmd();
  writeInstallPs1();
  writeUninstallPs1();
  writeReadme();
  buildZip();

  mkdirSync(SHELL_DOWNLOAD_DIR, { recursive: true });
  cpSync(FINAL_ZIP, join(SHELL_DOWNLOAD_DIR, ZIP_NAME));

  console.log(`\nAgent runtime installer bundle built: ${FINAL_ZIP}`);
  console.log(`Copied for shell deploy: ${join(SHELL_DOWNLOAD_DIR, ZIP_NAME)}`);
}

function assertWindows(): void {
  if (process.platform !== "win32") {
    throw new Error("Windows runtime packaging must be run on Windows.");
  }
}

function bundleBridge(): void {
  const { buildSync } = require("esbuild") as typeof import("esbuild");
  buildSync({
    absWorkingDir: ROOT,
    entryPoints: ["scripts/agent-bridge.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: ["node20"],
    outfile: join(RUNTIME_ROOT, "agent-bridge.cjs"),
    logLevel: "info",
  });
}

function writeRuntimeLauncher(): void {
  const content = `@echo off
setlocal

set "APP_HOME=%LOCALAPPDATA%\\Jeffspace Agent Runtime"
set "STATE_ROOT=%APP_HOME%\\state"
set "LOG_DIR=%APP_HOME%\\logs"
set "ENV_FILE=%APP_HOME%\\bridge-env.cmd"

if not exist "%STATE_ROOT%" mkdir "%STATE_ROOT%"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

if exist "%ENV_FILE%" call "%ENV_FILE%"

if "%AGENT_BRIDGE_STATE_ROOT%"=="" set "AGENT_BRIDGE_STATE_ROOT=%STATE_ROOT%"
if "%AGENT_BRIDGE_BROWSE_ROOT%"=="" set "AGENT_BRIDGE_BROWSE_ROOT=%USERPROFILE%"
if "%AGENT_BRIDGE_ALLOWED_ORIGINS%"=="" set "AGENT_BRIDGE_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173"

set "NODE_BIN=%JEFFSPACE_NODE%"
if not "%NODE_BIN%"=="" goto run

for %%I in (node.exe) do set "NODE_BIN=%%~$PATH:I"
if not "%NODE_BIN%"=="" goto run

if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE_BIN=%ProgramFiles%\\nodejs\\node.exe"
if not "%NODE_BIN%"=="" goto run

if exist "%LOCALAPPDATA%\\Programs\\nodejs\\node.exe" set "NODE_BIN=%LOCALAPPDATA%\\Programs\\nodejs\\node.exe"
if not "%NODE_BIN%"=="" goto run

echo [%date% %time%] Jeffspace Agent Runtime requires Node.js.>>"%LOG_DIR%\\runtime.log"
exit /b 78

:run
"%NODE_BIN%" "%~dp0agent-bridge.cjs" >>"%LOG_DIR%\\runtime.log" 2>&1
`;

  writeFileSync(join(RUNTIME_ROOT, "run-agent-runtime.cmd"), content);
}

function writeInstallCmd(): void {
  const content = `@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
exit /b %errorlevel%
`;
  writeFileSync(join(STAGE_ROOT, "install.cmd"), content);
}

function writeUninstallCmd(): void {
  const content = `@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
exit /b %errorlevel%
`;
  writeFileSync(join(STAGE_ROOT, "uninstall.cmd"), content);
}

function writeInstallPs1(): void {
  const content = `
$ErrorActionPreference = 'Stop'

$runtimeName = '${RUNTIME_NAME}'
$taskName = 'Jeffspace Agent Runtime'
$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceRuntime = Join-Path $sourceRoot 'runtime'
$appHome = Join-Path $env:LOCALAPPDATA 'Jeffspace Agent Runtime'
$installRoot = Join-Path $appHome 'runtime'
$stateRoot = Join-Path $appHome 'state'
$logRoot = Join-Path $appHome 'logs'
$envFile = Join-Path $appHome 'bridge-env.cmd'
$launcherPath = Join-Path $installRoot 'run-agent-runtime.cmd'
$node = Get-Command node -ErrorAction SilentlyContinue

if (-not $node) {
  throw 'Jeffspace Agent Runtime requires Node.js on PATH. Install Node.js, then run install.cmd again.'
}

New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
Copy-Item -Path (Join-Path $sourceRuntime '*') -Destination $installRoot -Recurse -Force

if (-not (Test-Path -LiteralPath $envFile)) {
  @'
@echo off
rem Optional bridge overrides:
rem set AGENT_BRIDGE_TOKEN=
rem set AGENT_BRIDGE_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
rem set AGENT_BRIDGE_BROWSE_ROOT=%USERPROFILE%
'@ | Set-Content -LiteralPath $envFile -Encoding ASCII
}

cmd /c ('schtasks /Delete /TN "' + $taskName + '" /F >nul 2>&1')
cmd /c ('schtasks /Create /TN "' + $taskName + '" /SC ONLOGON /RL LIMITED /F /TR "' + $launcherPath + '"')
cmd /c ('schtasks /Run /TN "' + $taskName + '" >nul 2>&1')

Write-Host ''
Write-Host ('Installed ' + $runtimeName + ' to ' + $installRoot)
Write-Host ('Scheduled task created: ' + $taskName)
Write-Host ('Runtime logs: ' + (Join-Path $logRoot 'runtime.log'))
Write-Host ('Optional overrides: ' + $envFile)
`.trimStart();

  writeFileSync(join(STAGE_ROOT, "install.ps1"), content);
}

function writeUninstallPs1(): void {
  const content = `
$ErrorActionPreference = 'Stop'

$taskName = 'Jeffspace Agent Runtime'
$appHome = Join-Path $env:LOCALAPPDATA 'Jeffspace Agent Runtime'

cmd /c ('schtasks /Delete /TN "' + $taskName + '" /F >nul 2>&1')
if (Test-Path -LiteralPath $appHome) {
  Remove-Item -LiteralPath $appHome -Recurse -Force
}

Write-Host ''
Write-Host 'Jeffspace Agent Runtime has been removed.'
`.trimStart();

  writeFileSync(join(STAGE_ROOT, "uninstall.ps1"), content);
}

function writeReadme(): void {
  const content = `# Jeffspace Agent Runtime for Windows

Version: ${VERSION}

## Install
1. Unzip this archive.
2. Run install.cmd.
3. If Windows prompts for permission, allow PowerShell to run the installer.

## What it installs
- Runtime files: %LOCALAPPDATA%\\Jeffspace Agent Runtime\\runtime
- State: %LOCALAPPDATA%\\Jeffspace Agent Runtime\\state
- Logs: %LOCALAPPDATA%\\Jeffspace Agent Runtime\\logs
- Startup task: "Jeffspace Agent Runtime"

## Requirements
- Windows
- Node.js available on PATH

## Configuration
Edit %LOCALAPPDATA%\\Jeffspace Agent Runtime\\bridge-env.cmd to set:
- AGENT_BRIDGE_TOKEN
- AGENT_BRIDGE_ALLOWED_ORIGINS
- AGENT_BRIDGE_BROWSE_ROOT

## Uninstall
Run uninstall.cmd from the extracted archive, or delete the scheduled task named
"Jeffspace Agent Runtime" and remove %LOCALAPPDATA%\\Jeffspace Agent Runtime.
`;

  writeFileSync(join(STAGE_ROOT, "README.txt"), content);
}

function buildZip(): void {
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${STAGE_ROOT}\\*' -DestinationPath '${FINAL_ZIP}' -Force`,
  ], {
    cwd: ROOT,
    stdio: "inherit",
  });

  statSync(FINAL_ZIP);
}

main();
