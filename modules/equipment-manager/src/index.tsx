import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { ExportContext, ModuleProps } from "module-core";
import { useAwsS3Client, useUserProfile } from "module-core";

type TabId = "devices" | "scripts" | "contract";
type ValueMap = Record<string, unknown>;

type EquipmentTransport = "serial" | "tcp-scpi" | "http-rest" | "visa" | "can" | "custom";
type CommandMode = "scpi" | "http" | "raw" | "custom";
type ParserMode = "text" | "json" | "number" | "csv" | "binary" | "none" | "siglent-waveform";
type ArtifactMode = "none" | "text" | "json" | "csv" | "image" | "binary";
type ScriptStepType = "command" | "wait" | "capture" | "note";

type EquipmentCommand = {
  id: string;
  name: string;
  mode: CommandMode;
  payload: string;
  parser: ParserMode;
  timeoutMs: number;
  saveAs?: string;
  artifactMode: ArtifactMode;
  notes?: string;
};

type EquipmentScriptStep = {
  id: string;
  type: ScriptStepType;
  title: string;
  commandId?: string;
  rawCommand?: string;
  waitMs?: number;
  saveAs?: string;
  notes?: string;
};

type EquipmentDevice = {
  id: string;
  name: string;
  transport: EquipmentTransport;
  address: string;
  capabilities: string[];
  notes?: string;
  commands: EquipmentCommand[];
};

type EquipmentScript = {
  id: string;
  name: string;
  deviceId?: string;
  description?: string;
  steps: EquipmentScriptStep[];
};

type EquipmentManagerState = {
  version: 1;
  devices: EquipmentDevice[];
  scripts: EquipmentScript[];
};

type StorageInfo = {
  bucket: string;
  projectId: string;
  basePrefix: string;
  stateKey: string;
};

type BridgeConfig = {
  url: string;
  token?: string;
};

type AgentBridgeDefaults = {
  url?: string;
  token?: string;
};

type BridgeHealth = {
  name?: string;
  protocolVersion?: number;
  capabilities?: string[];
  workspaceRoot?: string | null;
};

type ExecutionResult = {
  scope: "command" | "script";
  title: string;
  startedAt: string;
  commandId?: string;
  scriptId?: string;
  steps?: Array<{ title: string; ok: boolean; output?: unknown }>;
  output?: unknown;
};

type TcpCommandResult = {
  host?: string;
  port?: number;
  command?: string;
  text?: string;
  data?: string;
  bytesBase64?: string;
  bytesLength?: number;
  durationMs?: number;
  readMode?: string;
  timedOut?: boolean;
  matchedMarker?: string;
};

type SiglentWaveformPoint = {
  index: number;
  timeSeconds: number;
  voltage: number;
  rawCode: number;
};

type SiglentWaveformResult = {
  kind: "siglent-waveform";
  channel: string;
  sampleCount: number;
  intervalSeconds: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  minVoltage: number;
  maxVoltage: number;
  metadata: {
    voltsPerDiv: number;
    offsetVolts: number;
    timePerDivSeconds: number;
    triggerDelaySeconds: number;
    sampleRateHz: number;
    grid: number;
  };
  transport: {
    waveformBytes: number;
    setupCommand: string;
    setupReadMode: string;
    queries: Record<string, string>;
  };
  points: SiglentWaveformPoint[];
};

type WaveformCursor = {
  id: string;
  label: string;
  color: string;
  pointIndex: number;
};

type WaveformMathOperation = "dx" | "dy" | "abs-dy" | "slope";

type WaveformMathRow = {
  id: string;
  operation: WaveformMathOperation;
  aCursorId: string;
  bCursorId: string;
};

type KnownDevicePreset = {
  id: string;
  name: string;
  description: string;
  create: () => EquipmentDevice;
};

const C = {
  bg: "var(--hep-bg, #08111d)",
  panel: "var(--hep-surface, #0d1726)",
  panel2: "var(--hep-surface-raised, #101d30)",
  border: "var(--hep-border, #24354f)",
  text: "var(--hep-text, #e5edf8)",
  muted: "var(--hep-muted, #94a3b8)",
  accent: "var(--hep-accent, #2dd4bf)",
  accentText: "var(--hep-accent-text, #041314)",
  accentSoft: "rgba(45,212,191,0.14)",
  input: "#0a1424",
  danger: "#f87171",
  ok: "#34d399",
  header: "linear-gradient(135deg, #08111d, #0f2135 55%, #173149)",
};

const TRANSPORTS: EquipmentTransport[] = ["serial", "tcp-scpi", "http-rest", "visa", "can", "custom"];
const COMMAND_MODES: CommandMode[] = ["scpi", "http", "raw", "custom"];
const PARSER_MODES: ParserMode[] = ["text", "json", "number", "csv", "binary", "none", "siglent-waveform"];
const ARTIFACT_MODES: ArtifactMode[] = ["none", "text", "json", "csv", "image", "binary"];
const STEP_TYPES: ScriptStepType[] = ["command", "wait", "capture", "note"];
const SIGLENT_WAVEFORM_SETUP = "WFSU SP,1,NP,20000,FP,0";
const WAVEFORM_CURSOR_COLORS = ["#ef4444", "#2563eb", "#16a34a", "#d97706", "#7c3aed", "#db2777"];

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : "";
}

function makeId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId ? `${prefix}-${randomId}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toRecord(value: unknown): ValueMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ValueMap : {};
}

function toStringValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function toNumberValue(value: unknown, fallback: number): number {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : fallback;
}

function normalizeCommand(value: unknown, index: number): EquipmentCommand {
  const record = toRecord(value);
  const mode = toStringValue(record.mode, "scpi");
  const parser = toStringValue(record.parser, "text");
  const artifactMode = toStringValue(record.artifactMode ?? record.artifact_mode, "none");
  return {
    id: toStringValue(record.id, `command-${index + 1}`),
    name: toStringValue(record.name, `Command ${index + 1}`),
    mode: COMMAND_MODES.includes(mode as CommandMode) ? mode as CommandMode : "custom",
    payload: toStringValue(record.payload, ""),
    parser: PARSER_MODES.includes(parser as ParserMode) ? parser as ParserMode : "text",
    timeoutMs: toNumberValue(record.timeoutMs ?? record.timeout_ms, 5000),
    saveAs: toStringValue(record.saveAs ?? record.save_as, "") || undefined,
    artifactMode: ARTIFACT_MODES.includes(artifactMode as ArtifactMode) ? artifactMode as ArtifactMode : "none",
    notes: toStringValue(record.notes, "") || undefined,
  };
}

function normalizeStep(value: unknown, index: number): EquipmentScriptStep {
  const record = toRecord(value);
  const type = toStringValue(record.type, "command");
  return {
    id: toStringValue(record.id, `step-${index + 1}`),
    type: STEP_TYPES.includes(type as ScriptStepType) ? type as ScriptStepType : "command",
    title: toStringValue(record.title, `Step ${index + 1}`),
    commandId: toStringValue(record.commandId ?? record.command_id, "") || undefined,
    rawCommand: toStringValue(record.rawCommand ?? record.raw_command, "") || undefined,
    waitMs: typeof record.waitMs === "undefined" && typeof record.wait_ms === "undefined" ? undefined : toNumberValue(record.waitMs ?? record.wait_ms, 1000),
    saveAs: toStringValue(record.saveAs ?? record.save_as, "") || undefined,
    notes: toStringValue(record.notes, "") || undefined,
  };
}

function normalizeDevice(value: unknown, index: number): EquipmentDevice {
  const record = toRecord(value);
  const transport = toStringValue(record.transport, "custom");
  const name = toStringValue(record.name, `Device ${index + 1}`);
  const commands = Array.isArray(record.commands) ? record.commands.map(normalizeCommand) : [];
  const upgradedCommands = /siglent\s+sds1202x-e/i.test(name)
    ? commands.map((command) => {
        if (command.name !== "Capture Screenshot") return command;
        if (command.payload.trim() !== ":DISPlay:DATA? PNG, COLor") return command;
        return {
          ...command,
          payload: "SCDP",
          parser: "binary" as ParserMode,
          timeoutMs: Math.max(command.timeoutMs, 15000),
          artifactMode: "image" as ArtifactMode,
          saveAs: "scope-screen.bmp",
          notes: "Siglent SDS1202X-E screenshot capture returns bitmap bytes over SCPI via the SCDP command.",
        };
      })
    : commands;
  return {
    id: toStringValue(record.id, `device-${index + 1}`),
    name,
    transport: TRANSPORTS.includes(transport as EquipmentTransport) ? transport as EquipmentTransport : "custom",
    address: toStringValue(record.address, ""),
    capabilities: Array.isArray(record.capabilities) ? record.capabilities.map((item) => String(item)).filter(Boolean) : [],
    notes: toStringValue(record.notes, "") || undefined,
    commands: upgradedCommands,
  };
}

function normalizeScript(value: unknown, index: number): EquipmentScript {
  const record = toRecord(value);
  return {
    id: toStringValue(record.id, `script-${index + 1}`),
    name: toStringValue(record.name, `Script ${index + 1}`),
    deviceId: toStringValue(record.deviceId ?? record.device_id, "") || undefined,
    description: toStringValue(record.description, "") || undefined,
    steps: Array.isArray(record.steps) ? record.steps.map(normalizeStep) : [],
  };
}

function createDefaultState(): EquipmentManagerState {
  const demoDeviceId = makeId("device");
  const identifyCommandId = makeId("command");
  const channelScaleCommandId = makeId("command");
  const timebaseCommandId = makeId("command");
  const triggerModeCommandId = makeId("command");
  const captureCommandId = makeId("command");
  return {
    version: 1,
    devices: [{
      id: demoDeviceId,
      name: "Siglent SDS1202X-E",
      transport: "tcp-scpi",
      address: "192.168.0.148:5025",
      capabilities: ["connect", "execute_command", "capture_artifact", "read_data"],
      notes: "Verified on the local network through the bridge. SCPI over TCP responds on port 5025; interactive prompt is also available on 5024.",
      commands: [
        {
          id: identifyCommandId,
          name: "Identify",
          mode: "scpi",
          payload: "*IDN?",
          parser: "text",
          timeoutMs: 3000,
          artifactMode: "text",
          saveAs: "identity.txt",
        },
        {
          id: channelScaleCommandId,
          name: "Read CH1 Scale",
          mode: "scpi",
          payload: "C1:VDIV?",
          parser: "text",
          timeoutMs: 3000,
          artifactMode: "text",
          saveAs: "ch1-scale.txt",
        },
        {
          id: timebaseCommandId,
          name: "Read Timebase",
          mode: "scpi",
          payload: "TDIV?",
          parser: "text",
          timeoutMs: 3000,
          artifactMode: "text",
          saveAs: "timebase.txt",
        },
        {
          id: triggerModeCommandId,
          name: "Read Trigger Mode",
          mode: "scpi",
          payload: "TRMD?",
          parser: "text",
          timeoutMs: 3000,
          artifactMode: "text",
          saveAs: "trigger-mode.txt",
        },
        {
          id: captureCommandId,
          name: "Capture Screenshot",
          mode: "scpi",
          payload: "SCDP",
          parser: "binary",
          timeoutMs: 15000,
          artifactMode: "image",
          saveAs: "scope-screen.bmp",
          notes: "Returns a bitmap screenshot from the instrument over SCPI.",
        },
        {
          id: makeId("command"),
          name: "Capture CH1 Waveform",
          mode: "scpi",
          payload: "C1:WF? DAT2",
          parser: "siglent-waveform",
          timeoutMs: 15000,
          artifactMode: "csv",
          saveAs: "ch1-waveform.csv",
          notes: "Fetches up to 20,000 CH1 waveform samples plus scaling metadata, then renders an interactive waveform chart.",
        },
      ],
    }],
    scripts: [{
      id: makeId("script"),
      name: "Startup Capture",
      deviceId: demoDeviceId,
      description: "Example Siglent workflow that identifies the scope, reads a couple of setup values, waits for a DUT event, then captures an image artifact.",
      steps: [
        { id: makeId("step"), type: "command", title: "Identify instrument", commandId: identifyCommandId, saveAs: "identity.txt", notes: "Later this can be replaced by a richer preset or a raw command step." },
        { id: makeId("step"), type: "command", title: "Read CH1 scale", commandId: channelScaleCommandId, saveAs: "ch1-scale.txt" },
        { id: makeId("step"), type: "command", title: "Read timebase", commandId: timebaseCommandId, saveAs: "timebase.txt" },
        { id: makeId("step"), type: "command", title: "Read trigger mode", commandId: triggerModeCommandId, saveAs: "trigger-mode.txt" },
        { id: makeId("step"), type: "wait", title: "Wait for DUT startup", waitMs: 2000, notes: "This should later support conditional waits and polling loops." },
        { id: makeId("step"), type: "capture", title: "Capture startup screen", commandId: captureCommandId, saveAs: "startup-waveform.png" },
      ],
    }],
  };
}

function normalizeState(value: unknown): EquipmentManagerState {
  const record = toRecord(value);
  return {
    version: 1,
    devices: Array.isArray(record.devices) ? record.devices.map(normalizeDevice) : createDefaultState().devices,
    scripts: Array.isArray(record.scripts) ? record.scripts.map(normalizeScript) : createDefaultState().scripts,
  };
}

function getStorageInfo(config: ModuleProps["config"]): StorageInfo {
  const params = new URLSearchParams(window.location.search);
  const configPath = params.get("config") ?? "";
  const projectDir = dirname(configPath);
  const projectId = configPath.match(/projects\/([^/]+)\//)?.[1] ?? config.id;
  const bucket = (config.meta?.["definitionBucket"] as string | undefined) ?? params.get("bucket") ?? config.app.bucket;
  const basePrefix = projectDir ? `${projectDir}/equipment/${config.id}` : `equipment/${config.id}`;
  return {
    bucket,
    projectId,
    basePrefix,
    stateKey: (config.meta?.["stateKey"] as string | undefined) ?? `${basePrefix}/state.json`,
  };
}

async function readOptionalText(s3: S3Client, bucket: string, key: string): Promise<string | null> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return response.Body?.transformToString("utf-8") ?? null;
  } catch (error: unknown) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === "NoSuchKey" || err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

async function writeText(s3: S3Client, bucket: string, key: string, body: string, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: "no-store",
  }));
}

function buttonStyle(kind: "primary" | "ghost" | "danger" = "ghost"): React.CSSProperties {
  if (kind === "primary") return { border: `1px solid ${C.accent}`, background: C.accent, color: C.accentText, borderRadius: 8, padding: "0.55rem 0.85rem", cursor: "pointer", fontWeight: 700, fontFamily: "inherit" };
  if (kind === "danger") return { border: `1px solid ${C.danger}`, background: "transparent", color: C.danger, borderRadius: 8, padding: "0.45rem 0.75rem", cursor: "pointer", fontWeight: 600, fontFamily: "inherit" };
  return { border: `1px solid ${C.border}`, background: "transparent", color: C.text, borderRadius: 8, padding: "0.55rem 0.85rem", cursor: "pointer", fontWeight: 600, fontFamily: "inherit" };
}

function inputStyle(): React.CSSProperties {
  return { width: "100%", boxSizing: "border-box", background: C.input, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, padding: "0.6rem 0.7rem", font: "inherit" };
}

function labelStyle(): React.CSSProperties {
  return { display: "flex", flexDirection: "column", gap: "0.38rem", color: C.muted, fontSize: "0.78rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" };
}

function cardStyle(): React.CSSProperties {
  return { border: `1px solid ${C.border}`, borderRadius: 16, background: C.panel, padding: "1rem 1.1rem" };
}

function safeReadLocalStorage(key: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function safeWriteLocalStorage(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    if (!value) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Ignore localStorage failures in embedded contexts.
  }
}

function buildBridgeStorageKey(projectId: string, moduleId: string, field: "url" | "token"): string {
  return `auth-shell:equipment-manager:${projectId}:${moduleId}:bridge-${field}`;
}

function readBridgeDefaults(): AgentBridgeDefaults {
  const win = window as unknown as { __AgentBridgeDefaults?: AgentBridgeDefaults };
  return win.__AgentBridgeDefaults ?? {};
}

function findAgentChatBridgeSetting(projectId: string, suffix: "bridge-url" | "bridge-token"): string {
  if (typeof window === "undefined") return "";
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index) ?? "";
      if (!key.startsWith(`auth-shell:agent-chat:${projectId}:`) || !key.endsWith(suffix)) continue;
      const value = window.localStorage.getItem(key);
      if (value?.trim()) return value.trim();
    }
  } catch {
    return "";
  }
  return "";
}

function parseDeviceAddress(address: string): { host: string; port: number } | null {
  const trimmed = address.trim();
  if (!trimmed) return null;

  const tcpipMatch = trimmed.match(/^TCPIP\d*::([^:]+)(?:::([0-9]+))?/i);
  if (tcpipMatch) {
    return {
      host: tcpipMatch[1]!,
      port: tcpipMatch[2] ? Number(tcpipMatch[2]) : 5025,
    };
  }

  const hostPortMatch = trimmed.match(/^([^:]+):([0-9]+)$/);
  if (hostPortMatch) {
    return {
      host: hostPortMatch[1]!,
      port: Number(hostPortMatch[2]),
    };
  }

  return { host: trimmed, port: 5025 };
}

function base64ToBytes(value: string): Uint8Array {
  const decoded = window.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function parseScpiNumber(text: string): number {
  const match = text.match(/(-?\d+(?:\.\d+)?(?:E[+-]?\d+)?)([GMKmunp]?)/);
  if (!match) {
    throw new Error(`Unable to parse numeric value from response: ${text}`);
  }
  const value = Number(match[1]);
  const suffix = match[2] ?? "";
  const multiplier = suffix === "G" ? 1e9
    : suffix === "M" ? 1e6
    : suffix === "K" || suffix === "k" ? 1e3
    : suffix === "m" ? 1e-3
    : suffix === "u" ? 1e-6
    : suffix === "n" ? 1e-9
    : suffix === "p" ? 1e-12
    : 1;
  return value * multiplier;
}

function parseSiglentWaveformChannel(payload: string): string {
  const match = payload.match(/\b(C[1-4])\s*:/i);
  return match?.[1]?.toUpperCase() ?? "C1";
}

function decodeSiglentWaveformBlock(bytesBase64: string): number[] {
  const bytes = base64ToBytes(bytesBase64);
  const hashIndex = bytes.indexOf(35);
  if (hashIndex < 0 || hashIndex + 1 >= bytes.length) {
    throw new Error("Waveform response did not contain a SCPI binary block.");
  }
  const digitCount = bytes[hashIndex + 1] - 48;
  if (digitCount < 1 || digitCount > 9) {
    throw new Error("Waveform response contained an invalid binary-block length header.");
  }
  const lengthText = new TextDecoder().decode(bytes.slice(hashIndex + 2, hashIndex + 2 + digitCount));
  const blockLength = Number(lengthText);
  if (!Number.isFinite(blockLength) || blockLength < 0) {
    throw new Error("Waveform response contained an invalid binary-block length value.");
  }
  const dataStart = hashIndex + 2 + digitCount;
  const dataEnd = dataStart + blockLength;
  if (dataEnd > bytes.length) {
    throw new Error("Waveform response ended before the advertised binary block length.");
  }
  const samples: number[] = [];
  for (const value of bytes.slice(dataStart, dataEnd)) {
    // Siglent's SDS1000X-E programming guide describes converting values above 127 by subtracting 255.
    samples.push(value > 127 ? value - 255 : value);
  }
  return samples;
}

function buildSiglentWaveformResult(args: {
  channel: string;
  waveform: TcpCommandResult;
  voltsPerDivResponse: string;
  offsetResponse: string;
  timeDivResponse: string;
  triggerDelayResponse: string;
  sampleRateResponse: string;
}): SiglentWaveformResult {
  const voltsPerDiv = parseScpiNumber(args.voltsPerDivResponse);
  const offsetVolts = parseScpiNumber(args.offsetResponse);
  const timePerDivSeconds = parseScpiNumber(args.timeDivResponse);
  const triggerDelaySeconds = parseScpiNumber(args.triggerDelayResponse);
  const sampleRateHz = parseScpiNumber(args.sampleRateResponse);
  const grid = 14;
  const codes = decodeSiglentWaveformBlock(args.waveform.bytesBase64 ?? "");
  const intervalSeconds = 1 / sampleRateHz;
  const startTimeSeconds = triggerDelaySeconds - (timePerDivSeconds * grid / 2);
  const points = codes.map((rawCode, index) => ({
    index,
    rawCode,
    timeSeconds: startTimeSeconds + (index * intervalSeconds),
    voltage: rawCode * (voltsPerDiv / 25) - offsetVolts,
  }));
  const minVoltage = points.length ? points.reduce((min, point) => Math.min(min, point.voltage), Number.POSITIVE_INFINITY) : 0;
  const maxVoltage = points.length ? points.reduce((max, point) => Math.max(max, point.voltage), Number.NEGATIVE_INFINITY) : 0;
  return {
    kind: "siglent-waveform",
    channel: args.channel,
    sampleCount: points.length,
    intervalSeconds,
    startTimeSeconds,
    endTimeSeconds: points.length > 0 ? points[points.length - 1]!.timeSeconds : startTimeSeconds,
    minVoltage,
    maxVoltage,
    metadata: {
      voltsPerDiv,
      offsetVolts,
      timePerDivSeconds,
      triggerDelaySeconds,
      sampleRateHz,
      grid,
    },
    transport: {
      waveformBytes: args.waveform.bytesLength ?? 0,
      setupCommand: SIGLENT_WAVEFORM_SETUP,
      setupReadMode: "none",
      queries: {
        voltsPerDiv: args.voltsPerDivResponse,
        offset: args.offsetResponse,
        timeDiv: args.timeDivResponse,
        triggerDelay: args.triggerDelayResponse,
        sampleRate: args.sampleRateResponse,
      },
    },
    points,
  };
}

async function callBridge<T>(bridge: BridgeConfig, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${bridge.url.replace(/\/$/, "")}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bridge.token ? { Authorization: `Bearer ${bridge.token}` } : {}),
    },
    body: JSON.stringify({ method, params }),
  });

  const payload = await response.json() as { ok: boolean; result?: T; error?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Bridge request failed with status ${response.status}.`);
  }
  return payload.result as T;
}

function summarizeExecutionValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= 500) return value;
    return `${value.slice(0, 240)}\n... [truncated ${value.length - 480} chars] ...\n${value.slice(-240)}`;
  }

  if (Array.isArray(value)) {
    if (value.length > 200) {
      return `[array omitted from raw view, length=${value.length}]`;
    }
    return value.map(summarizeExecutionValue);
  }

  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input)) {
      if ((key === "bytesBase64" || key === "data" || key === "text") && typeof entry === "string" && entry.length > 500) {
        output[key] = `[${key} omitted from raw view, length=${entry.length}]`;
        continue;
      }
      output[key] = summarizeExecutionValue(entry);
    }
    return output;
  }

  return value;
}

function renderExecutionOutput(value: unknown): string {
  try {
    return JSON.stringify(summarizeExecutionValue(value), null, 2);
  } catch {
    return String(value);
  }
}

function isTcpCommandResult(value: unknown): value is { text?: string; bytesBase64?: string; data?: string; bytesLength?: number } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record["text"] === "string" || typeof record["bytesBase64"] === "string";
}

function isSiglentWaveformResult(value: unknown): value is SiglentWaveformResult {
  if (!value || typeof value !== "object") return false;
  return (value as { kind?: string }).kind === "siglent-waveform";
}

function guessImageMimeType(command: EquipmentCommand): string {
  const saveAs = (command.saveAs ?? "").toLowerCase();
  if (saveAs.endsWith(".jpg") || saveAs.endsWith(".jpeg")) return "image/jpeg";
  if (saveAs.endsWith(".bmp")) return "image/bmp";
  if (saveAs.endsWith(".gif")) return "image/gif";
  return "image/png";
}

function formatEngineeringTime(seconds: number): string {
  const absolute = Math.abs(seconds);
  if (absolute >= 1) return `${seconds.toFixed(6)} s`;
  if (absolute >= 1e-3) return `${(seconds * 1e3).toFixed(3)} ms`;
  if (absolute >= 1e-6) return `${(seconds * 1e6).toFixed(3)} us`;
  if (absolute >= 1e-9) return `${(seconds * 1e9).toFixed(3)} ns`;
  return `${(seconds * 1e12).toFixed(3)} ps`;
}

function formatEngineeringVoltage(volts: number): string {
  const absolute = Math.abs(volts);
  if (absolute >= 1) return `${volts.toFixed(4)} V`;
  if (absolute >= 1e-3) return `${(volts * 1e3).toFixed(3)} mV`;
  if (absolute >= 1e-6) return `${(volts * 1e6).toFixed(3)} uV`;
  return `${(volts * 1e9).toFixed(3)} nV`;
}

function WaveformChart({ result }: { result: SiglentWaveformResult }) {
  const [visibleRange, setVisibleRange] = useState<[number, number]>([0, result.sampleCount]);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const dragRef = useRef<{ startX: number; startRange: [number, number] } | null>(null);

  useEffect(() => {
    setVisibleRange([0, result.sampleCount]);
    setHoverIndex(null);
  }, [result.channel, result.sampleCount, result.startTimeSeconds, result.endTimeSeconds]);

  const clampedRange = useMemo<[number, number]>(() => {
    const start = Math.max(0, Math.min(result.sampleCount - 1, Math.floor(visibleRange[0])));
    const end = Math.max(start + 2, Math.min(result.sampleCount, Math.ceil(visibleRange[1])));
    return [start, end];
  }, [result.sampleCount, visibleRange]);

  const visiblePoints = useMemo(() => {
    const [start, end] = clampedRange;
    const slice = result.points.slice(start, end);
    const maxRenderedPoints = 1200;
    if (slice.length <= maxRenderedPoints) return slice;
    const step = Math.ceil(slice.length / maxRenderedPoints);
    return slice.filter((_, index) => index % step === 0 || index === slice.length - 1);
  }, [clampedRange, result.points]);

  const hoverPoint = hoverIndex === null ? null : result.points[Math.max(0, Math.min(result.points.length - 1, hoverIndex))] ?? null;
  const visibleMinVoltage = visiblePoints.length ? Math.min(...visiblePoints.map((point) => point.voltage)) : result.minVoltage;
  const visibleMaxVoltage = visiblePoints.length ? Math.max(...visiblePoints.map((point) => point.voltage)) : result.maxVoltage;
  const voltageSpan = Math.max(visibleMaxVoltage - visibleMinVoltage, 1e-9);
  const timeStart = visiblePoints[0]?.timeSeconds ?? result.startTimeSeconds;
  const timeEnd = visiblePoints[visiblePoints.length - 1]?.timeSeconds ?? result.endTimeSeconds;
  const timeSpan = Math.max(timeEnd - timeStart, result.intervalSeconds);

  const polylinePoints = visiblePoints.map((point) => {
    const x = ((point.timeSeconds - timeStart) / timeSpan) * 1000;
    const y = 360 - (((point.voltage - visibleMinVoltage) / voltageSpan) * 360);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");

  const updateHoverFromClientX = (clientX: number, bounds: DOMRect) => {
    const fraction = Math.max(0, Math.min(1, (clientX - bounds.left) / Math.max(1, bounds.width)));
    const [start, end] = clampedRange;
    const index = start + Math.round(fraction * Math.max(0, end - start - 1));
    setHoverIndex(index);
  };

  return (
    <div style={{ display: "grid", gap: "0.85rem" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem", alignItems: "center" }}>
        <button onClick={() => setVisibleRange([0, result.sampleCount])} style={buttonStyle()}>Full View</button>
        <div style={{ color: C.muted, fontSize: "0.82rem" }}>
          {result.sampleCount.toLocaleString()} samples · {formatEngineeringTime(timeEnd - timeStart)} visible span · {formatEngineeringVoltage(visibleMaxVoltage - visibleMinVoltage)} vertical span
        </div>
      </div>
      <div
        style={{ border: `1px solid ${C.border}`, borderRadius: 12, background: "#06101a", padding: "0.75rem", overflow: "hidden" }}
        onWheel={(event) => {
          event.preventDefault();
          const bounds = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
          const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
          const [start, end] = clampedRange;
          const currentSpan = end - start;
          const nextSpan = Math.max(50, Math.min(result.sampleCount, Math.round(currentSpan * (event.deltaY > 0 ? 1.2 : 0.8))));
          const center = start + (currentSpan * fraction);
          let nextStart = Math.round(center - (nextSpan * fraction));
          let nextEnd = nextStart + nextSpan;
          if (nextStart < 0) {
            nextStart = 0;
            nextEnd = nextSpan;
          }
          if (nextEnd > result.sampleCount) {
            nextEnd = result.sampleCount;
            nextStart = Math.max(0, nextEnd - nextSpan);
          }
          setVisibleRange([nextStart, nextEnd]);
        }}
        onPointerMove={(event) => {
          const bounds = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
          updateHoverFromClientX(event.clientX, bounds);
          if (!dragRef.current) return;
          const pixelDelta = event.clientX - dragRef.current.startX;
          const pointsPerPixel = (dragRef.current.startRange[1] - dragRef.current.startRange[0]) / Math.max(1, bounds.width);
          const pointDelta = Math.round(pixelDelta * pointsPerPixel);
          let nextStart = dragRef.current.startRange[0] - pointDelta;
          let nextEnd = dragRef.current.startRange[1] - pointDelta;
          const span = nextEnd - nextStart;
          if (nextStart < 0) {
            nextStart = 0;
            nextEnd = span;
          }
          if (nextEnd > result.sampleCount) {
            nextEnd = result.sampleCount;
            nextStart = Math.max(0, nextEnd - span);
          }
          setVisibleRange([nextStart, nextEnd]);
        }}
        onPointerLeave={() => {
          dragRef.current = null;
          setHoverIndex(null);
        }}
        onPointerDown={(event) => {
          dragRef.current = { startX: event.clientX, startRange: clampedRange };
          (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
        }}
        onPointerUp={(event) => {
          dragRef.current = null;
          (event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId);
        }}
      >
        <svg viewBox="0 0 1000 360" style={{ display: "block", width: "100%", height: 360, background: "#ffffff", borderRadius: 8 }}>
          <rect x="0" y="0" width="1000" height="360" fill="#ffffff" />
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
            <line key={`h-${fraction}`} x1="0" x2="1000" y1={360 - (360 * fraction)} y2={360 - (360 * fraction)} stroke="#d8e0ea" strokeWidth="1" />
          ))}
          {[0, 0.2, 0.4, 0.6, 0.8, 1].map((fraction) => (
            <line key={`v-${fraction}`} x1={1000 * fraction} x2={1000 * fraction} y1="0" y2="360" stroke="#e5ebf3" strokeWidth="1" />
          ))}
          <polyline fill="none" stroke="#0f766e" strokeWidth="2" points={polylinePoints} />
          {hoverPoint ? (
            <>
              <line
                x1={((hoverPoint.timeSeconds - timeStart) / timeSpan) * 1000}
                x2={((hoverPoint.timeSeconds - timeStart) / timeSpan) * 1000}
                y1="0"
                y2="360"
                stroke="#fb7185"
                strokeDasharray="6 6"
              />
              <circle
                cx={((hoverPoint.timeSeconds - timeStart) / timeSpan) * 1000}
                cy={360 - (((hoverPoint.voltage - visibleMinVoltage) / voltageSpan) * 360)}
                r="4"
                fill="#fb7185"
              />
            </>
          ) : null}
        </svg>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "0.75rem" }}>
        <div style={{ ...cardStyle(), padding: "0.75rem 0.85rem" }}>
          <div style={{ fontSize: "0.76rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Cursor</div>
          <div style={{ marginTop: "0.45rem", color: C.text, fontSize: "0.88rem", lineHeight: 1.6 }}>
            {hoverPoint ? `${formatEngineeringTime(hoverPoint.timeSeconds)} · ${formatEngineeringVoltage(hoverPoint.voltage)}` : "Move over the chart to inspect a point."}
          </div>
        </div>
        <div style={{ ...cardStyle(), padding: "0.75rem 0.85rem" }}>
          <div style={{ fontSize: "0.76rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Scaling</div>
          <div style={{ marginTop: "0.45rem", color: C.text, fontSize: "0.88rem", lineHeight: 1.6 }}>
            {formatEngineeringVoltage(result.metadata.voltsPerDiv)}/div · {formatEngineeringTime(result.metadata.timePerDivSeconds)}/div
          </div>
        </div>
        <div style={{ ...cardStyle(), padding: "0.75rem 0.85rem" }}>
          <div style={{ fontSize: "0.76rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Sample Rate</div>
          <div style={{ marginTop: "0.45rem", color: C.text, fontSize: "0.88rem", lineHeight: 1.6 }}>
            {(result.metadata.sampleRateHz / 1e6).toFixed(3)} MSa/s · {formatEngineeringTime(result.intervalSeconds)} interval
          </div>
        </div>
      </div>
    </div>
  );
}

function WaveformChartInteractive({ result }: { result: SiglentWaveformResult }) {
  const [visibleRange, setVisibleRange] = useState<[number, number]>([0, result.sampleCount]);
  const [yRange, setYRange] = useState<[number, number]>([result.minVoltage, result.maxVoltage]);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [cursorMode, setCursorMode] = useState(false);
  const [cursors, setCursors] = useState<WaveformCursor[]>([]);
  const [mathRows, setMathRows] = useState<WaveformMathRow[]>([]);
  const dragRef = useRef<{ startX: number; startRange: [number, number] } | null>(null);

  useEffect(() => {
    setVisibleRange([0, result.sampleCount]);
    setYRange([result.minVoltage, result.maxVoltage]);
    setHoverIndex(null);
    setCursorMode(false);
    setCursors([]);
    setMathRows([]);
  }, [result.channel, result.sampleCount, result.startTimeSeconds, result.endTimeSeconds, result.minVoltage, result.maxVoltage]);

  const clampedRange = useMemo<[number, number]>(() => {
    const start = Math.max(0, Math.min(result.sampleCount - 2, Math.floor(visibleRange[0])));
    const end = Math.max(start + 2, Math.min(result.sampleCount, Math.ceil(visibleRange[1])));
    return [start, end];
  }, [result.sampleCount, visibleRange]);

  const visiblePoints = useMemo(() => {
    const [start, end] = clampedRange;
    const slice = result.points.slice(start, end);
    const maxRenderedPoints = 1500;
    if (slice.length <= maxRenderedPoints) return slice;
    const step = Math.ceil(slice.length / maxRenderedPoints);
    return slice.filter((_, index) => index % step === 0 || index === slice.length - 1);
  }, [clampedRange, result.points]);

  const yMin = Math.min(yRange[0], yRange[1]);
  const yMax = Math.max(yRange[0], yRange[1]);
  const voltageSpan = Math.max(yMax - yMin, 1e-9);
  const timeStart = result.points[clampedRange[0]]?.timeSeconds ?? result.startTimeSeconds;
  const timeEnd = result.points[Math.max(clampedRange[0], clampedRange[1] - 1)]?.timeSeconds ?? result.endTimeSeconds;
  const timeSpan = Math.max(timeEnd - timeStart, result.intervalSeconds);
  const hoverPoint = hoverIndex === null ? null : result.points[Math.max(0, Math.min(result.points.length - 1, hoverIndex))] ?? null;

  const cursorOptions = cursors
    .map((cursor) => ({ ...cursor, point: result.points[cursor.pointIndex] ?? null }))
    .filter((cursor): cursor is WaveformCursor & { point: SiglentWaveformPoint } => Boolean(cursor.point));

  const polylinePoints = visiblePoints.map((point) => {
    const x = ((point.timeSeconds - timeStart) / timeSpan) * 1000;
    const y = 360 - (((point.voltage - yMin) / voltageSpan) * 360);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");

  const xGridLines = Array.from({ length: 11 }, (_, index) => {
    const fraction = index / 10;
    return { x: 1000 * fraction, value: timeStart + (timeSpan * fraction) };
  });
  const yGridLines = Array.from({ length: 11 }, (_, index) => {
    const fraction = index / 10;
    return { y: 360 - (360 * fraction), value: yMin + (voltageSpan * fraction) };
  });

  const updateHoverFromPoint = (clientX: number, bounds: DOMRect) => {
    const fraction = Math.max(0, Math.min(1, (clientX - bounds.left) / Math.max(1, bounds.width)));
    const [start, end] = clampedRange;
    const index = start + Math.round(fraction * Math.max(0, end - start - 1));
    setHoverIndex(index);
    return index;
  };

  const xWindowSize = clampedRange[1] - clampedRange[0];
  const maxXStart = Math.max(0, result.sampleCount - xWindowSize);
  const yWindowSize = Math.max(yMax - yMin, 1e-9);
  const yCenter = (yMin + yMax) / 2;
  const fullYMin = result.minVoltage - (yWindowSize * 0.25);
  const fullYMax = result.maxVoltage + (yWindowSize * 0.25);
  const minYCenter = fullYMin + (yWindowSize / 2);
  const maxYCenter = fullYMax - (yWindowSize / 2);

  const mathResults = mathRows.map((row) => {
    const a = cursorOptions.find((cursor) => cursor.id === row.aCursorId)?.point;
    const b = cursorOptions.find((cursor) => cursor.id === row.bCursorId)?.point;
    if (!a || !b) return { row, label: "Select two cursors." };
    const dx = b.timeSeconds - a.timeSeconds;
    const dy = b.voltage - a.voltage;
    if (row.operation === "dx") return { row, label: `${formatEngineeringTime(dx)} (x2 - x1)` };
    if (row.operation === "dy") return { row, label: `${formatEngineeringVoltage(dy)} (y2 - y1)` };
    if (row.operation === "abs-dy") return { row, label: `${formatEngineeringVoltage(Math.abs(dy))} |y2 - y1|` };
    return { row, label: `${(dy / Math.max(Math.abs(dx), 1e-18)).toFixed(6)} V/s slope` };
  });

  return (
    <div style={{ display: "grid", gap: "0.85rem" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem", alignItems: "center" }}>
        <button onClick={() => { setVisibleRange([0, result.sampleCount]); setYRange([result.minVoltage, result.maxVoltage]); }} style={buttonStyle()}>Full View</button>
        <button onClick={() => setCursorMode((current) => !current)} style={buttonStyle(cursorMode ? "primary" : "ghost")}>
          {cursorMode ? "Click Chart To Place Cursor" : "Add Cursors"}
        </button>
        <button
          onClick={() => {
            if (cursorOptions.length < 2) return;
            setMathRows((current) => [...current, {
              id: makeId("math"),
              operation: "dx",
              aCursorId: cursorOptions[0]?.id ?? "",
              bCursorId: cursorOptions[1]?.id ?? cursorOptions[0]?.id ?? "",
            }]);
          }}
          style={buttonStyle()}
          disabled={cursorOptions.length < 2}
        >
          Add Math
        </button>
        <div style={{ color: C.muted, fontSize: "0.82rem" }}>
          {result.sampleCount.toLocaleString()} samples · {formatEngineeringTime(timeSpan)} visible span · {formatEngineeringVoltage(voltageSpan)} visible vertical span
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 52px", gap: "0.75rem", alignItems: "stretch" }}>
        <div
          style={{ border: `1px solid ${C.border}`, borderRadius: 12, background: "#06101a", padding: "0.75rem", overflow: "hidden", overscrollBehavior: "contain", userSelect: "none", WebkitUserSelect: "none" as React.CSSProperties["WebkitUserSelect"] }}
          onWheelCapture={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onWheel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const bounds = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
            if (event.shiftKey) {
              const nextSpan = Math.max(1e-6, Math.min(fullYMax - fullYMin, yWindowSize * (event.deltaY > 0 ? 1.2 : 0.8)));
              const focusFraction = Math.max(0, Math.min(1, (bounds.bottom - event.clientY) / Math.max(1, bounds.height)));
              const focusValue = yMin + (voltageSpan * focusFraction);
              let nextMin = focusValue - (nextSpan * focusFraction);
              let nextMax = nextMin + nextSpan;
              if (nextMin < fullYMin) {
                nextMin = fullYMin;
                nextMax = nextMin + nextSpan;
              }
              if (nextMax > fullYMax) {
                nextMax = fullYMax;
                nextMin = nextMax - nextSpan;
              }
              setYRange([nextMin, nextMax]);
              return;
            }
            const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
            const currentSpan = clampedRange[1] - clampedRange[0];
            const nextSpan = Math.max(50, Math.min(result.sampleCount, Math.round(currentSpan * (event.deltaY > 0 ? 1.2 : 0.8))));
            const center = clampedRange[0] + (currentSpan * fraction);
            let nextStart = Math.round(center - (nextSpan * fraction));
            let nextEnd = nextStart + nextSpan;
            if (nextStart < 0) {
              nextStart = 0;
              nextEnd = nextSpan;
            }
            if (nextEnd > result.sampleCount) {
              nextEnd = result.sampleCount;
              nextStart = Math.max(0, nextEnd - nextSpan);
            }
            setVisibleRange([nextStart, nextEnd]);
          }}
          onPointerMove={(event) => {
            const bounds = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
            updateHoverFromPoint(event.clientX, bounds);
            if (!dragRef.current) return;
            const pixelDelta = event.clientX - dragRef.current.startX;
            const pointsPerPixel = (dragRef.current.startRange[1] - dragRef.current.startRange[0]) / Math.max(1, bounds.width);
            const pointDelta = Math.round(pixelDelta * pointsPerPixel);
            let nextStart = dragRef.current.startRange[0] - pointDelta;
            let nextEnd = dragRef.current.startRange[1] - pointDelta;
            const span = nextEnd - nextStart;
            if (nextStart < 0) {
              nextStart = 0;
              nextEnd = span;
            }
            if (nextEnd > result.sampleCount) {
              nextEnd = result.sampleCount;
              nextStart = Math.max(0, nextEnd - span);
            }
            setVisibleRange([nextStart, nextEnd]);
          }}
          onPointerLeave={() => {
            dragRef.current = null;
            setHoverIndex(null);
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            const bounds = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
            const index = updateHoverFromPoint(event.clientX, bounds);
            if (cursorMode) {
              const color = WAVEFORM_CURSOR_COLORS[cursors.length % WAVEFORM_CURSOR_COLORS.length] ?? "#ef4444";
              setCursors((current) => [...current, { id: makeId("cursor"), label: `C${current.length + 1}`, color, pointIndex: index }]);
              setCursorMode(false);
              return;
            }
            dragRef.current = { startX: event.clientX, startRange: clampedRange };
            (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
          }}
          onPointerUp={(event) => {
            dragRef.current = null;
            (event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId);
          }}
        >
          <svg viewBox="0 0 1000 360" style={{ display: "block", width: "100%", height: 360, background: "#ffffff", borderRadius: 8, userSelect: "none", WebkitUserSelect: "none" as React.CSSProperties["WebkitUserSelect"] }}>
            <rect x="0" y="0" width="1000" height="360" fill="#ffffff" />
            {yGridLines.map((line, index) => (
              <g key={`h-${index}`}>
                <line x1="0" x2="1000" y1={line.y} y2={line.y} stroke="#dde5ee" strokeWidth="1" />
                <text x="6" y={Math.max(12, Math.min(354, line.y - 4))} fill="#5b6b7f" fontSize="11">{formatEngineeringVoltage(line.value)}</text>
              </g>
            ))}
            {xGridLines.map((line, index) => (
              <g key={`v-${index}`}>
                <line x1={line.x} x2={line.x} y1="0" y2="360" stroke="#e8edf5" strokeWidth="1" />
                <text x={Math.max(4, Math.min(930, line.x + 4))} y="354" fill="#5b6b7f" fontSize="11">{formatEngineeringTime(line.value)}</text>
              </g>
            ))}
            <polyline fill="none" stroke="#0f766e" strokeWidth="2" points={polylinePoints} />
            {cursorOptions.map((cursor) => {
              const x = ((cursor.point.timeSeconds - timeStart) / timeSpan) * 1000;
              const y = 360 - (((cursor.point.voltage - yMin) / voltageSpan) * 360);
              return (
                <g key={cursor.id}>
                  <line x1={x} x2={x} y1="0" y2="360" stroke={cursor.color} strokeDasharray="8 6" strokeWidth="2" />
                  <line x1="0" x2="1000" y1={y} y2={y} stroke={cursor.color} strokeDasharray="8 6" strokeWidth="2" opacity="0.9" />
                  <circle cx={x} cy={y} r="4.5" fill={cursor.color} />
                  <rect x={Math.min(760, x + 8)} y={Math.max(6, y - 28)} width="236" height="24" rx="6" fill={cursor.color} opacity="0.95" />
                  <text x={Math.min(772, x + 18)} y={Math.max(22, y - 12)} fill="#ffffff" fontSize="11" fontWeight="700">
                    {`${cursor.label} ${formatEngineeringTime(cursor.point.timeSeconds)} ${formatEngineeringVoltage(cursor.point.voltage)}`}
                  </text>
                </g>
              );
            })}
            {hoverPoint ? (
              <>
                <line x1={((hoverPoint.timeSeconds - timeStart) / timeSpan) * 1000} x2={((hoverPoint.timeSeconds - timeStart) / timeSpan) * 1000} y1="0" y2="360" stroke="#fb7185" strokeDasharray="6 6" />
                <circle cx={((hoverPoint.timeSeconds - timeStart) / timeSpan) * 1000} cy={360 - (((hoverPoint.voltage - yMin) / voltageSpan) * 360)} r="4" fill="#fb7185" />
              </>
            ) : null}
          </svg>
        </div>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", paddingBlock: "1rem" }}>
          <input
            type="range"
            min={minYCenter}
            max={maxYCenter}
            step={Math.max((maxYCenter - minYCenter) / 200, 1e-9)}
            value={Math.max(minYCenter, Math.min(maxYCenter, yCenter))}
            onChange={(event) => {
              const nextCenter = Number(event.target.value);
              setYRange([nextCenter - (yWindowSize / 2), nextCenter + (yWindowSize / 2)]);
            }}
            style={{ width: 240, transform: "rotate(-90deg)" }}
          />
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={maxXStart}
        step={1}
        value={Math.min(maxXStart, clampedRange[0])}
        onChange={(event) => {
          const start = Number(event.target.value);
          setVisibleRange([start, start + xWindowSize]);
        }}
        style={{ width: "100%" }}
      />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.75rem" }}>
        <div style={{ ...cardStyle(), padding: "0.75rem 0.85rem" }}>
          <div style={{ fontSize: "0.76rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Cursor</div>
          <div style={{ marginTop: "0.45rem", color: C.text, fontSize: "0.88rem", lineHeight: 1.6 }}>
            {hoverPoint ? `${formatEngineeringTime(hoverPoint.timeSeconds)} · ${formatEngineeringVoltage(hoverPoint.voltage)}` : "Move over the chart to inspect a point."}
          </div>
        </div>
        <div style={{ ...cardStyle(), padding: "0.75rem 0.85rem" }}>
          <div style={{ fontSize: "0.76rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Scaling</div>
          <div style={{ marginTop: "0.45rem", color: C.text, fontSize: "0.88rem", lineHeight: 1.6 }}>
            {formatEngineeringVoltage(result.metadata.voltsPerDiv)}/div · {formatEngineeringTime(result.metadata.timePerDivSeconds)}/div
          </div>
        </div>
        <div style={{ ...cardStyle(), padding: "0.75rem 0.85rem" }}>
          <div style={{ fontSize: "0.76rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Sample Rate</div>
          <div style={{ marginTop: "0.45rem", color: C.text, fontSize: "0.88rem", lineHeight: 1.6 }}>
            {(result.metadata.sampleRateHz / 1e6).toFixed(3)} MSa/s · {formatEngineeringTime(result.intervalSeconds)} interval
          </div>
        </div>
      </div>
      {cursorOptions.length ? (
        <section style={cardStyle()}>
          <div style={{ fontSize: "0.76rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Placed Cursors</div>
          <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.55rem" }}>
            {cursorOptions.map((cursor) => (
              <div key={cursor.id} style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", border: `1px solid ${C.border}`, borderRadius: 10, padding: "0.6rem 0.75rem", background: C.panel2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.65rem" }}>
                  <span style={{ width: 12, height: 12, borderRadius: 999, background: cursor.color, display: "inline-block" }} />
                  <strong>{cursor.label}</strong>
                  <span style={{ color: C.muted, fontSize: "0.84rem" }}>{formatEngineeringTime(cursor.point.timeSeconds)} · {formatEngineeringVoltage(cursor.point.voltage)}</span>
                </div>
                <button onClick={() => setCursors((current) => current.filter((entry) => entry.id !== cursor.id))} style={buttonStyle("danger")}>Remove</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {mathRows.length ? (
        <section style={cardStyle()}>
          <div style={{ fontSize: "0.76rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Math</div>
          <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.7rem" }}>
            {mathRows.map((row, index) => (
              <div key={row.id} style={{ display: "grid", gridTemplateColumns: "minmax(140px, 170px) minmax(120px, 1fr) minmax(120px, 1fr) minmax(180px, 1fr) auto", gap: "0.6rem", alignItems: "center" }}>
                <select value={row.operation} onChange={(event) => setMathRows((current) => current.map((entry) => entry.id === row.id ? { ...entry, operation: event.target.value as WaveformMathOperation } : entry))} style={inputStyle()}>
                  <option value="dx">x2 - x1</option>
                  <option value="dy">y2 - y1</option>
                  <option value="abs-dy">|y2 - y1|</option>
                  <option value="slope">slope</option>
                </select>
                <select value={row.aCursorId} onChange={(event) => setMathRows((current) => current.map((entry) => entry.id === row.id ? { ...entry, aCursorId: event.target.value } : entry))} style={inputStyle()}>
                  {cursorOptions.map((cursor) => <option key={`${row.id}-a-${cursor.id}`} value={cursor.id}>{cursor.label}</option>)}
                </select>
                <select value={row.bCursorId} onChange={(event) => setMathRows((current) => current.map((entry) => entry.id === row.id ? { ...entry, bCursorId: event.target.value } : entry))} style={inputStyle()}>
                  {cursorOptions.map((cursor) => <option key={`${row.id}-b-${cursor.id}`} value={cursor.id}>{cursor.label}</option>)}
                </select>
                <div style={{ color: C.text, fontSize: "0.88rem" }}>{mathResults[index]?.label ?? "No result"}</div>
                <button onClick={() => setMathRows((current) => current.filter((entry) => entry.id !== row.id))} style={buttonStyle("danger")}>Remove</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function buildTcpExecutionParams(target: { host: string; port: number }, command: EquipmentCommand): Record<string, unknown> {
  const isBinaryArtifact = command.artifactMode === "image" || command.artifactMode === "binary" || command.parser === "binary";
  return {
    host: target.host,
    port: target.port,
    command: command.payload,
    readMode: isBinaryArtifact ? "until-timeout" : "once",
    timeoutMs: command.timeoutMs || (isBinaryArtifact ? 15000 : 5000),
    quietMs: isBinaryArtifact ? 1000 : 250,
    encoding: isBinaryArtifact ? "base64" : "utf8",
  };
}

async function fetchTcpText(bridge: BridgeConfig, target: { host: string; port: number }, command: string, timeoutMs = 5000): Promise<string> {
  const result = await callBridge<TcpCommandResult>(bridge, "execute_tcp_command", {
    host: target.host,
    port: target.port,
    command,
    readMode: "once",
    timeoutMs,
    encoding: "utf8",
  });
  return result.text ?? result.data ?? "";
}

function ContractView({ state }: { state: EquipmentManagerState }) {
  const contractExample = useMemo(() => JSON.stringify({
    runtimeContract: {
      get_capabilities: { returns: ["capabilities", "targets", "transports"] },
      connect: { args: ["deviceId", "target?"], returns: ["sessionId", "status"] },
      disconnect: { args: ["sessionId"], returns: ["status"] },
      enumerate_targets: { args: ["deviceId"], returns: ["targets[]"] },
      execute_command: { args: ["deviceId", "command"], returns: ["data", "artifacts[]", "metadata"] },
      execute_script: { args: ["deviceId", "scriptId|script"], returns: ["steps[]", "artifacts[]", "outputs"] },
      read_data: { args: ["deviceId", "path|channel"], returns: ["data"] },
      capture_artifact: { args: ["deviceId", "kind", "options?"], returns: ["artifact"] },
      subscribe: { args: ["deviceId", "stream"], returns: ["subscriptionId"] },
      stop: { args: ["sessionId|subscriptionId"], returns: ["status"] },
    },
    bridgeDirection: {
      localRuntime: true,
      deviceDiscovery: true,
      scriptExecution: true,
      rawCommands: true,
      resultCapture: true,
    },
  }, null, 2), []);

  const yamlExample = useMemo(() => [
    "equipment_runtime:",
    "  - id: scope_main",
    "    label: Primary Scope",
    "    provider: equipment-manager",
    "    mode: assisted",
    "    actions:",
    "      - connect",
    "      - execute_script",
    "      - capture_artifact",
    "    outputs:",
    "      - waveform_png",
    "      - waveform_csv",
    "    notes: Bind this role to an equipment-manager device profile and script.",
    "",
    "test_steps:",
    "  - id: capture_startup_waveform",
    "    title: Capture startup waveform",
    "    instruction: Run the startup capture script against the primary scope.",
    "    expected: A waveform image and CSV are stored automatically in the test run.",
  ].join("\n"), []);

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <section style={cardStyle()}>
        <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Vision</div>
        <p style={{ margin: "0.85rem 0 0", color: C.text, lineHeight: 1.7 }}>
          Equipment Manager is intended to define reusable device profiles and script plans that can be executed through the local bridge,
          embedded in test-manager flows, or used standalone in a lab automation workspace.
        </p>
      </section>
      <section style={cardStyle()}>
        <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Runtime Contract</div>
        <pre style={{ margin: "0.85rem 0 0", padding: "0.9rem", borderRadius: 12, background: "#07111e", color: "#d6ecff", overflowX: "auto", fontSize: "0.84rem", lineHeight: 1.55 }}>{contractExample}</pre>
      </section>
      <section style={cardStyle()}>
        <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Test Manager YAML Direction</div>
        <pre style={{ margin: "0.85rem 0 0", padding: "0.9rem", borderRadius: 12, background: "#07111e", color: "#d6ecff", overflowX: "auto", fontSize: "0.84rem", lineHeight: 1.55 }}>{yamlExample}</pre>
      </section>
      <section style={cardStyle()}>
        <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Current Shape</div>
        <div style={{ marginTop: "0.85rem", color: C.muted, fontSize: "0.85rem" }}>
          {state.devices.length} device profile{state.devices.length === 1 ? "" : "s"} and {state.scripts.length} script{state.scripts.length === 1 ? "" : "s"} defined so far.
        </div>
      </section>
    </div>
  );
}

export default function EquipmentManager({ config }: ModuleProps) {
  useUserProfile();
  const getS3Client = useAwsS3Client();
  const storage = useMemo(() => getStorageInfo(config), [config]);
  const bridgeDefaults = useMemo(() => readBridgeDefaults(), []);
  const bridgeUrlKey = useMemo(() => buildBridgeStorageKey(storage.projectId, config.id, "url"), [config.id, storage.projectId]);
  const bridgeTokenKey = useMemo(() => buildBridgeStorageKey(storage.projectId, config.id, "token"), [config.id, storage.projectId]);

  const [tab, setTab] = useState<TabId>("devices");
  const [state, setState] = useState<EquipmentManagerState>(createDefaultState());
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(null);
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [bridgeUrl, setBridgeUrl] = useState("");
  const [bridgeToken, setBridgeToken] = useState("");
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealth | null>(null);
  const [bridgeChecking, setBridgeChecking] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<ExecutionResult | null>(null);
  const [deviceProfileOpen, setDeviceProfileOpen] = useState(false);
  const [deviceChooserOpen, setDeviceChooserOpen] = useState(false);

  const selectedDevice = state.devices.find((device) => device.id === selectedDeviceId) ?? state.devices[0] ?? null;
  const selectedScript = state.scripts.find((script) => script.id === selectedScriptId) ?? state.scripts[0] ?? null;
  const selectedCommand = selectedDevice?.commands.find((command) => command.id === selectedCommandId) ?? selectedDevice?.commands[0] ?? null;
  const selectedStep = selectedScript?.steps.find((step) => step.id === selectedStepId) ?? selectedScript?.steps[0] ?? null;
  const currentCommandExecution = executionResult?.scope === "command" && executionResult.commandId && executionResult.commandId === selectedCommand?.id
    ? executionResult
    : null;
  const currentScriptExecution = executionResult?.scope === "script" && executionResult.scriptId && executionResult.scriptId === selectedScript?.id
    ? executionResult
    : null;
  const activeBridge = bridgeUrl.trim() ? { url: bridgeUrl.trim(), token: bridgeToken.trim() || undefined } : null;
  const knownDevicePresets = useMemo<KnownDevicePreset[]>(() => [
    {
      id: "siglent-sds1202x-e",
      name: "Siglent SDS1202X-E",
      description: "SCPI over TCP with known starter queries and screenshot capture.",
      create: () => normalizeDevice(createDefaultState().devices[0], 0),
    },
    {
      id: "blank",
      name: "Blank Device",
      description: "Start from an empty profile for an unsupported or custom instrument.",
      create: () => ({ id: makeId("device"), name: `Device ${state.devices.length + 1}`, transport: "custom", address: "", capabilities: [], commands: [] }),
    },
  ], [state.devices.length]);

  useEffect(() => {
    const storedUrl = safeReadLocalStorage(bridgeUrlKey);
    const storedToken = safeReadLocalStorage(bridgeTokenKey);
    const fallbackUrl = findAgentChatBridgeSetting(storage.projectId, "bridge-url");
    const fallbackToken = findAgentChatBridgeSetting(storage.projectId, "bridge-token");
    const resolvedUrl = bridgeDefaults.url?.trim() || storedUrl || fallbackUrl || "http://127.0.0.1:4317";
    const resolvedToken = bridgeDefaults.token?.trim() || storedToken || fallbackToken || "";
    setBridgeUrl(resolvedUrl);
    setBridgeToken(resolvedToken);
    if (resolvedUrl) safeWriteLocalStorage(bridgeUrlKey, resolvedUrl);
    if (resolvedToken) safeWriteLocalStorage(bridgeTokenKey, resolvedToken);
  }, [bridgeDefaults, bridgeTokenKey, bridgeUrlKey, storage.projectId]);

  useEffect(() => {
    if (!selectedDeviceId && state.devices[0]) setSelectedDeviceId(state.devices[0].id);
    if (selectedDeviceId && !state.devices.some((device) => device.id === selectedDeviceId)) setSelectedDeviceId(state.devices[0]?.id ?? null);
  }, [selectedDeviceId, state.devices]);

  useEffect(() => {
    if (!selectedScriptId && state.scripts[0]) setSelectedScriptId(state.scripts[0].id);
    if (selectedScriptId && !state.scripts.some((script) => script.id === selectedScriptId)) setSelectedScriptId(state.scripts[0]?.id ?? null);
  }, [selectedScriptId, state.scripts]);

  useEffect(() => {
    if (!selectedCommandId && selectedDevice?.commands[0]) setSelectedCommandId(selectedDevice.commands[0].id);
    if (selectedCommandId && !selectedDevice?.commands.some((command) => command.id === selectedCommandId)) {
      setSelectedCommandId(selectedDevice?.commands[0]?.id ?? null);
    }
  }, [selectedCommandId, selectedDevice]);

  useEffect(() => {
    if (!selectedStepId && selectedScript?.steps[0]) setSelectedStepId(selectedScript.steps[0].id);
    if (selectedStepId && !selectedScript?.steps.some((step) => step.id === selectedStepId)) {
      setSelectedStepId(selectedScript?.steps[0]?.id ?? null);
    }
  }, [selectedStepId, selectedScript]);

  const loadState = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const s3 = await getS3Client(storage.bucket);
      const raw = await readOptionalText(s3, storage.bucket, storage.stateKey);
      setState(raw ? normalizeState(JSON.parse(raw)) : createDefaultState());
    } catch (loadError: unknown) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [getS3Client, storage.bucket, storage.stateKey]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const persistState = useCallback(async (nextState: EquipmentManagerState, successMessage = "Saved"): Promise<void> => {
    setSaving(true);
    setError("");
    try {
      const s3 = await getS3Client(storage.bucket);
      await writeText(s3, storage.bucket, storage.stateKey, JSON.stringify(nextState, null, 2), "application/json");
      setState(nextState);
      setMessage(successMessage);
    } catch (saveError: unknown) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  }, [getS3Client, storage.bucket, storage.stateKey]);

  const updateState = useCallback((mutate: (current: EquipmentManagerState) => EquipmentManagerState, successMessage = "Saved") => {
    const nextState = mutate(state);
    void persistState(nextState, successMessage);
  }, [persistState, state]);

  const checkBridge = useCallback(async () => {
    if (!activeBridge) return;
    setBridgeChecking(true);
    setError("");
    try {
      const status = await callBridge<BridgeHealth>(activeBridge, "get_bridge_status");
      setBridgeHealth(status);
      safeWriteLocalStorage(bridgeUrlKey, bridgeUrl.trim());
      safeWriteLocalStorage(bridgeTokenKey, bridgeToken.trim());
      setMessage("Bridge connected");
    } catch (bridgeError: unknown) {
      setBridgeHealth(null);
      setError((bridgeError as Error).message);
    } finally {
      setBridgeChecking(false);
    }
  }, [activeBridge, bridgeToken, bridgeTokenKey, bridgeUrl, bridgeUrlKey]);

  const executeSiglentWaveformCommand = useCallback(async (target: { host: string; port: number }, command: EquipmentCommand): Promise<SiglentWaveformResult> => {
    if (!activeBridge) throw new Error("Bridge URL is required before executing device commands.");
    const channel = parseSiglentWaveformChannel(command.payload);
    await callBridge<unknown>(activeBridge, "execute_tcp_command", {
      host: target.host,
      port: target.port,
      command: SIGLENT_WAVEFORM_SETUP,
      readMode: "none",
      timeoutMs: 1500,
    });

    const [voltsPerDivResponse, offsetResponse, timeDivResponse, triggerDelayResponse, sampleRateResponse, waveform] = await Promise.all([
      fetchTcpText(activeBridge, target, `${channel}:VDIV?`),
      fetchTcpText(activeBridge, target, `${channel}:OFST?`),
      fetchTcpText(activeBridge, target, "TDIV?"),
      fetchTcpText(activeBridge, target, "TRDL?"),
      fetchTcpText(activeBridge, target, "SARA?"),
      callBridge<TcpCommandResult>(activeBridge, "execute_tcp_command", {
        host: target.host,
        port: target.port,
        command: command.payload,
        readMode: "until-timeout",
        timeoutMs: command.timeoutMs || 15000,
        quietMs: 600,
        encoding: "base64",
      }),
    ]);

    return buildSiglentWaveformResult({
      channel,
      waveform,
      voltsPerDivResponse,
      offsetResponse,
      timeDivResponse,
      triggerDelayResponse,
      sampleRateResponse,
    });
  }, [activeBridge]);

  const runDeviceCommand = useCallback(async (device: EquipmentDevice, command: EquipmentCommand) => {
    if (!activeBridge) {
      setError("Bridge URL is required before executing device commands.");
      return;
    }
    const target = parseDeviceAddress(device.address);
    if (!target) {
      setError("Device address must be set before executing commands.");
      return;
    }
    setExecuting(true);
    setError("");
    setExecutionResult(null);
    try {
      const output = command.parser === "siglent-waveform"
        ? await executeSiglentWaveformCommand(target, command)
        : await callBridge<unknown>(activeBridge, "execute_tcp_command", buildTcpExecutionParams(target, command));
      setExecutionResult({
        scope: "command",
        title: `${device.name} · ${command.name}`,
        startedAt: new Date().toISOString(),
        commandId: command.id,
        output,
      });
      setMessage(`Executed ${command.name}`);
    } catch (executionError: unknown) {
      setError((executionError as Error).message);
    } finally {
      setExecuting(false);
    }
  }, [activeBridge, executeSiglentWaveformCommand]);

  const runScript = useCallback(async (script: EquipmentScript) => {
    if (!activeBridge) {
      setError("Bridge URL is required before executing scripts.");
      return;
    }
    const device = state.devices.find((candidate) => candidate.id === script.deviceId);
    if (!device) {
      setError("Bind the script to a device before running it.");
      return;
    }
    const target = parseDeviceAddress(device.address);
    if (!target) {
      setError("Device address must be set before executing scripts.");
      return;
    }

    const commandMap = new Map(device.commands.map((command) => [command.id, command]));
    setExecuting(true);
    setError("");
    setExecutionResult(null);

    const stepResults: Array<{ title: string; ok: boolean; output?: unknown }> = [];
    try {
      for (const step of script.steps) {
        if (step.type === "wait") {
          await new Promise((resolve) => window.setTimeout(resolve, step.waitMs ?? 1000));
          stepResults.push({ title: step.title, ok: true, output: { waitedMs: step.waitMs ?? 1000 } });
          continue;
        }

        if (step.type === "note") {
          stepResults.push({ title: step.title, ok: true, output: { notes: step.notes ?? "" } });
          continue;
        }

        const ref = step.commandId ? commandMap.get(step.commandId) : undefined;
        const payload = step.rawCommand ?? ref?.payload ?? "";
        if (!payload.trim()) {
          throw new Error(`Step "${step.title}" does not have a command payload.`);
        }

        const timeoutMs = ref?.timeoutMs ?? 5000;
        const output = await callBridge<unknown>(activeBridge, "execute_tcp_command", buildTcpExecutionParams(target, {
          id: ref?.id ?? step.id,
          name: ref?.name ?? step.title,
          mode: ref?.mode ?? "raw",
          payload,
          parser: ref?.parser ?? "text",
          timeoutMs,
          saveAs: step.saveAs ?? ref?.saveAs,
          artifactMode: ref?.artifactMode ?? (step.type === "capture" ? "image" : "text"),
          notes: ref?.notes,
        }));
        stepResults.push({ title: step.title, ok: true, output });
      }

      setExecutionResult({
        scope: "script",
        title: `${device.name} · ${script.name}`,
        startedAt: new Date().toISOString(),
        scriptId: script.id,
        steps: stepResults,
      });
      setMessage(`Executed script ${script.name}`);
    } catch (executionError: unknown) {
      stepResults.push({ title: "Execution halted", ok: false, output: { error: (executionError as Error).message } });
      setExecutionResult({
        scope: "script",
        title: `${device.name} · ${script.name}`,
        startedAt: new Date().toISOString(),
        scriptId: script.id,
        steps: stepResults,
      });
      setError((executionError as Error).message);
    } finally {
      setExecuting(false);
    }
  }, [activeBridge, state.devices]);

  const contractSummary = useMemo(() => [
    "get_capabilities",
    "connect",
    "disconnect",
    "enumerate_targets",
    "execute_command",
    "execute_script",
    "read_data",
    "capture_artifact",
    "subscribe",
    "stop",
  ], []);

  if (loading) {
    return <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, color: C.muted }}>Loading equipment manager...</div>;
  }

  return (
    <div style={{ height: "100%", minHeight: 0, overflow: "hidden", display: "grid", gridTemplateRows: "auto auto 1fr", background: C.bg, color: C.text, fontFamily: "\"Segoe UI\", \"Aptos\", sans-serif" }}>
      <header style={{ padding: "1rem 1.1rem", borderBottom: `1px solid ${C.border}`, background: C.header, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 420px" }}>
          <div style={{ fontSize: "0.72rem", color: C.accent, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>Equipment Manager</div>
          <h2 style={{ margin: "0.2rem 0 0", fontSize: "1.35rem" }}>{(config.meta?.["title"] as string | undefined) ?? "Equipment Manager"}</h2>
          <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.82rem" }}>
            {state.devices.length} device profile{state.devices.length === 1 ? "" : "s"} · {state.scripts.length} script{state.scripts.length === 1 ? "" : "s"} · project {storage.projectId}
          </div>
          <div style={{ marginTop: "0.4rem", color: C.muted, fontSize: "0.82rem", lineHeight: 1.55 }}>
            Shaping a shared device-runtime model for bridge execution, standalone automation, and future test-manager equipment bindings.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "flex-end", flex: "0 1 auto" }}>
          <button onClick={() => void checkBridge()} style={buttonStyle()} disabled={bridgeChecking}>
            {bridgeChecking ? "Checking..." : "Check Bridge"}
          </button>
        </div>
      </header>

      <section style={{ padding: "0.8rem 1rem", display: "flex", gap: "0.55rem", borderBottom: `1px solid ${C.border}`, background: C.panel, flexWrap: "wrap" }}>
        {(["devices", "scripts", "contract"] as TabId[]).map((candidate) => (
          <button key={candidate} onClick={() => setTab(candidate)} style={{ ...buttonStyle(tab === candidate ? "primary" : "ghost"), minWidth: 110 }}>
            {candidate === "devices" ? "Devices" : candidate === "scripts" ? "Scripts" : "Contract"}
          </button>
        ))}
        <div style={{ marginLeft: "auto", color: C.muted, fontSize: "0.8rem", display: "flex", alignItems: "center" }}>
          Standard contract: {contractSummary.join(" · ")}
        </div>
      </section>

      <main style={{ minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {(error || message || saving) && (
          <div style={{ padding: "0.5rem 1rem", borderBottom: `1px solid ${C.border}`, color: error ? C.danger : saving ? C.accent : C.ok, background: C.panel, fontSize: "0.82rem" }}>
            {error || (saving ? "Saving..." : message)}
          </div>
        )}

        {tab === "contract" ? (
          <section style={{ minHeight: 0, flex: 1, overflowY: "auto", padding: "1rem", background: C.panel2 }}>
            <ContractView state={state} />
          </section>
        ) : (
          <section style={{ minHeight: 0, flex: 1, overflow: "hidden", display: "grid", gridTemplateColumns: "320px minmax(0, 1fr)", background: C.panel2 }}>
            <aside style={{ minHeight: 0, borderRight: `1px solid ${C.border}`, overflowY: "auto", padding: "1rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", marginBottom: "0.85rem" }}>
                <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>
                  {tab === "devices" ? "Device Profiles" : "Scripts"}
                </div>
                <button
                  onClick={() => {
                    if (tab === "devices") {
                      setDeviceChooserOpen(true);
                    } else {
                      const script: EquipmentScript = { id: makeId("script"), name: `Script ${state.scripts.length + 1}`, description: "", steps: [] };
                      updateState((current) => ({ ...current, scripts: [...current.scripts, script] }), "Script added");
                      setSelectedScriptId(script.id);
                    }
                  }}
                  style={buttonStyle("primary")}
                >
                  Add
                </button>
              </div>
              <div style={{ display: "grid", gap: "0.65rem" }}>
                {(tab === "devices" ? state.devices : state.scripts).map((entry) => {
                  const active = tab === "devices" ? entry.id === selectedDevice?.id : entry.id === selectedScript?.id;
                  return (
                    <button
                      key={entry.id}
                      onClick={() => tab === "devices" ? setSelectedDeviceId(entry.id) : setSelectedScriptId(entry.id)}
                      style={{
                        textAlign: "left",
                        border: `1px solid ${active ? C.accent : C.border}`,
                        background: active ? C.accentSoft : C.panel,
                        color: C.text,
                        borderRadius: 12,
                        padding: "0.58rem 0.68rem",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontWeight: 700 }}>{entry.name}</div>
                      <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.8rem" }}>
                        {tab === "devices"
                          ? `${(entry as EquipmentDevice).transport} · ${(entry as EquipmentDevice).commands.length} command${(entry as EquipmentDevice).commands.length === 1 ? "" : "s"}`
                          : `${(entry as EquipmentScript).steps.length} step${(entry as EquipmentScript).steps.length === 1 ? "" : "s"}`}
                      </div>
                    </button>
                  );
                })}
              </div>
            </aside>

            <div style={{ minHeight: 0, overflowY: "auto", padding: "1rem" }}>
              {tab === "devices" && selectedDevice ? (
                <div style={{ display: "grid", gap: "1rem" }}>
                  <section style={cardStyle()}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Selected Device</div>
                        <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.84rem" }}>
                          {selectedDevice.name} · {selectedDevice.transport} · {selectedDevice.address || "no address set"}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                        <button onClick={() => setDeviceProfileOpen(true)} style={buttonStyle()}>Device Profile</button>
                        <button
                          onClick={() => {
                            const confirmed = window.confirm(`Delete device "${selectedDevice.name}"?`);
                            if (!confirmed) return;
                            updateState((current) => ({ ...current, devices: current.devices.filter((device) => device.id !== selectedDevice.id) }), "Device removed");
                          }}
                          style={buttonStyle("danger")}
                        >
                          Delete Device
                        </button>
                      </div>
                    </div>
                  </section>

                  <section style={cardStyle()}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Known Commands</div>
                        <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.84rem" }}>Select one command on the left to edit or run it.</div>
                      </div>
                      <button
                        onClick={() => {
                          const newCommand: EquipmentCommand = {
                            id: makeId("command"),
                            name: `Command ${selectedDevice.commands.length + 1}`,
                            mode: "scpi",
                            payload: "",
                            parser: "text",
                            timeoutMs: 5000,
                            artifactMode: "none",
                          };
                          const next = {
                            ...state,
                            devices: state.devices.map((device) => device.id === selectedDevice.id ? {
                              ...device,
                              commands: [...device.commands, newCommand],
                            } : device),
                          };
                          setState(next);
                          setSelectedCommandId(newCommand.id);
                          void persistState(next, "Command added");
                        }}
                        style={buttonStyle("primary")}
                      >
                        Add Command
                      </button>
                    </div>
                    <div style={{ marginTop: "0.9rem", display: "grid", gridTemplateColumns: "280px minmax(0, 1fr)", gap: "1rem", minHeight: 520 }}>
                      <div style={{ minHeight: 0, overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 12, background: C.panel2, padding: "0.75rem", display: "grid", gap: "0.6rem" }}>
                        {selectedDevice.commands.map((command) => {
                          const active = command.id === selectedCommand?.id;
                          return (
                            <button
                              key={command.id}
                              onClick={() => setSelectedCommandId(command.id)}
                              style={{
                                textAlign: "left",
                                border: `1px solid ${active ? C.accent : C.border}`,
                                background: active ? C.accentSoft : C.panel,
                                color: C.text,
                                borderRadius: 10,
                                padding: "0.55rem 0.65rem",
                                cursor: "pointer",
                              }}
                            >
                              <div style={{ fontWeight: 700 }}>{command.name}</div>
                              <div style={{ marginTop: "0.2rem", color: C.muted, fontSize: "0.78rem" }}>
                                {command.mode} · {command.parser} · {command.artifactMode}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      <div style={{ display: "grid", gap: "1rem", minHeight: 0 }}>
                        {selectedCommand ? (
                          <>
                            <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, background: C.panel2, padding: "0.85rem", minWidth: 0 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                                <strong>{selectedCommand.name}</strong>
                                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                                  <button onClick={() => void runDeviceCommand(selectedDevice, selectedCommand)} style={buttonStyle()} disabled={executing}>
                                    {executing ? "Running..." : "Run"}
                                  </button>
                                  <button
                                    onClick={() => {
                                      const next = {
                                        ...state,
                                        devices: state.devices.map((device) => device.id === selectedDevice.id ? { ...device, commands: device.commands.filter((item) => item.id !== selectedCommand.id) } : device),
                                      };
                                      setState(next);
                                      void persistState(next, "Command removed");
                                    }}
                                    style={buttonStyle("danger")}
                                  >
                                    Delete
                                  </button>
                                </div>
                              </div>
                              <div style={{ marginTop: "0.8rem", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.8rem" }}>
                                <label style={labelStyle()}>
                                  Name
                                  <input value={selectedCommand.name} onChange={(event) => setState((current) => ({ ...current, devices: current.devices.map((device) => device.id === selectedDevice.id ? { ...device, commands: device.commands.map((item) => item.id === selectedCommand.id ? { ...item, name: event.target.value } : item) } : device) }))} onBlur={() => void persistState(state, "Command updated")} style={inputStyle()} />
                                </label>
                                <label style={labelStyle()}>
                                  Mode
                                  <select value={selectedCommand.mode} onChange={(event) => {
                                    const next = { ...state, devices: state.devices.map((device) => device.id === selectedDevice.id ? { ...device, commands: device.commands.map((item) => item.id === selectedCommand.id ? { ...item, mode: event.target.value as CommandMode } : item) } : device) };
                                    setState(next);
                                    void persistState(next, "Command updated");
                                  }} style={inputStyle()}>
                                    {COMMAND_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                                  </select>
                                </label>
                                <label style={labelStyle()}>
                                  Parser
                                  <select value={selectedCommand.parser} onChange={(event) => {
                                    const next = { ...state, devices: state.devices.map((device) => device.id === selectedDevice.id ? { ...device, commands: device.commands.map((item) => item.id === selectedCommand.id ? { ...item, parser: event.target.value as ParserMode } : item) } : device) };
                                    setState(next);
                                    void persistState(next, "Command updated");
                                  }} style={inputStyle()}>
                                    {PARSER_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                                  </select>
                                </label>
                                <label style={labelStyle()}>
                                  Artifact
                                  <select value={selectedCommand.artifactMode} onChange={(event) => {
                                    const next = { ...state, devices: state.devices.map((device) => device.id === selectedDevice.id ? { ...device, commands: device.commands.map((item) => item.id === selectedCommand.id ? { ...item, artifactMode: event.target.value as ArtifactMode } : item) } : device) };
                                    setState(next);
                                    void persistState(next, "Command updated");
                                  }} style={inputStyle()}>
                                    {ARTIFACT_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                                  </select>
                                </label>
                                <label style={labelStyle()}>
                                  Timeout (ms)
                                  <input type="number" value={selectedCommand.timeoutMs} onChange={(event) => setState((current) => ({ ...current, devices: current.devices.map((device) => device.id === selectedDevice.id ? { ...device, commands: device.commands.map((item) => item.id === selectedCommand.id ? { ...item, timeoutMs: Number(event.target.value) || 0 } : item) } : device) }))} onBlur={() => void persistState(state, "Command updated")} style={inputStyle()} />
                                </label>
                                <label style={labelStyle()}>
                                  Save As
                                  <input value={selectedCommand.saveAs ?? ""} onChange={(event) => setState((current) => ({ ...current, devices: current.devices.map((device) => device.id === selectedDevice.id ? { ...device, commands: device.commands.map((item) => item.id === selectedCommand.id ? { ...item, saveAs: event.target.value || undefined } : item) } : device) }))} onBlur={() => void persistState(state, "Command updated")} style={inputStyle()} />
                                </label>
                              </div>
                              <label style={{ ...labelStyle(), marginTop: "0.8rem" }}>
                                Payload
                                <textarea value={selectedCommand.payload} onChange={(event) => setState((current) => ({ ...current, devices: current.devices.map((device) => device.id === selectedDevice.id ? { ...device, commands: device.commands.map((item) => item.id === selectedCommand.id ? { ...item, payload: event.target.value } : item) } : device) }))} onBlur={() => void persistState(state, "Command updated")} rows={4} style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.6, fontFamily: "Consolas, monospace" }} />
                              </label>
                            </div>

                            <div style={{ display: "grid", gap: "1rem", minWidth: 0 }}>
                              <section style={cardStyle()}>
                                <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Raw Output</div>
                                <div style={{ marginTop: "0.85rem", border: `1px solid ${C.border}`, borderRadius: 12, background: "#07111e", padding: "0.9rem", maxHeight: 240, overflow: "auto", minWidth: 0 }}>
                                  <pre style={{ margin: 0, color: "#d6ecff", fontSize: "0.84rem", lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" }}>
                                    {currentCommandExecution ? renderExecutionOutput(currentCommandExecution.output) : "Run the selected command to inspect raw response content."}
                                  </pre>
                                </div>
                              </section>
                              <section style={cardStyle()}>
                                <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Interpreted Output</div>
                                <div style={{ marginTop: "0.85rem", border: `1px solid ${C.border}`, borderRadius: 12, background: C.panel2, padding: "0.9rem", maxHeight: 560, overflow: "auto", minWidth: 0 }}>
                                  {currentCommandExecution && isSiglentWaveformResult(currentCommandExecution.output) ? (
                                    <WaveformChartInteractive key={`${currentCommandExecution.startedAt}-${currentCommandExecution.output.channel}-${currentCommandExecution.output.sampleCount}`} result={currentCommandExecution.output} />
                                  ) : currentCommandExecution && isTcpCommandResult(currentCommandExecution.output) ? (
                                    selectedCommand.artifactMode === "image" && currentCommandExecution.output.bytesBase64 ? (
                                      <img
                                        src={`data:${guessImageMimeType(selectedCommand)};base64,${currentCommandExecution.output.bytesBase64}`}
                                        alt={selectedCommand.name}
                                        style={{ display: "block", maxWidth: "100%", height: "auto", background: "white", borderRadius: 8 }}
                                      />
                                    ) : (
                                      <pre style={{ margin: 0, color: C.text, fontSize: "0.84rem", lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" }}>
                                        {currentCommandExecution.output.text || currentCommandExecution.output.data || "No interpreted output available."}
                                      </pre>
                                    )
                                  ) : (
                                    <div style={{ color: C.muted, fontSize: "0.84rem" }}>
                                      Run the selected command to see interpreted content here.
                                    </div>
                                  )}
                                </div>
                              </section>
                            </div>
                          </>
                        ) : (
                          <div style={{ color: C.muted, fontSize: "0.84rem" }}>Add or select a command to edit it.</div>
                        )}
                      </div>
                    </div>
                  </section>
                </div>
              ) : null}

              {tab === "scripts" && selectedScript ? (
                <div style={{ display: "grid", gap: "1rem" }}>
                  <section style={cardStyle()}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Script</div>
                        <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.84rem" }}>Reusable automation flow that later maps to bridge execution.</div>
                      </div>
                      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                        <button onClick={() => void runScript(selectedScript)} style={buttonStyle("primary")} disabled={executing}>
                          {executing ? "Running..." : "Run Script"}
                        </button>
                        <button
                          onClick={() => {
                            updateState((current) => ({ ...current, scripts: current.scripts.filter((script) => script.id !== selectedScript.id) }), "Script removed");
                          }}
                          style={buttonStyle("danger")}
                        >
                          Delete Script
                        </button>
                      </div>
                    </div>
                    <div style={{ marginTop: "0.9rem", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.85rem" }}>
                      <label style={labelStyle()}>
                        Name
                        <input value={selectedScript.name} onChange={(event) => setState((current) => ({ ...current, scripts: current.scripts.map((script) => script.id === selectedScript.id ? { ...script, name: event.target.value } : script) }))} onBlur={() => void persistState(state, "Script updated")} style={inputStyle()} />
                      </label>
                      <label style={labelStyle()}>
                        Target Device
                        <select value={selectedScript.deviceId ?? ""} onChange={(event) => {
                          const next = { ...state, scripts: state.scripts.map((script) => script.id === selectedScript.id ? { ...script, deviceId: event.target.value || undefined } : script) };
                          setState(next);
                          void persistState(next, "Script updated");
                        }} style={inputStyle()}>
                          <option value="">Unbound / generic</option>
                          {state.devices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
                        </select>
                      </label>
                    </div>
                    <label style={{ ...labelStyle(), marginTop: "0.85rem" }}>
                      Description
                      <textarea value={selectedScript.description ?? ""} onChange={(event) => setState((current) => ({ ...current, scripts: current.scripts.map((script) => script.id === selectedScript.id ? { ...script, description: event.target.value } : script) }))} onBlur={() => void persistState(state, "Script updated")} rows={4} style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.6 }} />
                    </label>
                    {currentScriptExecution ? (
                      <pre style={{ margin: "0.9rem 0 0", padding: "0.9rem", borderRadius: 12, background: "#07111e", color: "#d6ecff", overflow: "auto", fontSize: "0.84rem", lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" }}>
                        {renderExecutionOutput(currentScriptExecution)}
                      </pre>
                    ) : null}
                  </section>

                  <section style={cardStyle()}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Steps</div>
                        <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.84rem" }}>Command refs, waits, captures, and freeform notes. Raw command escape hatches are intentional.</div>
                      </div>
                      <button
                        onClick={() => {
                          const newStep: EquipmentScriptStep = {
                            id: makeId("step"),
                            type: "command",
                            title: `Step ${selectedScript.steps.length + 1}`,
                          };
                          const next = {
                            ...state,
                            scripts: state.scripts.map((script) => script.id === selectedScript.id ? {
                              ...script,
                              steps: [...script.steps, newStep],
                            } : script),
                          };
                          setState(next);
                          void persistState(next, "Step added");
                        }}
                        style={buttonStyle("primary")}
                      >
                        Add Step
                      </button>
                    </div>
                    <div style={{ marginTop: "0.9rem", display: "grid", gridTemplateColumns: "280px minmax(0, 1fr)", gap: "0.9rem", alignItems: "start" }}>
                      <div style={{ display: "grid", gap: "0.5rem", maxHeight: 520, overflowY: "auto", paddingRight: "0.15rem" }}>
                        {selectedScript.steps.length ? selectedScript.steps.map((step, index) => (
                          <button
                            key={step.id}
                            onClick={() => setSelectedStepId(step.id)}
                            style={{
                              ...buttonStyle(selectedStep?.id === step.id ? "primary" : "ghost"),
                              justifyContent: "flex-start",
                              textAlign: "left",
                              padding: "0.55rem 0.65rem",
                              minHeight: 0,
                            }}
                          >
                            <div style={{ display: "grid", gap: "0.16rem" }}>
                              <strong style={{ fontSize: "0.9rem" }}>{step.title || `Step ${index + 1}`}</strong>
                              <span style={{ fontSize: "0.76rem", opacity: 0.86 }}>
                                {step.type} · {step.commandId ? "command ref" : step.rawCommand ? "raw command" : "no command"}
                              </span>
                            </div>
                          </button>
                        )) : (
                          <div style={{ border: `1px dashed ${C.border}`, borderRadius: 12, padding: "0.9rem", color: C.muted, fontSize: "0.84rem" }}>
                            No steps yet.
                          </div>
                        )}
                      </div>
                      {selectedStep ? (() => {
                        const commandOptions = selectedScript.deviceId
                          ? state.devices.find((device) => device.id === selectedScript.deviceId)?.commands ?? []
                          : state.devices.flatMap((device) => device.commands.map((command) => ({ ...command, name: `${device.name} · ${command.name}` })));
                        return (
                          <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, background: C.panel2, padding: "0.85rem" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                              <strong>{selectedStep.title}</strong>
                              <button
                                onClick={() => {
                                  const next = {
                                    ...state,
                                    scripts: state.scripts.map((script) => script.id === selectedScript.id ? { ...script, steps: script.steps.filter((item) => item.id !== selectedStep.id) } : script),
                                  };
                                  setState(next);
                                  void persistState(next, "Step removed");
                                }}
                                style={buttonStyle("danger")}
                              >
                                Delete
                              </button>
                            </div>
                            <div style={{ marginTop: "0.8rem", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.8rem", minWidth: 0 }}>
                              <label style={labelStyle()}>
                                Title
                                <input value={selectedStep.title} onChange={(event) => setState((current) => ({ ...current, scripts: current.scripts.map((script) => script.id === selectedScript.id ? { ...script, steps: script.steps.map((item) => item.id === selectedStep.id ? { ...item, title: event.target.value } : item) } : script) }))} onBlur={() => void persistState(state, "Step updated")} style={inputStyle()} />
                              </label>
                              <label style={labelStyle()}>
                                Type
                                <select value={selectedStep.type} onChange={(event) => {
                                  const next = { ...state, scripts: state.scripts.map((script) => script.id === selectedScript.id ? { ...script, steps: script.steps.map((item) => item.id === selectedStep.id ? { ...item, type: event.target.value as ScriptStepType } : item) } : script) };
                                  setState(next);
                                  void persistState(next, "Step updated");
                                }} style={inputStyle()}>
                                  {STEP_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                                </select>
                              </label>
                              <label style={labelStyle()}>
                                Command Ref
                                <select value={selectedStep.commandId ?? ""} onChange={(event) => {
                                  const next = { ...state, scripts: state.scripts.map((script) => script.id === selectedScript.id ? { ...script, steps: script.steps.map((item) => item.id === selectedStep.id ? { ...item, commandId: event.target.value || undefined } : item) } : script) };
                                  setState(next);
                                  void persistState(next, "Step updated");
                                }} style={inputStyle()}>
                                  <option value="">None / raw only</option>
                                  {commandOptions.map((command) => <option key={command.id} value={command.id}>{command.name}</option>)}
                                </select>
                              </label>
                              <label style={labelStyle()}>
                                Wait (ms)
                                <input type="number" value={selectedStep.waitMs ?? ""} onChange={(event) => setState((current) => ({ ...current, scripts: current.scripts.map((script) => script.id === selectedScript.id ? { ...script, steps: script.steps.map((item) => item.id === selectedStep.id ? { ...item, waitMs: event.target.value === "" ? undefined : Number(event.target.value) || 0 } : item) } : script) }))} onBlur={() => void persistState(state, "Step updated")} style={inputStyle()} />
                              </label>
                              <label style={labelStyle()}>
                                Save As
                                <input value={selectedStep.saveAs ?? ""} onChange={(event) => setState((current) => ({ ...current, scripts: current.scripts.map((script) => script.id === selectedScript.id ? { ...script, steps: script.steps.map((item) => item.id === selectedStep.id ? { ...item, saveAs: event.target.value || undefined } : item) } : script) }))} onBlur={() => void persistState(state, "Step updated")} style={inputStyle()} />
                              </label>
                            </div>
                            <label style={{ ...labelStyle(), marginTop: "0.8rem" }}>
                              Raw Command / Payload
                              <textarea value={selectedStep.rawCommand ?? ""} onChange={(event) => setState((current) => ({ ...current, scripts: current.scripts.map((script) => script.id === selectedScript.id ? { ...script, steps: script.steps.map((item) => item.id === selectedStep.id ? { ...item, rawCommand: event.target.value || undefined } : item) } : script) }))} onBlur={() => void persistState(state, "Step updated")} rows={3} style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.6, fontFamily: "Consolas, monospace" }} />
                            </label>
                            <label style={{ ...labelStyle(), marginTop: "0.8rem" }}>
                              Notes
                              <textarea value={selectedStep.notes ?? ""} onChange={(event) => setState((current) => ({ ...current, scripts: current.scripts.map((script) => script.id === selectedScript.id ? { ...script, steps: script.steps.map((item) => item.id === selectedStep.id ? { ...item, notes: event.target.value || undefined } : item) } : script) }))} onBlur={() => void persistState(state, "Step updated")} rows={3} style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.6 }} />
                            </label>
                          </div>
                        );
                      })() : (
                        <div style={{ border: `1px dashed ${C.border}`, borderRadius: 12, padding: "1rem", color: C.muted, minHeight: 220 }}>
                          Add or select a step to edit it.
                        </div>
                      )}
                    </div>
                    {false ? (
                    <div style={{ marginTop: "0.9rem", display: "grid", gap: "0.85rem" }}>
                      {selectedScript.steps.map((step) => {
                        const commandOptions = selectedScript.deviceId
                          ? state.devices.find((device) => device.id === selectedScript.deviceId)?.commands ?? []
                          : state.devices.flatMap((device) => device.commands.map((command) => ({ ...command, name: `${device.name} · ${command.name}` })));
                        return (
                          <div key={step.id} style={{ border: `1px solid ${C.border}`, borderRadius: 12, background: C.panel2, padding: "0.85rem" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                              <strong>{step.title}</strong>
                              <button
                                onClick={() => {
                                  const next = {
                                    ...state,
                                    scripts: state.scripts.map((script) => script.id === selectedScript.id ? { ...script, steps: script.steps.filter((item) => item.id !== step.id) } : script),
                                  };
                                  setState(next);
                                  void persistState(next, "Step removed");
                                }}
                                style={buttonStyle("danger")}
                              >
                                Delete
                              </button>
                            </div>
                            <div style={{ marginTop: "0.8rem", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.8rem" }}>
                              <label style={labelStyle()}>
                                Title
                                <input value={step.title} onChange={(event) => setState((current) => ({ ...current, scripts: current.scripts.map((script) => script.id === selectedScript.id ? { ...script, steps: script.steps.map((item) => item.id === step.id ? { ...item, title: event.target.value } : item) } : script) }))} onBlur={() => void persistState(state, "Step updated")} style={inputStyle()} />
                              </label>
                              <label style={labelStyle()}>
                                Type
                                <select value={step.type} onChange={(event) => {
                                  const next = { ...state, scripts: state.scripts.map((script) => script.id === selectedScript.id ? { ...script, steps: script.steps.map((item) => item.id === step.id ? { ...item, type: event.target.value as ScriptStepType } : item) } : script) };
                                  setState(next);
                                  void persistState(next, "Step updated");
                                }} style={inputStyle()}>
                                  {STEP_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                                </select>
                              </label>
                              <label style={labelStyle()}>
                                Command Ref
                                <select value={step.commandId ?? ""} onChange={(event) => {
                                  const next = { ...state, scripts: state.scripts.map((script) => script.id === selectedScript.id ? { ...script, steps: script.steps.map((item) => item.id === step.id ? { ...item, commandId: event.target.value || undefined } : item) } : script) };
                                  setState(next);
                                  void persistState(next, "Step updated");
                                }} style={inputStyle()}>
                                  <option value="">None / raw only</option>
                                  {commandOptions.map((command) => <option key={command.id} value={command.id}>{command.name}</option>)}
                                </select>
                              </label>
                              <label style={labelStyle()}>
                                Wait (ms)
                                <input type="number" value={step.waitMs ?? ""} onChange={(event) => setState((current) => ({ ...current, scripts: current.scripts.map((script) => script.id === selectedScript.id ? { ...script, steps: script.steps.map((item) => item.id === step.id ? { ...item, waitMs: event.target.value === "" ? undefined : Number(event.target.value) || 0 } : item) } : script) }))} onBlur={() => void persistState(state, "Step updated")} style={inputStyle()} />
                              </label>
                              <label style={labelStyle()}>
                                Save As
                                <input value={step.saveAs ?? ""} onChange={(event) => setState((current) => ({ ...current, scripts: current.scripts.map((script) => script.id === selectedScript.id ? { ...script, steps: script.steps.map((item) => item.id === step.id ? { ...item, saveAs: event.target.value || undefined } : item) } : script) }))} onBlur={() => void persistState(state, "Step updated")} style={inputStyle()} />
                              </label>
                            </div>
                            <label style={{ ...labelStyle(), marginTop: "0.8rem" }}>
                              Raw Command / Payload
                              <textarea value={step.rawCommand ?? ""} onChange={(event) => setState((current) => ({ ...current, scripts: current.scripts.map((script) => script.id === selectedScript.id ? { ...script, steps: script.steps.map((item) => item.id === step.id ? { ...item, rawCommand: event.target.value || undefined } : item) } : script) }))} onBlur={() => void persistState(state, "Step updated")} rows={3} style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.6, fontFamily: "Consolas, monospace" }} />
                            </label>
                            <label style={{ ...labelStyle(), marginTop: "0.8rem" }}>
                              Notes
                              <textarea value={step.notes ?? ""} onChange={(event) => setState((current) => ({ ...current, scripts: current.scripts.map((script) => script.id === selectedScript.id ? { ...script, steps: script.steps.map((item) => item.id === step.id ? { ...item, notes: event.target.value || undefined } : item) } : script) }))} onBlur={() => void persistState(state, "Step updated")} rows={3} style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.6 }} />
                            </label>
                          </div>
                        );
                      })}
                    </div>
                    ) : null}
                  </section>
                </div>
              ) : null}
            </div>
          </section>
        )}
      </main>
      {deviceChooserOpen ? (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.58)", display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem", zIndex: 60 }}>
          <section style={{ width: "min(640px, 100%)", border: `1px solid ${C.border}`, borderRadius: 16, background: C.panel, boxShadow: "0 24px 80px rgba(0,0,0,0.45)", overflow: "hidden" }}>
            <header style={{ padding: "1rem 1.1rem", borderBottom: `1px solid ${C.border}`, background: C.panel2 }}>
              <div style={{ fontWeight: 800 }}>Add Device</div>
              <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.84rem" }}>Choose a known device preset or start from a blank profile.</div>
            </header>
            <div style={{ padding: "1rem 1.1rem", display: "grid", gap: "0.75rem" }}>
              {knownDevicePresets.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => {
                    const device = preset.create();
                    const next = { ...state, devices: [...state.devices, device] };
                    setState(next);
                    setSelectedDeviceId(device.id);
                    setDeviceChooserOpen(false);
                    void persistState(next, "Device added");
                  }}
                  style={{ textAlign: "left", border: `1px solid ${C.border}`, background: C.panel2, color: C.text, borderRadius: 12, padding: "0.95rem 1rem", cursor: "pointer" }}
                >
                  <div style={{ fontWeight: 700 }}>{preset.name}</div>
                  <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.84rem", lineHeight: 1.55 }}>{preset.description}</div>
                </button>
              ))}
            </div>
            <footer style={{ padding: "0.85rem 1.1rem", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => setDeviceChooserOpen(false)} style={buttonStyle()}>Cancel</button>
            </footer>
          </section>
        </div>
      ) : null}
      {deviceProfileOpen && selectedDevice ? (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.58)", display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem", zIndex: 60 }}>
          <section style={{ width: "min(760px, 100%)", maxHeight: "min(88vh, 900px)", border: `1px solid ${C.border}`, borderRadius: 16, background: C.panel, boxShadow: "0 24px 80px rgba(0,0,0,0.45)", overflow: "hidden", display: "grid", gridTemplateRows: "auto 1fr auto" }}>
            <header style={{ padding: "1rem 1.1rem", borderBottom: `1px solid ${C.border}`, background: C.panel2 }}>
              <div style={{ fontWeight: 800 }}>Device Profile</div>
              <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.84rem" }}>Edit identity, address, capabilities, and notes for the selected device.</div>
            </header>
            <div style={{ padding: "1rem 1.1rem", overflowY: "auto" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.85rem" }}>
                <label style={labelStyle()}>
                  Name
                  <input value={selectedDevice.name} onChange={(event) => setState((current) => ({ ...current, devices: current.devices.map((device) => device.id === selectedDevice.id ? { ...device, name: event.target.value } : device) }))} onBlur={() => void persistState(state, "Device updated")} style={inputStyle()} />
                </label>
                <label style={labelStyle()}>
                  Transport
                  <select value={selectedDevice.transport} onChange={(event) => {
                    const next = { ...state, devices: state.devices.map((device) => device.id === selectedDevice.id ? { ...device, transport: event.target.value as EquipmentTransport } : device) };
                    setState(next);
                    void persistState(next, "Device updated");
                  }} style={inputStyle()}>
                    {TRANSPORTS.map((transport) => <option key={transport} value={transport}>{transport}</option>)}
                  </select>
                </label>
                <label style={labelStyle()}>
                  Address
                  <input value={selectedDevice.address} onChange={(event) => setState((current) => ({ ...current, devices: current.devices.map((device) => device.id === selectedDevice.id ? { ...device, address: event.target.value } : device) }))} onBlur={() => void persistState(state, "Device updated")} placeholder="192.168.x.x:5025, TCPIP0::..., COM5, etc." style={inputStyle()} />
                </label>
              </div>
              <label style={{ ...labelStyle(), marginTop: "0.85rem" }}>
                Capabilities
                <input
                  value={selectedDevice.capabilities.join(", ")}
                  onChange={(event) => setState((current) => ({
                    ...current,
                    devices: current.devices.map((device) => device.id === selectedDevice.id ? { ...device, capabilities: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) } : device),
                  }))}
                  onBlur={() => void persistState(state, "Device updated")}
                  placeholder="connect, execute_command, capture_artifact"
                  style={inputStyle()}
                />
              </label>
              <label style={{ ...labelStyle(), marginTop: "0.85rem" }}>
                Notes
                <textarea value={selectedDevice.notes ?? ""} onChange={(event) => setState((current) => ({ ...current, devices: current.devices.map((device) => device.id === selectedDevice.id ? { ...device, notes: event.target.value } : device) }))} onBlur={() => void persistState(state, "Device updated")} rows={7} style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.6 }} />
              </label>
            </div>
            <footer style={{ padding: "0.85rem 1.1rem", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => setDeviceProfileOpen(false)} style={buttonStyle()}>Close</button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export async function onExport(ctx: ExportContext): Promise<void> {
  const storage = getStorageInfo(ctx.config);
  const s3 = ctx.s3Client as S3Client;
  const stateText = await readOptionalText(s3, storage.bucket, storage.stateKey);
  if (!stateText) return;
  await writeText(s3, storage.bucket, `${ctx.projectPrefix}${ctx.config.id}/export/state.json`, stateText, "application/json");
}
