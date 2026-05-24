/**
 * compose-up.ts
 *
 * Starts the local Podman machine when needed, waits until the Podman API is
 * usable, then runs `podman compose up -d`.
 *
 * Usage:
 *   npm run compose:up
 */

import { execFileSync, spawnSync } from "child_process";

const PODMAN_CANDIDATES = [
  "podman",
  "C:\\Program Files\\RedHat\\Podman\\podman.exe",
];

function main() {
  const podman = findPodman();
  ensurePodmanMachineReady(podman);
  ensurePodmanCompose(podman);

  console.log("Starting local containers...");
  run(podman, ["compose", "up", "-d"]);
}

function findPodman(): string {
  for (const candidate of PODMAN_CANDIDATES) {
    const result = spawnSync(candidate, ["--version"], { stdio: "pipe" });
    if (result.status === 0) return candidate;
  }

  throw new Error("podman not found. Install Podman Desktop and make sure podman is on PATH.");
}

function ensurePodmanMachineReady(podman: string): void {
  const machines = listPodmanMachines(podman);

  if (machines === null) {
    // Linux native Podman does not need `podman machine`.
    waitForPodmanApi(podman);
    return;
  }

  if (machines.length === 0) {
    throw new Error("No Podman machine exists. Run `podman machine init` once, then retry.");
  }

  if (!machines.some((machine) => machine.Running)) {
    console.log("Podman machine is stopped. Starting it...");
    run(podman, ["machine", "start"]);
  }

  try {
    waitForPodmanApi(podman);
  } catch (err) {
    console.warn(`Podman API did not become ready after machine start: ${(err as Error).message}`);
    console.warn("Retrying with `podman machine stop` then `podman machine start`...");
    spawnSync(podman, ["machine", "stop"], { stdio: "inherit" });
    run(podman, ["machine", "start"]);
    waitForPodmanApi(podman);
  }
}

function listPodmanMachines(podman: string): { Running?: boolean }[] | null {
  const result = spawnSync(podman, ["machine", "ls", "--format", "json"], {
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.status !== 0) return null;

  try {
    const parsed = JSON.parse(result.stdout) as { Running?: boolean }[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }
}

function waitForPodmanApi(podman: string, timeoutMs = 60_000): void {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write("Waiting for Podman API ");

  while (Date.now() < deadline) {
    const result = spawnSync(podman, ["info"], { stdio: "pipe" });
    if (result.status === 0) {
      console.log("✓");
      return;
    }

    process.stdout.write(".");
    sleep(1_000);
  }

  console.log(" ✗");
  throw new Error(`Podman API was not ready within ${timeoutMs / 1000}s.`);
}

function ensurePodmanCompose(podman: string): void {
  const result = spawnSync(podman, ["compose", "version"], { stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error("podman compose is not available. Install the Podman Compose plugin, then retry.");
  }
}

function run(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: "inherit" });
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

main();
