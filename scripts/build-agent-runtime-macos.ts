/**
 * build-agent-runtime-macos.ts
 *
 * Builds a macOS .pkg installer for the Jeffspace local agent bridge.
 *
 * The installed service is a per-user LaunchAgent. It listens only on
 * 127.0.0.1 and does not require a pairing token unless the user explicitly
 * sets AGENT_BRIDGE_TOKEN in their launch environment.
 *
 * Optional signing/notarization:
 *   AGENT_RUNTIME_SIGN_IDENTITY="Developer ID Installer: ..."
 *   AGENT_RUNTIME_NOTARY_APPLE_ID="apple-id@example.com"
 *   AGENT_RUNTIME_NOTARY_TEAM_ID="TEAMID12345"
 *   AGENT_RUNTIME_NOTARY_PASSWORD="@keychain:AC_PASSWORD"
 */

import { execFileSync } from "child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const VERSION = process.env["AGENT_RUNTIME_VERSION"] ?? "0.1.0";
const IDENTIFIER = "com.jeffspace.agent-runtime";
const RUNTIME_NAME = "jeffspace-agent-runtime";
const PKG_NAME = "jeffspace-agent-runtime-macos-universal.pkg";
const BUILD_ROOT = join(ROOT, "build", "agent-runtime", "macos");
const PAYLOAD_ROOT = join(BUILD_ROOT, "payload");
const SCRIPTS_ROOT = join(BUILD_ROOT, "scripts");
const COMPONENT_PKG = join(BUILD_ROOT, `${RUNTIME_NAME}-component.pkg`);
const FINAL_PKG = join(BUILD_ROOT, PKG_NAME);
const SHELL_DOWNLOAD_DIR = join(ROOT, "apps", "shell", "dist", "downloads", "agent-runtime");
const INSTALLED_ROOT = join(PAYLOAD_ROOT, "usr", "local", "lib", RUNTIME_NAME);
const INSTALLED_BIN_DIR = join(PAYLOAD_ROOT, "usr", "local", "bin");
const LAUNCH_AGENTS_DIR = join(PAYLOAD_ROOT, "Library", "LaunchAgents");
const SIGN_IDENTITY = process.env["AGENT_RUNTIME_SIGN_IDENTITY"]?.trim();
const NOTARY_APPLE_ID = process.env["AGENT_RUNTIME_NOTARY_APPLE_ID"]?.trim();
const NOTARY_TEAM_ID = process.env["AGENT_RUNTIME_NOTARY_TEAM_ID"]?.trim();
const NOTARY_PASSWORD = process.env["AGENT_RUNTIME_NOTARY_PASSWORD"]?.trim();

function main(): void {
  assertMacPackagingTools();

  rmSync(BUILD_ROOT, { recursive: true, force: true });
  mkdirSync(INSTALLED_ROOT, { recursive: true });
  mkdirSync(INSTALLED_BIN_DIR, { recursive: true });
  mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  mkdirSync(SCRIPTS_ROOT, { recursive: true });

  bundleBridge();
  writeRuntimeWrapper();
  writeLaunchAgent();
  writeInstallerScripts();
  buildPkg();
  notarizePkgIfConfigured();

  mkdirSync(SHELL_DOWNLOAD_DIR, { recursive: true });
  cpSync(FINAL_PKG, join(SHELL_DOWNLOAD_DIR, PKG_NAME));

  console.log(`\nAgent runtime installer built: ${FINAL_PKG}`);
  console.log(`Copied for shell deploy: ${join(SHELL_DOWNLOAD_DIR, PKG_NAME)}`);
}

function assertMacPackagingTools(): void {
  if (process.platform !== "darwin") {
    throw new Error("macOS runtime packaging requires macOS pkgbuild/productbuild.");
  }
  for (const command of ["pkgbuild", "productbuild"]) {
    execFileSync("/usr/bin/which", [command], { stdio: "ignore" });
  }
}

function bundleBridge(): void {
  const esbuild = require.resolve("esbuild/bin/esbuild");
  execFileSync(esbuild, [
    "scripts/agent-bridge.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node20",
    `--outfile=${join(INSTALLED_ROOT, "agent-bridge.cjs")}`,
  ], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

function writeRuntimeWrapper(): void {
  const wrapper = `#!/bin/sh
set -eu

APP_HOME="\${HOME}/Library/Application Support/Jeffspace Agent Runtime"
LOG_DIR="\${HOME}/Library/Logs/Jeffspace Agent Runtime"
mkdir -p "\${APP_HOME}/state" "\${LOG_DIR}"

NODE_BIN="\${JEFFSPACE_NODE:-}"
if [ -z "\${NODE_BIN}" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "\${candidate}" ]; then
      NODE_BIN="\${candidate}"
      break
    fi
  done
fi

if [ -z "\${NODE_BIN}" ] || [ ! -x "\${NODE_BIN}" ]; then
  echo "Jeffspace Agent Runtime requires Node.js. Install Node.js, then run: launchctl kickstart -k gui/$(id -u)/${IDENTIFIER}" >> "\${LOG_DIR}/runtime.log"
  exit 78
fi

export AGENT_BRIDGE_STATE_ROOT="\${AGENT_BRIDGE_STATE_ROOT:-\${APP_HOME}/state}"
export AGENT_BRIDGE_BROWSE_ROOT="\${AGENT_BRIDGE_BROWSE_ROOT:-\${HOME}}"
export AGENT_BRIDGE_ALLOWED_ORIGINS="\${AGENT_BRIDGE_ALLOWED_ORIGINS:-http://localhost:5173,http://127.0.0.1:5173}"

exec "\${NODE_BIN}" "/usr/local/lib/${RUNTIME_NAME}/agent-bridge.cjs" >> "\${LOG_DIR}/runtime.log" 2>&1
`;
  const path = join(INSTALLED_BIN_DIR, RUNTIME_NAME);
  writeFileSync(path, wrapper);
  chmodSync(path, 0o755);
}

function writeLaunchAgent(): void {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${IDENTIFIER}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/${RUNTIME_NAME}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/${IDENTIFIER}.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/${IDENTIFIER}.err.log</string>
</dict>
</plist>
`;
  writeFileSync(join(LAUNCH_AGENTS_DIR, `${IDENTIFIER}.plist`), plist);
}

function writeInstallerScripts(): void {
  const common = `#!/bin/sh
set -u

PLIST="/Library/LaunchAgents/${IDENTIFIER}.plist"
LABEL="${IDENTIFIER}"
CONSOLE_USER="$(stat -f %Su /dev/console 2>/dev/null || true)"

if [ -n "\${CONSOLE_USER}" ] && [ "\${CONSOLE_USER}" != "root" ] && id "\${CONSOLE_USER}" >/dev/null 2>&1; then
  CONSOLE_UID="$(id -u "\${CONSOLE_USER}")"
else
  CONSOLE_UID=""
fi
`;

  const preinstall = `${common}
if [ -n "\${CONSOLE_UID}" ]; then
  launchctl bootout "gui/\${CONSOLE_UID}" "\${PLIST}" >/dev/null 2>&1 || true
  launchctl bootout "gui/\${CONSOLE_UID}/\${LABEL}" >/dev/null 2>&1 || true
fi

exit 0
`;

  const postinstall = `${common}
chmod 644 "\${PLIST}" >/dev/null 2>&1 || true
chmod 755 "/usr/local/bin/${RUNTIME_NAME}" >/dev/null 2>&1 || true

if [ -n "\${CONSOLE_UID}" ]; then
  launchctl bootstrap "gui/\${CONSOLE_UID}" "\${PLIST}" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/\${CONSOLE_UID}/\${LABEL}" >/dev/null 2>&1 || true
fi

exit 0
`;

  writeExecutableScript(join(SCRIPTS_ROOT, "preinstall"), preinstall);
  writeExecutableScript(join(SCRIPTS_ROOT, "postinstall"), postinstall);
}

function writeExecutableScript(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function buildPkg(): void {
  execFileSync("pkgbuild", [
    "--root",
    PAYLOAD_ROOT,
    "--scripts",
    SCRIPTS_ROOT,
    "--identifier",
    IDENTIFIER,
    "--version",
    VERSION,
    "--install-location",
    "/",
    "--ownership",
    "recommended",
    COMPONENT_PKG,
  ], {
    cwd: ROOT,
    stdio: "inherit",
  });

  const productbuildArgs = [
    "--package",
    COMPONENT_PKG,
    ...(SIGN_IDENTITY ? ["--sign", SIGN_IDENTITY] : []),
    FINAL_PKG,
  ];
  execFileSync("productbuild", productbuildArgs, {
    cwd: ROOT,
    stdio: "inherit",
  });

  statSync(FINAL_PKG);
}

function notarizePkgIfConfigured(): void {
  const values = [NOTARY_APPLE_ID, NOTARY_TEAM_ID, NOTARY_PASSWORD];
  if (values.every(Boolean)) {
    execFileSync("xcrun", [
      "notarytool",
      "submit",
      FINAL_PKG,
      "--apple-id",
      NOTARY_APPLE_ID!,
      "--team-id",
      NOTARY_TEAM_ID!,
      "--password",
      NOTARY_PASSWORD!,
      "--wait",
    ], {
      cwd: ROOT,
      stdio: "inherit",
    });
    execFileSync("xcrun", ["stapler", "staple", FINAL_PKG], {
      cwd: ROOT,
      stdio: "inherit",
    });
    return;
  }

  if (values.some(Boolean)) {
    throw new Error("Notarization requires AGENT_RUNTIME_NOTARY_APPLE_ID, AGENT_RUNTIME_NOTARY_TEAM_ID, and AGENT_RUNTIME_NOTARY_PASSWORD.");
  }

  if (!SIGN_IDENTITY) {
    console.warn("Warning: package is unsigned. Gatekeeper will block browser-downloaded installs.");
  } else {
    console.warn("Warning: package is signed but not notarized. Gatekeeper may still block browser-downloaded installs.");
  }
}

main();
