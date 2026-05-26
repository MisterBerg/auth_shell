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
  const machineMode = ensurePodmanMachineReady(podman);
  ensurePodmanCompose(podman);

  console.log("Starting local containers...");
  run(podman, ["compose", "up", "-d"]);
  verifyLocalServiceClocks(podman, machineMode);
}

function findPodman(): string {
  for (const candidate of PODMAN_CANDIDATES) {
    const result = spawnSync(candidate, ["--version"], { stdio: "pipe" });
    if (result.status === 0) return candidate;
  }

  throw new Error("podman not found. Install Podman Desktop and make sure podman is on PATH.");
}

function ensurePodmanMachineReady(podman: string): boolean {
  const machines = listPodmanMachines(podman);

  if (machines === null) {
    // Linux native Podman does not need `podman machine`.
    waitForPodmanApi(podman);
    return false;
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

  return true;
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

function verifyLocalServiceClocks(podman: string, machineMode: boolean): void {
  const services = ["hep-minio", "hep-dynamodb"];
  const hostSeconds = Math.floor(Date.now() / 1000);
  const skewed = services
    .map((service) => {
      const result = spawnSync(podman, ["exec", service, "date", "+%s"], {
        encoding: "utf8",
        stdio: "pipe",
      });
      if (result.status !== 0) return null;
      const serviceSeconds = Number(result.stdout.trim());
      if (!Number.isFinite(serviceSeconds)) return null;
      return {
        service,
        skewSeconds: serviceSeconds - hostSeconds,
      };
    })
    .filter((value): value is { service: string; skewSeconds: number } => Boolean(value));

  const largestSkew = skewed.reduce(
    (max, entry) => Math.max(max, Math.abs(entry.skewSeconds)),
    0,
  );

  if (largestSkew <= 120) return;

  const details = skewed
    .map((entry) => `${entry.service}: ${entry.skewSeconds}s`)
    .join(", ");

  console.warn(`Local container clock skew detected (${details}).`);
  console.warn("AWS/MinIO signed requests can fail with RequestTimeTooSkewed when clocks drift.");

  if (!machineMode) {
    console.warn("Native Linux Podman detected; fix the host clock, then restart the containers.");
    return;
  }

  console.warn("Restarting the Podman machine to resync service time...");
  spawnSync(podman, ["machine", "stop"], { stdio: "inherit" });
  run(podman, ["machine", "start"]);
  waitForPodmanApi(podman);
  run(podman, ["compose", "up", "-d"]);
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

main();
