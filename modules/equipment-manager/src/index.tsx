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
type CommandOutputSource = "json-path" | "regex";
type StepInputSource = "literal" | "step-output";

type CommandInputDef = {
  id: string;
  name: string;
  required: boolean;
  defaultValue?: string;
  options?: string[];
  description?: string;
};

type CommandOutputDef = {
  id: string;
  name: string;
  source: CommandOutputSource;
  selector: string;
  captureGroup?: number;
  description?: string;
};

type EquipmentCommand = {
  id: string;
  name: string;
  categoryPath?: string;
  builtIn?: boolean;
  mode: CommandMode;
  payload: string;
  parser: ParserMode;
  timeoutMs: number;
  saveAs?: string;
  artifactMode: ArtifactMode;
  notes?: string;
  inputDefs: CommandInputDef[];
  outputDefs: CommandOutputDef[];
  testValues?: Record<string, string>;
};

type ScriptStepInputBinding = {
  id: string;
  inputName: string;
  source: StepInputSource;
  literalValue?: string;
  sourceStepId?: string;
  sourceOutputName?: string;
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
  inputBindings: ScriptStepInputBinding[];
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
  builtIn?: boolean;
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
  outputs?: Record<string, unknown>;
  steps?: Array<{
    stepId?: string;
    title: string;
    ok: boolean;
    output?: unknown;
    outputs?: Record<string, unknown>;
    commandName?: string;
    artifactMode?: ArtifactMode;
    parser?: ParserMode;
    payload?: string;
    resolvedInputs?: Record<string, unknown>;
    notes?: string;
    saveAs?: string;
  }>;
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
    descriptorBytes?: number;
    setupCommand: string;
    setupReadMode: string;
    queries: Record<string, string>;
    descriptor?: {
      waveArrayCount: number;
      returnedPointCount: number;
      sourceIntervalSeconds: number;
      effectiveIntervalSeconds: number;
      totalSpanSeconds: number;
    };
  };
  preferredViewport?: {
    xMinSeconds?: number;
    xMaxSeconds?: number;
    yMinVolts?: number;
    yMaxVolts?: number;
  };
  points: SiglentWaveformPoint[];
};

type SiglentWaveDescriptor = {
  waveArrayCount: number;
  returnedPointCount: number;
  sourceIntervalSeconds: number;
  effectiveIntervalSeconds: number;
  totalSpanSeconds: number;
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
  createScripts?: (device: EquipmentDevice) => EquipmentScript[];
};

type CommandListEntry =
  | { kind: "category"; key: string; label: string; depth: number }
  | { kind: "command"; key: string; command: EquipmentCommand; depth: number };

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
const SIGLENT_WAVEFORM_POINT_LIMIT = 20000;
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

function normalizeCommandInputDef(value: unknown, index: number): CommandInputDef {
  const record = toRecord(value);
  const rawOptions = record.options ?? record.values;
  const options = Array.isArray(rawOptions)
    ? rawOptions.map((option) => toStringValue(option, "").trim()).filter(Boolean)
    : [];
  return {
    id: toStringValue(record.id, `input-${index + 1}`),
    name: toStringValue(record.name, `input${index + 1}`),
    required: Boolean(record.required ?? true),
    defaultValue: toStringValue(record.defaultValue ?? record.default_value, "") || undefined,
    options: options.length ? options : undefined,
    description: toStringValue(record.description, "") || undefined,
  };
}

function normalizeCommandOutputDef(value: unknown, index: number): CommandOutputDef {
  const record = toRecord(value);
  const source = toStringValue(record.source, "json-path");
  return {
    id: toStringValue(record.id, `output-${index + 1}`),
    name: toStringValue(record.name, `output${index + 1}`),
    source: source === "regex" ? "regex" : "json-path",
    selector: toStringValue(record.selector, ""),
    captureGroup: typeof record.captureGroup === "undefined" && typeof record.capture_group === "undefined"
      ? undefined
      : toNumberValue(record.captureGroup ?? record.capture_group, 1),
    description: toStringValue(record.description, "") || undefined,
  };
}

function normalizeCommand(value: unknown, index: number): EquipmentCommand {
  const record = toRecord(value);
  const mode = toStringValue(record.mode, "scpi");
  const parser = toStringValue(record.parser, "text");
  const artifactMode = toStringValue(record.artifactMode ?? record.artifact_mode, "none");
  return {
    id: toStringValue(record.id, `command-${index + 1}`),
    name: toStringValue(record.name, `Command ${index + 1}`),
    categoryPath: toStringValue(record.categoryPath ?? record.category_path, "") || undefined,
    builtIn: Boolean(record.builtIn ?? record.built_in),
    mode: COMMAND_MODES.includes(mode as CommandMode) ? mode as CommandMode : "custom",
    payload: toStringValue(record.payload, ""),
    parser: PARSER_MODES.includes(parser as ParserMode) ? parser as ParserMode : "text",
    timeoutMs: toNumberValue(record.timeoutMs ?? record.timeout_ms, 5000),
    saveAs: toStringValue(record.saveAs ?? record.save_as, "") || undefined,
    artifactMode: ARTIFACT_MODES.includes(artifactMode as ArtifactMode) ? artifactMode as ArtifactMode : "none",
    notes: toStringValue(record.notes, "") || undefined,
    inputDefs: Array.isArray(record.inputDefs ?? record.input_defs) ? ((record.inputDefs ?? record.input_defs) as unknown[]).map(normalizeCommandInputDef) : [],
    outputDefs: Array.isArray(record.outputDefs ?? record.output_defs) ? ((record.outputDefs ?? record.output_defs) as unknown[]).map(normalizeCommandOutputDef) : [],
    testValues: toRecord(record.testValues ?? record.test_values) as Record<string, string>,
  };
}

function normalizeStepInputBinding(value: unknown, index: number): ScriptStepInputBinding {
  const record = toRecord(value);
  const source = toStringValue(record.source, "literal");
  return {
    id: toStringValue(record.id, `binding-${index + 1}`),
    inputName: toStringValue(record.inputName ?? record.input_name, ""),
    source: source === "step-output" ? "step-output" : "literal",
    literalValue: toStringValue(record.literalValue ?? record.literal_value, "") || undefined,
    sourceStepId: toStringValue(record.sourceStepId ?? record.source_step_id, "") || undefined,
    sourceOutputName: toStringValue(record.sourceOutputName ?? record.source_output_name, "") || undefined,
  };
}

const SCPI_VALUE_REGEX = "(?:^|[\\s,])(-?\\d+(?:\\.\\d+)?(?:E[+-]?\\d+)?[GMKmunp]?)";

function inferKnownCommandCategory(commandName: string): string | undefined {
  const name = commandName.trim().toLowerCase();
  if (name === "identify") return "Instrument / Identity";
  if (name.includes("trigger")) {
    if (name.includes("read")) return "Trigger / Read";
    return "Trigger / Control";
  }
  if (name.includes("capture screenshot")) return "Acquire / Capture";
  if (name.includes("capture waveform")) return "Acquire / Waveform";
  if (name.includes("sample rate") || name.includes("timebase")) return "Acquire / Timing";
  if (name.includes("scale") || name.includes("offset")) return "Channel / CH1";
  if (name.includes("screen")) return "Display";
  return undefined;
}

function commandCategoryLabel(command: EquipmentCommand): string {
  return command.categoryPath?.trim() || "Uncategorized";
}

function buildCommandListEntries(commands: EquipmentCommand[]): CommandListEntry[] {
  const sorted = [...commands].sort((a, b) => {
    const categoryCompare = commandCategoryLabel(a).localeCompare(commandCategoryLabel(b));
    if (categoryCompare !== 0) return categoryCompare;
    return a.name.localeCompare(b.name);
  });
  const entries: CommandListEntry[] = [];
  let lastCategory = "";
  for (const command of sorted) {
    const category = commandCategoryLabel(command);
    if (category !== lastCategory) {
      const segments = category.split("/").map((segment) => segment.trim()).filter(Boolean);
      entries.push({
        kind: "category",
        key: `category-${category}`,
        label: segments[segments.length - 1] ?? category,
        depth: Math.max(0, segments.length - 1),
      });
      lastCategory = category;
    }
    const segments = category.split("/").map((segment) => segment.trim()).filter(Boolean);
    entries.push({
      kind: "command",
      key: command.id,
      command,
      depth: segments.length,
    });
  }
  return entries;
}

function buildCommandSelectGroups(commands: EquipmentCommand[]): Array<{ label: string; commands: EquipmentCommand[] }> {
  const grouped = new Map<string, EquipmentCommand[]>();
  for (const command of [...commands].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = commandCategoryLabel(command);
    const bucket = grouped.get(key) ?? [];
    bucket.push(command);
    grouped.set(key, bucket);
  }
  return Array.from(grouped.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, groupCommands]) => ({ label, commands: groupCommands }));
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
    inputBindings: Array.isArray(record.inputBindings ?? record.input_bindings) ? ((record.inputBindings ?? record.input_bindings) as unknown[]).map(normalizeStepInputBinding) : [],
  };
}

function normalizeDevice(value: unknown, index: number): EquipmentDevice {
  const record = toRecord(value);
  const transport = toStringValue(record.transport, "custom");
  const name = toStringValue(record.name, `Device ${index + 1}`);
  const commands = Array.isArray(record.commands) ? record.commands.map(normalizeCommand) : [];
  const upgradedCommands = /siglent\s+sds1202x-e/i.test(name)
    ? commands.map((command) => {
        const commandName = command.name.trim().toLowerCase();
        if (command.name === "Capture Screenshot" && command.payload.trim() === ":DISPlay:DATA? PNG, COLor") {
          return {
            ...command,
            payload: "SCDP",
            parser: "binary" as ParserMode,
            timeoutMs: Math.max(command.timeoutMs, 15000),
            artifactMode: "image" as ArtifactMode,
            saveAs: "scope-screen.bmp",
            notes: "Siglent SDS1202X-E screenshot capture returns bitmap bytes over SCPI via the SCDP command.",
          };
        }
        if (commandName === "read ch1 scale") {
          return {
            ...command,
            categoryPath: command.categoryPath ?? "Channel / CH1",
            outputDefs: [
              { id: command.outputDefs[0]?.id ?? makeId("output"), name: "voltsPerDivText", source: "json-path" as CommandOutputSource, selector: "text" },
              { id: command.outputDefs[1]?.id ?? makeId("output"), name: "voltsPerDiv", source: "regex" as CommandOutputSource, selector: SCPI_VALUE_REGEX, captureGroup: 1 },
            ],
          };
        }
        if (commandName === "read ch1 offset") {
          return {
            ...command,
            categoryPath: command.categoryPath ?? "Channel / CH1",
            outputDefs: [
              { id: command.outputDefs[0]?.id ?? makeId("output"), name: "offsetVoltsText", source: "json-path" as CommandOutputSource, selector: "text" },
              { id: command.outputDefs[1]?.id ?? makeId("output"), name: "offsetVolts", source: "regex" as CommandOutputSource, selector: SCPI_VALUE_REGEX, captureGroup: 1 },
            ],
          };
        }
        if (commandName === "read timebase") {
          return {
            ...command,
            categoryPath: command.categoryPath ?? "Acquire / Timing",
            outputDefs: [
              { id: command.outputDefs[0]?.id ?? makeId("output"), name: "timeDivText", source: "json-path" as CommandOutputSource, selector: "text" },
              { id: command.outputDefs[1]?.id ?? makeId("output"), name: "timePerDivSeconds", source: "regex" as CommandOutputSource, selector: SCPI_VALUE_REGEX, captureGroup: 1 },
            ],
          };
        }
        if (commandName === "read trigger delay") {
          return {
            ...command,
            categoryPath: command.categoryPath ?? "Trigger / Read",
            outputDefs: [
              { id: command.outputDefs[0]?.id ?? makeId("output"), name: "triggerDelayText", source: "json-path" as CommandOutputSource, selector: "text" },
              { id: command.outputDefs[1]?.id ?? makeId("output"), name: "triggerDelaySeconds", source: "regex" as CommandOutputSource, selector: SCPI_VALUE_REGEX, captureGroup: 1 },
            ],
          };
        }
        if (commandName === "capture ch1 waveform" || commandName === "capture waveform") {
          return {
            ...command,
            name: "Capture Waveform",
            categoryPath: command.categoryPath ?? "Acquire / Waveform",
            payload: command.payload.includes("{{channel}}") ? command.payload : "{{channel}}:WF? DAT2",
            inputDefs: [
              { id: command.inputDefs[0]?.id ?? makeId("input"), name: "channel", required: true, defaultValue: "C1", description: "Scope channel to capture, such as C1." },
            ],
            outputDefs: [
              { id: command.outputDefs[0]?.id ?? makeId("output"), name: "sampleRateHz", source: "json-path" as CommandOutputSource, selector: "metadata.sampleRateHz" },
              { id: command.outputDefs[1]?.id ?? makeId("output"), name: "timePerDivSeconds", source: "json-path" as CommandOutputSource, selector: "metadata.timePerDivSeconds" },
              { id: command.outputDefs[2]?.id ?? makeId("output"), name: "voltsPerDiv", source: "json-path" as CommandOutputSource, selector: "metadata.voltsPerDiv" },
              { id: command.outputDefs[3]?.id ?? makeId("output"), name: "triggerDelaySeconds", source: "json-path" as CommandOutputSource, selector: "metadata.triggerDelaySeconds" },
              { id: command.outputDefs[4]?.id ?? makeId("output"), name: "offsetVolts", source: "json-path" as CommandOutputSource, selector: "metadata.offsetVolts" },
              { id: command.outputDefs[5]?.id ?? makeId("output"), name: "windowStartSeconds", source: "json-path" as CommandOutputSource, selector: "startTimeSeconds" },
              { id: command.outputDefs[6]?.id ?? makeId("output"), name: "windowEndSeconds", source: "json-path" as CommandOutputSource, selector: "endTimeSeconds" },
              { id: command.outputDefs[7]?.id ?? makeId("output"), name: "minVoltage", source: "json-path" as CommandOutputSource, selector: "minVoltage" },
              { id: command.outputDefs[8]?.id ?? makeId("output"), name: "maxVoltage", source: "json-path" as CommandOutputSource, selector: "maxVoltage" },
            ],
            notes: "Fetches waveform samples plus scaling metadata, then renders an interactive waveform chart.",
          };
        }
        return command;
      }).filter((command) => command.name.trim().toLowerCase() !== "set trigger slope")
      .map((command) => ({
        ...command,
        categoryPath: command.categoryPath ?? inferKnownCommandCategory(command.name),
      }))
    : commands;
  const mergedCommands = /siglent\s+sds1202x-e/i.test(name)
    ? (() => {
        const presetCommands = createKnownSiglentPreset(undefined, toStringValue(record.address, "")).device.commands;
        const existingByName = new Map(upgradedCommands.map((command) => [command.name.trim().toLowerCase(), command] as const));
        const merged = [...upgradedCommands];
        for (const presetCommand of presetCommands) {
          const key = presetCommand.name.trim().toLowerCase();
          if (!existingByName.has(key)) {
            merged.push(presetCommand);
          }
        }
        return merged;
      })()
    : upgradedCommands;
  return {
    id: toStringValue(record.id, `device-${index + 1}`),
    name,
    transport: TRANSPORTS.includes(transport as EquipmentTransport) ? transport as EquipmentTransport : "custom",
    address: toStringValue(record.address, ""),
    capabilities: Array.isArray(record.capabilities) ? record.capabilities.map((item) => String(item)).filter(Boolean) : [],
    notes: toStringValue(record.notes, "") || undefined,
    commands: mergedCommands,
  };
}

function normalizeScript(value: unknown, index: number): EquipmentScript {
  const record = toRecord(value);
  return {
    id: toStringValue(record.id, `script-${index + 1}`),
    name: toStringValue(record.name, `Script ${index + 1}`),
    builtIn: Boolean(record.builtIn ?? record.built_in),
    deviceId: toStringValue(record.deviceId ?? record.device_id, "") || undefined,
    description: toStringValue(record.description, "") || undefined,
    steps: Array.isArray(record.steps) ? record.steps.map(normalizeStep) : [],
  };
}

function repairBuiltInScripts(state: EquipmentManagerState): EquipmentManagerState {
  const devicesById = new Map(state.devices.map((device) => [device.id, device] as const));
  const allCommands = state.devices.flatMap((device) => device.commands);
  const builtInCommandByName = new Map(
    allCommands
      .filter((command) => command.builtIn)
      .map((command) => [command.name.trim().toLowerCase(), command] as const),
  );
  const builtInCommandNameByStepTitle = new Map<string, string>([
    ["identify instrument", "identify"],
    ["read ch1 scale", "read ch1 scale"],
    ["read ch1 offset", "read ch1 offset"],
    ["read timebase", "read timebase"],
    ["read sample rate", "read sample rate"],
    ["read trigger delay", "read trigger delay"],
    ["read trigger mode", "read trigger mode"],
    ["read trigger source", "read trigger source"],
    ["read trigger level", "read trigger level"],
    ["capture scope screen", "capture screenshot"],
    ["capture ch1 waveform", "capture ch1 waveform"],
    ["capture waveform", "capture waveform"],
  ]);

  return {
    ...state,
    scripts: state.scripts.map((script) => {
      if (!script.builtIn) return script;
      const deviceCommands = script.deviceId ? (devicesById.get(script.deviceId)?.commands ?? []) : allCommands;
      const availableCommands = deviceCommands.length ? deviceCommands : allCommands;
      const availableById = new Map(availableCommands.map((command) => [command.id, command] as const));
      let changed = false;
      const repairedSteps = script.steps.map((step) => {
        if (step.type !== "command" && step.type !== "capture") return step;
        if (step.commandId && availableById.has(step.commandId)) return step;
        const expectedCommandName = builtInCommandNameByStepTitle.get(step.title.trim().toLowerCase());
        if (!expectedCommandName) return step;
        const replacement = availableCommands.find((command) => command.name.trim().toLowerCase() === expectedCommandName)
          ?? builtInCommandByName.get(expectedCommandName);
        if (!replacement || replacement.id === step.commandId) return step;
        changed = true;
        return { ...step, commandId: replacement.id };
      });
      let nextSteps = repairedSteps;
      const captureWaveformStep = nextSteps.find((step) => step.title.trim().toLowerCase() === "capture waveform" || step.title.trim().toLowerCase() === "capture ch1 waveform");
      if (captureWaveformStep) {
        const normalizedBindings: ScriptStepInputBinding[] = [
          { id: captureWaveformStep.inputBindings.find((entry) => entry.inputName === "channel")?.id ?? makeId("binding"), inputName: "channel", source: "literal", literalValue: captureWaveformStep.inputBindings.find((entry) => entry.inputName === "channel")?.literalValue ?? "C1" },
        ];
        nextSteps = nextSteps.map((step) => step.id === captureWaveformStep.id
          ? { ...step, title: "Capture waveform", inputBindings: normalizedBindings }
          : step);
        changed = true;
      }
      return changed ? { ...script, steps: nextSteps } : script;
    }),
  };
}

function createDefaultState(): EquipmentManagerState {
  const demoDeviceId = makeId("device");
  const identifyCommandId = makeId("command");
  const channelScaleCommandId = makeId("command");
  const channelOffsetCommandId = makeId("command");
  const timebaseCommandId = makeId("command");
  const sampleRateCommandId = makeId("command");
  const triggerDelayCommandId = makeId("command");
  const triggerModeCommandId = makeId("command");
  const triggerLevelCommandId = makeId("command");
  const triggerSourceCommandId = makeId("command");
  const triggerSlopeCommandId = makeId("command");
  const setTriggerSlopeCommandId = makeId("command");
  const setTriggerModeCommandId = makeId("command");
  const setTriggerLevelCommandId = makeId("command");
  const runScopeCommandId = makeId("command");
  const stopScopeCommandId = makeId("command");
  const armSingleCommandId = makeId("command");
  const setTimebaseCommandId = makeId("command");
  const setChannelScaleCommandId = makeId("command");
  const setChannelOffsetCommandId = makeId("command");
  const captureCommandId = makeId("command");
  const waveformCommandId = makeId("command");
  const identifyStepId = makeId("step");
  const channelScaleStepId = makeId("step");
  const channelOffsetStepId = makeId("step");
  const timebaseStepId = makeId("step");
  const sampleRateStepId = makeId("step");
  const triggerDelayStepId = makeId("step");
  const triggerModeStepId = makeId("step");
  const triggerSourceStepId = makeId("step");
  const triggerLevelStepId = makeId("step");
  const captureScreenStepId = makeId("step");
  const captureWaveformStepId = makeId("step");
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
          categoryPath: "Instrument / Identity",
          builtIn: true,
          mode: "scpi",
          payload: "*IDN?",
          parser: "text",
          timeoutMs: 3000,
          artifactMode: "text",
          saveAs: "identity.txt",
          inputDefs: [],
          outputDefs: [],
        },
        {
          id: channelScaleCommandId,
          name: "Read CH1 Scale",
          categoryPath: "Channel / CH1",
          builtIn: true,
          mode: "scpi",
          payload: "C1:VDIV?",
          parser: "text",
          timeoutMs: 3000,
          artifactMode: "text",
          saveAs: "ch1-scale.txt",
          inputDefs: [],
          outputDefs: [
            { id: makeId("output"), name: "voltsPerDivText", source: "json-path", selector: "text" },
            { id: makeId("output"), name: "voltsPerDiv", source: "regex", selector: SCPI_VALUE_REGEX, captureGroup: 1 },
          ],
        },
        {
          id: channelOffsetCommandId,
          name: "Read CH1 Offset",
          categoryPath: "Channel / CH1",
          builtIn: true,
          mode: "scpi",
          payload: "C1:OFST?",
          parser: "text",
          timeoutMs: 3000,
          artifactMode: "text",
          saveAs: "ch1-offset.txt",
          inputDefs: [],
          outputDefs: [
            { id: makeId("output"), name: "offsetVoltsText", source: "json-path", selector: "text" },
            { id: makeId("output"), name: "offsetVolts", source: "regex", selector: SCPI_VALUE_REGEX, captureGroup: 1 },
          ],
        },
        {
          id: timebaseCommandId,
          name: "Read Timebase",
          categoryPath: "Acquire / Timing",
          builtIn: true,
          mode: "scpi",
          payload: "TDIV?",
          parser: "text",
          timeoutMs: 3000,
          artifactMode: "text",
          saveAs: "timebase.txt",
          inputDefs: [],
          outputDefs: [
            { id: makeId("output"), name: "timeDivText", source: "json-path", selector: "text" },
            { id: makeId("output"), name: "timePerDivSeconds", source: "regex", selector: SCPI_VALUE_REGEX, captureGroup: 1 },
          ],
        },
        {
          id: sampleRateCommandId,
          name: "Read Sample Rate",
          categoryPath: "Acquire / Timing",
          builtIn: true,
          mode: "scpi",
          payload: "SARA?",
          parser: "text",
          timeoutMs: 3000,
          artifactMode: "text",
          saveAs: "sample-rate.txt",
          inputDefs: [],
          outputDefs: [{ id: makeId("output"), name: "sampleRateText", source: "json-path", selector: "text" }],
        },
        {
          id: triggerDelayCommandId,
          name: "Read Trigger Delay",
          categoryPath: "Trigger / Read",
          builtIn: true,
          mode: "scpi",
          payload: "TRDL?",
          parser: "text",
          timeoutMs: 3000,
          artifactMode: "text",
          saveAs: "trigger-delay.txt",
          inputDefs: [],
          outputDefs: [
            { id: makeId("output"), name: "triggerDelayText", source: "json-path", selector: "text" },
            { id: makeId("output"), name: "triggerDelaySeconds", source: "regex", selector: SCPI_VALUE_REGEX, captureGroup: 1 },
          ],
        },
        {
          id: triggerModeCommandId,
          name: "Read Trigger Mode",
          categoryPath: "Trigger / Read",
          builtIn: true,
          mode: "scpi",
          payload: "TRMD?",
          parser: "text",
          timeoutMs: 3000,
          artifactMode: "text",
          saveAs: "trigger-mode.txt",
          inputDefs: [],
          outputDefs: [{ id: makeId("output"), name: "triggerMode", source: "json-path", selector: "text" }],
        },
        {
          id: triggerLevelCommandId,
          name: "Read Trigger Level",
          categoryPath: "Trigger / Read",
          builtIn: true,
          mode: "scpi",
          payload: "C1:TRLV?",
          parser: "text",
          timeoutMs: 3000,
          artifactMode: "text",
          saveAs: "trigger-level.txt",
          inputDefs: [],
          outputDefs: [{ id: makeId("output"), name: "triggerLevelText", source: "json-path", selector: "text" }],
        },
        {
          id: triggerSourceCommandId,
          name: "Read Trigger Source",
          categoryPath: "Trigger / Read",
          builtIn: true,
          mode: "scpi",
          payload: "TRSE?",
          parser: "text",
          timeoutMs: 3000,
          artifactMode: "text",
          saveAs: "trigger-source.txt",
          inputDefs: [],
          outputDefs: [{ id: makeId("output"), name: "triggerSourceText", source: "json-path", selector: "text" }],
        },
        {
          id: triggerSlopeCommandId,
          name: "Read Trigger Slope",
          categoryPath: "Trigger / Read",
          builtIn: true,
          mode: "scpi",
          payload: "{{channel}}:TRSL?",
          parser: "text",
          timeoutMs: 3000,
          artifactMode: "text",
          saveAs: "trigger-slope.txt",
          inputDefs: [
            { id: makeId("input"), name: "channel", required: true, defaultValue: "C1", options: ["C1", "C2"], description: "Trigger source channel." },
          ],
          outputDefs: [{ id: makeId("output"), name: "triggerSlopeText", source: "json-path", selector: "text" }],
        },
        {
          id: setTriggerSlopeCommandId,
          name: "Set Trigger Slope",
          categoryPath: "Trigger / Control",
          builtIn: true,
          mode: "scpi",
          payload: "{{channel}}:TRSL {{slope}}",
          parser: "none",
          timeoutMs: 3000,
          artifactMode: "none",
          notes: "Uses the documented SDS1000X-E TRIG_SLOPE command. Example from Siglent programming guide: C2:TRSL NEG.",
          inputDefs: [
            { id: makeId("input"), name: "channel", required: true, defaultValue: "C1", options: ["C1", "C2"], description: "Trigger source channel." },
            { id: makeId("input"), name: "slope", required: true, defaultValue: "NEG", options: ["NEG", "POS", "WINDOW"], description: "Trigger slope." },
          ],
          outputDefs: [],
        },
        {
          id: setTriggerModeCommandId,
          name: "Set Trigger Mode",
          categoryPath: "Trigger / Control",
          builtIn: true,
          mode: "scpi",
          payload: "TRMD {{mode}}",
          parser: "none",
          timeoutMs: 3000,
          artifactMode: "none",
          notes: "Validated on the live SDS1202X-E with AUTO and NORM. SINGLE should be armed with ARM. Rising/falling edge selection is trigger slope, not TRMD trigger mode.",
          inputDefs: [
            { id: makeId("input"), name: "mode", required: true, defaultValue: "AUTO", options: ["AUTO", "NORM", "SINGLE"], description: "TRMD acquisition trigger mode. Edge direction is configured separately as trigger slope." },
          ],
          outputDefs: [],
        },
        {
          id: setTriggerLevelCommandId,
          name: "Set Trigger Level",
          categoryPath: "Trigger / Control",
          builtIn: true,
          mode: "scpi",
          payload: "{{channel}}:TRLV {{levelVolts}}V",
          parser: "none",
          timeoutMs: 3000,
          artifactMode: "none",
          notes: "Validated on the live SDS1202X-E.",
          inputDefs: [
            { id: makeId("input"), name: "channel", required: true, defaultValue: "C1", description: "Scope channel, such as C1." },
            { id: makeId("input"), name: "levelVolts", required: true, defaultValue: "1.00", description: "Trigger level in volts." },
          ],
          outputDefs: [],
        },
        {
          id: runScopeCommandId,
          name: "Run Scope",
          categoryPath: "Acquire / Control",
          builtIn: true,
          mode: "scpi",
          payload: "RUN",
          parser: "none",
          timeoutMs: 3000,
          artifactMode: "none",
          notes: "Validated on the live SDS1202X-E.",
          inputDefs: [],
          outputDefs: [],
        },
        {
          id: stopScopeCommandId,
          name: "Stop Scope",
          categoryPath: "Acquire / Control",
          builtIn: true,
          mode: "scpi",
          payload: "STOP",
          parser: "none",
          timeoutMs: 3000,
          artifactMode: "none",
          notes: "Validated on the live SDS1202X-E.",
          inputDefs: [],
          outputDefs: [],
        },
        {
          id: armSingleCommandId,
          name: "Arm Single",
          categoryPath: "Acquire / Control",
          builtIn: true,
          mode: "scpi",
          payload: "ARM",
          parser: "none",
          timeoutMs: 3000,
          artifactMode: "none",
          notes: "Validated on the live SDS1202X-E; places trigger mode into SINGLE.",
          inputDefs: [],
          outputDefs: [],
        },
        {
          id: setTimebaseCommandId,
          name: "Set Timebase",
          categoryPath: "Acquire / Timing",
          builtIn: true,
          mode: "scpi",
          payload: "TDIV {{timePerDivSeconds}}S",
          parser: "none",
          timeoutMs: 3000,
          artifactMode: "none",
          notes: "Validated on the live SDS1202X-E.",
          inputDefs: [
            { id: makeId("input"), name: "timePerDivSeconds", required: true, defaultValue: "5.00E-04", description: "Time per division in seconds." },
          ],
          outputDefs: [],
        },
        {
          id: setChannelScaleCommandId,
          name: "Set Channel Scale",
          categoryPath: "Channel / CH1",
          builtIn: true,
          mode: "scpi",
          payload: "{{channel}}:VDIV {{voltsPerDiv}}V",
          parser: "none",
          timeoutMs: 3000,
          artifactMode: "none",
          notes: "Validated on the live SDS1202X-E.",
          inputDefs: [
            { id: makeId("input"), name: "channel", required: true, defaultValue: "C1", description: "Scope channel, such as C1." },
            { id: makeId("input"), name: "voltsPerDiv", required: true, defaultValue: "5.00E-01", description: "Volts per division." },
          ],
          outputDefs: [],
        },
        {
          id: setChannelOffsetCommandId,
          name: "Set Channel Offset",
          categoryPath: "Channel / CH1",
          builtIn: true,
          mode: "scpi",
          payload: "{{channel}}:OFST {{offsetVolts}}V",
          parser: "none",
          timeoutMs: 3000,
          artifactMode: "none",
          notes: "Validated on the live SDS1202X-E.",
          inputDefs: [
            { id: makeId("input"), name: "channel", required: true, defaultValue: "C1", description: "Scope channel, such as C1." },
            { id: makeId("input"), name: "offsetVolts", required: true, defaultValue: "-1.50E+00", description: "Channel offset in volts." },
          ],
          outputDefs: [],
        },
        {
          id: captureCommandId,
          name: "Capture Screenshot",
          categoryPath: "Acquire / Capture",
          builtIn: true,
          mode: "scpi",
          payload: "SCDP",
          parser: "binary",
          timeoutMs: 15000,
          artifactMode: "image",
          saveAs: "scope-screen.bmp",
          notes: "Returns a bitmap screenshot from the instrument over SCPI.",
          inputDefs: [],
          outputDefs: [],
        },
        {
          id: waveformCommandId,
          name: "Capture Waveform",
          categoryPath: "Acquire / Waveform",
          builtIn: true,
          mode: "scpi",
          payload: "{{channel}}:WF? DAT2",
          parser: "siglent-waveform",
          timeoutMs: 15000,
          artifactMode: "csv",
          saveAs: "ch1-waveform.csv",
          notes: "Fetches up to 20,000 waveform samples plus scaling metadata, then renders an interactive waveform chart.",
          inputDefs: [
            { id: makeId("input"), name: "channel", required: true, defaultValue: "C1", description: "Scope channel to capture, such as C1." },
          ],
          outputDefs: [
            { id: makeId("output"), name: "sampleRateHz", source: "json-path", selector: "metadata.sampleRateHz" },
            { id: makeId("output"), name: "timePerDivSeconds", source: "json-path", selector: "metadata.timePerDivSeconds" },
            { id: makeId("output"), name: "voltsPerDiv", source: "json-path", selector: "metadata.voltsPerDiv" },
            { id: makeId("output"), name: "triggerDelaySeconds", source: "json-path", selector: "metadata.triggerDelaySeconds" },
            { id: makeId("output"), name: "offsetVolts", source: "json-path", selector: "metadata.offsetVolts" },
            { id: makeId("output"), name: "windowStartSeconds", source: "json-path", selector: "startTimeSeconds" },
            { id: makeId("output"), name: "windowEndSeconds", source: "json-path", selector: "endTimeSeconds" },
            { id: makeId("output"), name: "minVoltage", source: "json-path", selector: "minVoltage" },
            { id: makeId("output"), name: "maxVoltage", source: "json-path", selector: "maxVoltage" },
          ],
        },
      ],
    }],
      scripts: [{
      id: makeId("script"),
      name: "Scope Window Snapshot",
      builtIn: true,
      deviceId: demoDeviceId,
      description: "Collect the key scope settings needed to reproduce the currently displayed waveform window, then capture both screenshot and waveform data.",
      steps: [
        { id: identifyStepId, type: "command", title: "Identify instrument", commandId: identifyCommandId, saveAs: "identity.txt", notes: "Built-in scope identity query.", inputBindings: [] },
        { id: channelScaleStepId, type: "command", title: "Read CH1 scale", commandId: channelScaleCommandId, saveAs: "ch1-scale.txt", inputBindings: [] },
        { id: channelOffsetStepId, type: "command", title: "Read CH1 offset", commandId: channelOffsetCommandId, saveAs: "ch1-offset.txt", inputBindings: [] },
        { id: timebaseStepId, type: "command", title: "Read timebase", commandId: timebaseCommandId, saveAs: "timebase.txt", inputBindings: [] },
        { id: sampleRateStepId, type: "command", title: "Read sample rate", commandId: sampleRateCommandId, saveAs: "sample-rate.txt", inputBindings: [] },
        { id: triggerDelayStepId, type: "command", title: "Read trigger delay", commandId: triggerDelayCommandId, saveAs: "trigger-delay.txt", inputBindings: [] },
        { id: triggerModeStepId, type: "command", title: "Read trigger mode", commandId: triggerModeCommandId, saveAs: "trigger-mode.txt", inputBindings: [] },
        { id: triggerSourceStepId, type: "command", title: "Read trigger source", commandId: triggerSourceCommandId, saveAs: "trigger-source.txt", inputBindings: [] },
        { id: triggerLevelStepId, type: "command", title: "Read trigger level", commandId: triggerLevelCommandId, saveAs: "trigger-level.txt", inputBindings: [] },
        { id: captureScreenStepId, type: "capture", title: "Capture scope screen", commandId: captureCommandId, saveAs: "scope-screen.bmp", inputBindings: [] },
        {
          id: captureWaveformStepId,
          type: "capture",
          title: "Capture waveform",
          commandId: waveformCommandId,
          saveAs: "ch1-waveform.csv",
          inputBindings: [
            { id: makeId("binding"), inputName: "channel", source: "literal", literalValue: "C1" },
          ],
        },
      ],
    }],
  };
}

function createKnownSiglentPreset(targetDeviceId?: string, targetAddress?: string): { device: EquipmentDevice; scripts: EquipmentScript[] } {
  const base = createDefaultState();
  const device = { ...base.devices[0]!, id: targetDeviceId ?? base.devices[0]!.id, address: targetAddress ?? base.devices[0]!.address };
  const scripts = base.scripts.map((script) => ({ ...script, deviceId: device.id }));
  return { device, scripts };
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const item of items) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }
  return deduped;
}

function normalizeState(value: unknown): EquipmentManagerState {
  const record = toRecord(value);
  const fallback = createDefaultState();
  return repairBuiltInScripts({
    version: 1,
    devices: dedupeById(Array.isArray(record.devices) ? record.devices.map(normalizeDevice) : fallback.devices),
    scripts: dedupeById(Array.isArray(record.scripts) ? record.scripts.map(normalizeScript) : fallback.scripts),
  });
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
  const matches = Array.from(text.matchAll(/(?:^|[\s,])(-?\d+(?:\.\d+)?(?:E[+-]?\d+)?)([GMKmunp]?)/g));
  const match = matches.at(-1);
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
    const printableCount = bytes.reduce((count, value) => (value >= 32 && value <= 126 ? count + 1 : count), 0);
    const printableRatio = bytes.length > 0 ? printableCount / bytes.length : 1;
    if (bytes.length >= 256 && printableRatio < 0.6) {
      const samples: number[] = [];
      for (const value of bytes) {
        samples.push(value > 127 ? value - 255 : value);
      }
      return samples;
    }
    const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 32)));
    throw new Error(`Waveform response did not contain a SCPI binary block. Prefix: ${JSON.stringify(prefix)}`);
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

function extractScpiBlockPayload(bytesBase64: string): Uint8Array {
  const bytes = base64ToBytes(bytesBase64);
  const hashIndex = bytes.indexOf(35);
  if (hashIndex < 0 || hashIndex + 1 >= bytes.length) {
    return bytes;
  }
  const digitCount = bytes[hashIndex + 1] - 48;
  if (digitCount < 1 || digitCount > 9) {
    return bytes;
  }
  const lengthText = new TextDecoder().decode(bytes.slice(hashIndex + 2, hashIndex + 2 + digitCount));
  const blockLength = Number(lengthText);
  if (!Number.isFinite(blockLength) || blockLength < 0) {
    return bytes;
  }
  const dataStart = hashIndex + 2 + digitCount;
  const dataEnd = Math.min(bytes.length, dataStart + blockLength);
  return bytes.slice(dataStart, dataEnd);
}

function readInt16LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(offset, true);
}

function readInt32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, true);
}

function readFloat32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(offset, true);
}

function parseSiglentWaveDescriptor(bytesBase64: string, returnedPointCount: number, fallbackSpanSeconds: number): SiglentWaveDescriptor | null {
  const payload = extractScpiBlockPayload(bytesBase64);
  const marker = new TextEncoder().encode("WAVEDESC");
  let start = -1;
  for (let index = 0; index <= payload.length - marker.length; index += 1) {
    let matches = true;
    for (let markerIndex = 0; markerIndex < marker.length; markerIndex += 1) {
      if (payload[index + markerIndex] !== marker[markerIndex]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      start = index;
      break;
    }
  }
  if (start < 0 || start + 184 > payload.length) return null;
  const descriptor = payload.slice(start);
  const waveArrayCount = readInt32LE(descriptor, 116);
  const sourceIntervalSeconds = readFloat32LE(descriptor, 176);
  const safeReturnedCount = Math.max(1, returnedPointCount);
  const sourcePointCount = waveArrayCount > 0 ? waveArrayCount : safeReturnedCount;
  const totalSpanSeconds = sourcePointCount > 0 && sourceIntervalSeconds > 0
    ? sourcePointCount * sourceIntervalSeconds
    : fallbackSpanSeconds;
  const effectiveIntervalSeconds = totalSpanSeconds / safeReturnedCount;
  if (!Number.isFinite(totalSpanSeconds) || totalSpanSeconds <= 0 || !Number.isFinite(effectiveIntervalSeconds) || effectiveIntervalSeconds <= 0) {
    return null;
  }
  return {
    waveArrayCount: sourcePointCount,
    returnedPointCount: safeReturnedCount,
    sourceIntervalSeconds,
    effectiveIntervalSeconds,
    totalSpanSeconds,
  };
}

function buildSiglentWaveformResult(args: {
  channel: string;
  waveform: TcpCommandResult;
  descriptor?: TcpCommandResult;
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
  const fallbackSpanSeconds = timePerDivSeconds * grid;
  const descriptor = args.descriptor?.bytesBase64
    ? parseSiglentWaveDescriptor(args.descriptor.bytesBase64, codes.length, fallbackSpanSeconds)
    : null;
  const intervalSeconds = descriptor?.effectiveIntervalSeconds ?? (fallbackSpanSeconds / Math.max(1, codes.length));
  const totalSpanSeconds = descriptor?.totalSpanSeconds ?? fallbackSpanSeconds;
  const startTimeSeconds = triggerDelaySeconds - (totalSpanSeconds / 2);
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
      descriptorBytes: args.descriptor?.bytesLength ?? 0,
      setupCommand: SIGLENT_WAVEFORM_SETUP,
      setupReadMode: "none",
      queries: {
        voltsPerDiv: args.voltsPerDivResponse,
        offset: args.offsetResponse,
        timeDiv: args.timeDivResponse,
        triggerDelay: args.triggerDelayResponse,
        sampleRate: args.sampleRateResponse,
      },
      descriptor: descriptor ?? undefined,
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

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function buildCommandResponseModel(command: EquipmentCommand, output: unknown): Record<string, unknown> {
  if (isSiglentWaveformResult(output)) {
    return {
      kind: output.kind,
      channel: output.channel,
      sampleCount: output.sampleCount,
      intervalSeconds: output.intervalSeconds,
      startTimeSeconds: output.startTimeSeconds,
      endTimeSeconds: output.endTimeSeconds,
      minVoltage: output.minVoltage,
      maxVoltage: output.maxVoltage,
      metadata: output.metadata,
      transport: output.transport,
    };
  }
  if (isTcpCommandResult(output)) {
    const text = output.text ?? output.data ?? "";
    const parsed = command.parser === "json" ? parseMaybeJson(text) : undefined;
    return {
      text,
      bytesLength: output.bytesLength,
      timedOut: output.timedOut,
      matchedMarker: output.matchedMarker,
      parsed,
      raw: output,
    };
  }
  if (output && typeof output === "object") {
    return output as Record<string, unknown>;
  }
  return { value: output };
}

function getValueByPath(value: unknown, selector: string): unknown {
  const trimmed = selector.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(".").filter(Boolean);
  let current: unknown = value;
  for (const part of parts) {
    if (current == null) return undefined;
    const indexMatch = part.match(/^([^[\]]+)\[(\d+)\]$/);
    if (indexMatch) {
      const container = (current as Record<string, unknown>)[indexMatch[1]!];
      if (!Array.isArray(container)) return undefined;
      current = container[Number(indexMatch[2])];
      continue;
    }
    if (Array.isArray(current)) {
      const numeric = Number(part);
      current = Number.isInteger(numeric) ? current[numeric] : undefined;
      continue;
    }
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
      continue;
    }
    return undefined;
  }
  return current;
}

function extractCommandOutputs(command: EquipmentCommand, output: unknown): Record<string, unknown> {
  const model = buildCommandResponseModel(command, output);
  const rawText = typeof model.text === "string"
    ? model.text
    : typeof output === "string"
      ? output
      : renderExecutionOutput(output);
  const extracted: Record<string, unknown> = {};
  for (const def of command.outputDefs) {
    if (!def.name.trim()) continue;
    if (def.source === "regex") {
      try {
        const match = new RegExp(def.selector, "m").exec(rawText);
        if (match) extracted[def.name] = match[def.captureGroup ?? 1] ?? match[0];
      } catch {
        // Ignore bad regex in extraction and let validation catch it later.
      }
      continue;
    }
    extracted[def.name] = getValueByPath(model, def.selector);
  }
  return extracted;
}

function stringifyTemplateValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function applyTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) => stringifyTemplateValue(values[key]));
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const direct = Number(text);
  if (Number.isFinite(direct)) return direct;
  try {
    return parseScpiNumber(text);
  } catch {
    return undefined;
  }
}

function cloneStateWithCommand(state: EquipmentManagerState, deviceId: string, commandId: string, mutate: (command: EquipmentCommand) => EquipmentCommand): EquipmentManagerState {
  return {
    ...state,
    devices: state.devices.map((device) => device.id === deviceId ? {
      ...device,
      commands: device.commands.map((command) => command.id === commandId ? mutate(command) : command),
    } : device),
  };
}

function cloneStateWithScript(state: EquipmentManagerState, scriptId: string, mutate: (script: EquipmentScript) => EquipmentScript): EquipmentManagerState {
  return {
    ...state,
    scripts: state.scripts.map((script) => script.id === scriptId ? mutate(script) : script),
  };
}

function upsertStepInputBinding(step: EquipmentScriptStep, binding: ScriptStepInputBinding): EquipmentScriptStep {
  return {
    ...step,
    inputBindings: [
      ...step.inputBindings.filter((entry) => entry.inputName !== binding.inputName),
      binding,
    ],
  };
}

function normalizeStepCommandNameFromTitle(title: string): string | null {
  const key = title.trim().toLowerCase();
  const stepToCommand = new Map<string, string>([
    ["identify instrument", "identify"],
    ["read ch1 scale", "read ch1 scale"],
    ["read ch1 offset", "read ch1 offset"],
    ["read timebase", "read timebase"],
    ["read sample rate", "read sample rate"],
    ["read trigger delay", "read trigger delay"],
    ["read trigger mode", "read trigger mode"],
    ["read trigger source", "read trigger source"],
    ["read trigger level", "read trigger level"],
    ["capture scope screen", "capture screenshot"],
    ["capture ch1 waveform", "capture waveform"],
    ["capture waveform", "capture waveform"],
  ]);
  return stepToCommand.get(key) ?? null;
}

function resolveCommandForStep(step: EquipmentScriptStep, commands: EquipmentCommand[]): EquipmentCommand | undefined {
  if (step.commandId) {
    const byId = commands.find((entry) => entry.id === step.commandId);
    if (byId) return byId;
  }
  const expectedName = normalizeStepCommandNameFromTitle(step.title);
  if (expectedName) {
    const byTitle = commands.find((entry) => entry.name.trim().toLowerCase() === expectedName);
    if (byTitle) return byTitle;
  }
  return undefined;
}

function getCommandInputValues(command: EquipmentCommand): Record<string, string> {
  const values: Record<string, string> = {};
  for (const def of command.inputDefs) {
    values[def.name] = command.testValues?.[def.name] ?? def.defaultValue ?? "";
  }
  return values;
}

function commandInputValueControl(args: {
  inputDef: CommandInputDef;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
}) {
  const options = args.inputDef.options ?? [];
  if (options.length) {
    const valueIsKnown = !args.value || options.includes(args.value);
    return (
      <select value={valueIsKnown ? args.value : ""} onChange={(event) => args.onChange(event.target.value)} onBlur={args.onBlur} style={inputStyle()}>
        {!args.inputDef.required ? <option value="">Optional</option> : null}
        {!valueIsKnown ? <option value="">{args.value}</option> : null}
        {options.map((option) => <option key={`${args.inputDef.id}-${option}`} value={option}>{option}</option>)}
      </select>
    );
  }
  return <input value={args.value} onChange={(event) => args.onChange(event.target.value)} onBlur={args.onBlur} style={inputStyle()} />;
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

function isTcpCommandResult(value: unknown): value is TcpCommandResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record["text"] === "string" || typeof record["bytesBase64"] === "string";
}

function isSiglentWaveformResult(value: unknown): value is SiglentWaveformResult {
  if (!value || typeof value !== "object") return false;
  return (value as { kind?: string }).kind === "siglent-waveform";
}

function guessImageMimeTypeFromName(name?: string): string {
  const saveAs = (name ?? "").toLowerCase();
  if (saveAs.endsWith(".jpg") || saveAs.endsWith(".jpeg")) return "image/jpeg";
  if (saveAs.endsWith(".bmp")) return "image/bmp";
  if (saveAs.endsWith(".gif")) return "image/gif";
  return "image/png";
}

function guessImageMimeType(command: EquipmentCommand): string {
  return guessImageMimeTypeFromName(command.saveAs);
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

function ExecutionArtifactView(props: { output: unknown; artifactMode?: ArtifactMode; saveAs?: string; label: string }) {
  const { output, artifactMode, saveAs, label } = props;
  if (isSiglentWaveformResult(output)) {
    return <WaveformChartInteractive key={`wave-${label}-${output.channel}-${output.sampleCount}-${output.startTimeSeconds}`} result={output} />;
  }
  if (isTcpCommandResult(output)) {
    if (artifactMode === "image" && output.bytesBase64) {
      return (
        <img
          src={`data:${guessImageMimeTypeFromName(saveAs)};base64,${output.bytesBase64}`}
          alt={label}
          style={{ display: "block", maxWidth: "100%", height: "auto", background: "white", borderRadius: 8 }}
        />
      );
    }
    return (
      <pre style={{ margin: 0, color: C.text, fontSize: "0.84rem", lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" }}>
        {output.text || output.data || "No interpreted output available."}
      </pre>
    );
  }
  return (
    <pre style={{ margin: 0, color: C.text, fontSize: "0.84rem", lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" }}>
      {renderExecutionOutput(output)}
    </pre>
  );
}

function ScriptExecutionTimeline({ result }: { result: ExecutionResult }) {
  if (!result.steps?.length) return null;
  return (
    <section style={{ ...cardStyle(), marginTop: "0.9rem" }}>
      <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Latest Run</div>
      <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.84rem" }}>
        {new Date(result.startedAt).toLocaleString()}
      </div>
      <div style={{ marginTop: "0.85rem", display: "grid", gap: "0.85rem" }}>
        {result.steps.map((step, index) => (
          <article key={`${step.stepId ?? "step"}-${index}`} style={{ border: `1px solid ${C.border}`, borderRadius: 12, background: C.panel2, padding: "0.85rem", display: "grid", gap: "0.75rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontWeight: 700 }}>{step.title}</div>
                <div style={{ marginTop: "0.18rem", color: C.muted, fontSize: "0.8rem" }}>
                  {step.commandName ?? "Step"} {step.payload ? "-> executed" : ""}
                </div>
              </div>
              <div style={{ color: step.ok ? C.ok : C.danger, fontSize: "0.78rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                {step.ok ? "OK" : "Failed"}
              </div>
            </div>
            {step.resolvedInputs && Object.keys(step.resolvedInputs).length ? (
              <div style={{ display: "grid", gap: "0.35rem" }}>
                <div style={{ fontSize: "0.76rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Inputs</div>
                <pre style={{ margin: 0, padding: "0.75rem", borderRadius: 10, background: C.panel, color: C.text, fontSize: "0.82rem", lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" }}>
                  {Object.entries(step.resolvedInputs).map(([key, value]) => `${key}: ${stringifyTemplateValue(value)}`).join("\n")}
                </pre>
              </div>
            ) : null}
            {step.payload ? (
              <div style={{ display: "grid", gap: "0.35rem" }}>
                <div style={{ fontSize: "0.76rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Command</div>
                <pre style={{ margin: 0, padding: "0.75rem", borderRadius: 10, background: "#07111e", color: "#d6ecff", fontSize: "0.82rem", lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" }}>
                  {step.payload}
                </pre>
              </div>
            ) : null}
            {step.outputs && Object.keys(step.outputs).length ? (
              <div style={{ display: "grid", gap: "0.35rem" }}>
                <div style={{ fontSize: "0.76rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Parsed Outputs</div>
                <pre style={{ margin: 0, padding: "0.75rem", borderRadius: 10, background: C.panel, color: C.text, fontSize: "0.82rem", lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" }}>
                  {Object.entries(step.outputs).map(([key, value]) => `${key}: ${stringifyTemplateValue(value)}`).join("\n")}
                </pre>
              </div>
            ) : null}
            <div style={{ display: "grid", gap: "0.35rem" }}>
              <div style={{ fontSize: "0.76rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Interpreted Output</div>
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.panel, padding: "0.8rem", overflow: "visible" }}>
                <ExecutionArtifactView output={step.output} artifactMode={step.artifactMode} saveAs={step.saveAs} label={step.commandName ?? step.title} />
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
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
  const dragRef = useRef<{ startX: number; startY: number; startRange: [number, number]; startYRange: [number, number] } | null>(null);
  const plotLeft = 64;
  const plotTop = 12;
  const plotWidth = 916;
  const plotHeight = 320;
  const plotRight = plotLeft + plotWidth;
  const plotBottom = plotTop + plotHeight;
  const baseVoltageSpan = Math.max(result.maxVoltage - result.minVoltage, 1e-6);
  const defaultVoltagePadding = Math.max(baseVoltageSpan * 0.05, result.metadata.voltsPerDiv * 0.1, 1e-6);
  const defaultYMin = result.minVoltage - defaultVoltagePadding;
  const defaultYMax = result.maxVoltage + defaultVoltagePadding;
  const minVerticalSpan = Math.max(baseVoltageSpan / 20, result.metadata.voltsPerDiv / 20, 1e-6);
  const maxVerticalSpan = Math.max(defaultYMax - defaultYMin, minVerticalSpan);

  useEffect(() => {
    const preferred = result.preferredViewport;
    const preferredStartIndex = typeof preferred?.xMinSeconds === "number"
      ? Math.max(0, Math.min(result.sampleCount - 2, Math.round((preferred.xMinSeconds - result.startTimeSeconds) / Math.max(result.intervalSeconds, 1e-18))))
      : 0;
    const preferredEndIndex = typeof preferred?.xMaxSeconds === "number"
      ? Math.max(preferredStartIndex + 2, Math.min(result.sampleCount, Math.round((preferred.xMaxSeconds - result.startTimeSeconds) / Math.max(result.intervalSeconds, 1e-18))))
      : result.sampleCount;
    setVisibleRange([preferredStartIndex, preferredEndIndex]);
    setYRange([defaultYMin, defaultYMax]);
    setHoverIndex(null);
    setCursorMode(false);
    setCursors([]);
    setMathRows([]);
  }, [defaultYMax, defaultYMin, result.channel, result.sampleCount, result.startTimeSeconds, result.endTimeSeconds, result.minVoltage, result.maxVoltage, result.intervalSeconds, result.preferredViewport]);

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
    const x = plotLeft + (((point.timeSeconds - timeStart) / timeSpan) * plotWidth);
    const y = plotBottom - (((point.voltage - yMin) / voltageSpan) * plotHeight);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");

  const xGridLines = Array.from({ length: 11 }, (_, index) => {
    const fraction = index / 10;
    return { x: plotLeft + (plotWidth * fraction), value: timeStart + (timeSpan * fraction) };
  });
  const yGridLines = Array.from({ length: 11 }, (_, index) => {
    const fraction = index / 10;
    return { y: plotBottom - (plotHeight * fraction), value: yMin + (voltageSpan * fraction) };
  });

  const updateHoverFromPoint = (clientX: number, bounds: DOMRect) => {
    const plotClientLeft = bounds.left + ((plotLeft / 1000) * bounds.width);
    const plotClientWidth = (plotWidth / 1000) * bounds.width;
    const fraction = Math.max(0, Math.min(1, (clientX - plotClientLeft) / Math.max(1, plotClientWidth)));
    const [start, end] = clampedRange;
    const index = start + Math.round(fraction * Math.max(0, end - start - 1));
    setHoverIndex(index);
    return index;
  };

  const xWindowSize = clampedRange[1] - clampedRange[0];
  const maxXStart = Math.max(0, result.sampleCount - xWindowSize);
  const yWindowSize = Math.max(yMax - yMin, 1e-9);
  const yCenter = (yMin + yMax) / 2;
  const fullYMin = defaultYMin;
  const fullYMax = defaultYMax;

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
          onWheel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const bounds = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
            if (event.shiftKey) {
              const plotClientTop = bounds.top + ((plotTop / 360) * bounds.height);
              const plotClientHeight = (plotHeight / 360) * bounds.height;
              const nextSpan = Math.max(minVerticalSpan, Math.min(maxVerticalSpan, yWindowSize * (event.deltaY > 0 ? 1.2 : 0.8)));
              const focusFraction = Math.max(0, Math.min(1, 1 - ((event.clientY - plotClientTop) / Math.max(1, plotClientHeight))));
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
            const plotClientLeft = bounds.left + ((plotLeft / 1000) * bounds.width);
            const plotClientWidth = (plotWidth / 1000) * bounds.width;
            const fraction = Math.max(0, Math.min(1, (event.clientX - plotClientLeft) / Math.max(1, plotClientWidth)));
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
            const plotClientWidth = (plotWidth / 1000) * bounds.width;
            const plotClientHeight = (plotHeight / 360) * bounds.height;
            const pixelDeltaX = event.clientX - dragRef.current.startX;
            const pixelDeltaY = event.clientY - dragRef.current.startY;
            const pointsPerPixel = (dragRef.current.startRange[1] - dragRef.current.startRange[0]) / Math.max(1, plotClientWidth);
            const voltsPerPixel = (dragRef.current.startYRange[1] - dragRef.current.startYRange[0]) / Math.max(1, plotClientHeight);
            const pointDelta = Math.round(pixelDeltaX * pointsPerPixel);
            const voltDelta = pixelDeltaY * voltsPerPixel;
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
            let nextYMin = dragRef.current.startYRange[0] + voltDelta;
            let nextYMax = dragRef.current.startYRange[1] + voltDelta;
            const nextYSpan = nextYMax - nextYMin;
            if (nextYMin < fullYMin) {
              nextYMin = fullYMin;
              nextYMax = nextYMin + nextYSpan;
            }
            if (nextYMax > fullYMax) {
              nextYMax = fullYMax;
              nextYMin = nextYMax - nextYSpan;
            }
            setVisibleRange([nextStart, nextEnd]);
            setYRange([nextYMin, nextYMax]);
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
            dragRef.current = { startX: event.clientX, startY: event.clientY, startRange: clampedRange, startYRange: [yMin, yMax] };
            (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
          }}
          onPointerUp={(event) => {
            dragRef.current = null;
            (event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId);
          }}
        >
          <svg viewBox="0 0 1000 360" style={{ display: "block", width: "100%", height: 360, background: "#ffffff", borderRadius: 8, userSelect: "none", WebkitUserSelect: "none" as React.CSSProperties["WebkitUserSelect"] }}>
            <rect x="0" y="0" width="1000" height="360" fill="#ffffff" />
            <rect x={plotLeft} y={plotTop} width={plotWidth} height={plotHeight} fill="#ffffff" stroke="#d9e3ef" strokeWidth="1" />
            {yGridLines.map((line, index) => (
              <g key={`h-${index}`}>
                <line x1={plotLeft} x2={plotRight} y1={line.y} y2={line.y} stroke="#c9d6e4" strokeWidth="1" />
                <text x="6" y={Math.max(plotTop + 10, Math.min(plotBottom, line.y - 4))} fill="#5b6b7f" fontSize="11">{formatEngineeringVoltage(line.value)}</text>
              </g>
            ))}
            {xGridLines.map((line, index) => (
              <g key={`v-${index}`}>
                <line x1={line.x} x2={line.x} y1={plotTop} y2={plotBottom} stroke="#d4deea" strokeWidth="1" />
                <text x={Math.max(plotLeft, Math.min(plotRight - 50, line.x + 4))} y="352" fill="#5b6b7f" fontSize="11">{formatEngineeringTime(line.value)}</text>
              </g>
            ))}
            <polyline fill="none" stroke="#0f766e" strokeWidth="2" points={polylinePoints} />
            {cursorOptions.map((cursor) => {
              const x = plotLeft + (((cursor.point.timeSeconds - timeStart) / timeSpan) * plotWidth);
              const y = plotBottom - (((cursor.point.voltage - yMin) / voltageSpan) * plotHeight);
              return (
                <g key={cursor.id}>
                  <line x1={x} x2={x} y1={plotTop} y2={plotBottom} stroke={cursor.color} strokeDasharray="8 6" strokeWidth="2" />
                  <line x1={plotLeft} x2={plotRight} y1={y} y2={y} stroke={cursor.color} strokeDasharray="8 6" strokeWidth="2" opacity="0.9" />
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
                <line x1={plotLeft + (((hoverPoint.timeSeconds - timeStart) / timeSpan) * plotWidth)} x2={plotLeft + (((hoverPoint.timeSeconds - timeStart) / timeSpan) * plotWidth)} y1={plotTop} y2={plotBottom} stroke="#fb7185" strokeDasharray="6 6" />
                <circle cx={plotLeft + (((hoverPoint.timeSeconds - timeStart) / timeSpan) * plotWidth)} cy={plotBottom - (((hoverPoint.voltage - yMin) / voltageSpan) * plotHeight)} r="4" fill="#fb7185" />
              </>
            ) : null}
          </svg>
        </div>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", paddingBlock: "1rem" }}>
          <input
            type="range"
            min={minVerticalSpan}
            max={maxVerticalSpan}
            step={Math.max((maxVerticalSpan - minVerticalSpan) / 250, 1e-9)}
            value={Math.max(minVerticalSpan, Math.min(maxVerticalSpan, yWindowSize))}
            onChange={(event) => {
              const nextSpan = Number(event.target.value);
              let nextMin = yCenter - (nextSpan / 2);
              let nextMax = yCenter + (nextSpan / 2);
              if (nextMin < fullYMin) {
                nextMin = fullYMin;
                nextMax = nextMin + nextSpan;
              }
              if (nextMax > fullYMax) {
                nextMax = fullYMax;
                nextMin = nextMax - nextSpan;
              }
              setYRange([nextMin, nextMax]);
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

function buildTcpExecutionParams(target: { host: string; port: number }, command: Pick<EquipmentCommand, "payload" | "parser" | "artifactMode" | "timeoutMs">, payloadOverride?: string): Record<string, unknown> {
  const isBinaryArtifact = command.artifactMode === "image" || command.artifactMode === "binary" || command.parser === "binary";
  return {
    host: target.host,
    port: target.port,
    command: payloadOverride ?? command.payload,
    readMode: isBinaryArtifact ? "until-timeout" : "once",
    timeoutMs: command.timeoutMs || (isBinaryArtifact ? 15000 : 5000),
    quietMs: isBinaryArtifact ? 1000 : 250,
    encoding: isBinaryArtifact ? "base64" : "utf8",
  };
}

function resolveCommandInputValues(command: EquipmentCommand, overrides?: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const def of command.inputDefs) {
    const override = overrides?.[def.name];
    values[def.name] = typeof override === "undefined" ? (command.testValues?.[def.name] ?? def.defaultValue ?? "") : override;
  }
  return values;
}

function listMissingCommandInputs(command: EquipmentCommand, values: Record<string, unknown>): string[] {
  return command.inputDefs
    .filter((def) => def.required && !String(values[def.name] ?? "").trim())
    .map((def) => def.name);
}

function buildStepOutputOptions(script: EquipmentScript, commands: EquipmentCommand[], selectedStepId?: string | null): Array<{ stepId: string; stepTitle: string; outputName: string; label: string }> {
  const selectedIndex = selectedStepId ? script.steps.findIndex((step) => step.id === selectedStepId) : script.steps.length;
  return script.steps
    .slice(0, selectedIndex < 0 ? script.steps.length : selectedIndex)
    .flatMap((step) => {
      const command = resolveCommandForStep(step, commands);
      return (command?.outputDefs ?? []).map((outputDef) => ({
        stepId: step.id,
        stepTitle: step.title,
        outputName: outputDef.name,
        label: `${step.title} -> ${outputDef.name}`,
      }));
    });
}

function validateScript(script: EquipmentScript, devices: EquipmentDevice[]): string[] {
  const issues: string[] = [];
  const device = devices.find((candidate) => candidate.id === script.deviceId);
  const commands = device?.commands ?? devices.flatMap((entry) => entry.commands);
  const stepIndex = new Map(script.steps.map((step, index) => [step.id, index]));
  for (const step of script.steps) {
    const command = resolveCommandForStep(step, commands);
    if (!command && (step.type === "command" || step.type === "capture")) {
      issues.push(`${step.title}: command reference is missing.`);
      continue;
    }
    if (!command) continue;
    for (const inputDef of command.inputDefs) {
      const binding = step.inputBindings.find((entry) => entry.inputName === inputDef.name);
      if (!binding) {
        if (inputDef.required && !String(command.testValues?.[inputDef.name] ?? inputDef.defaultValue ?? "").trim()) {
          issues.push(`${step.title}: required input "${inputDef.name}" is not bound.`);
        }
        continue;
      }
      if (binding.source === "step-output") {
        if (!binding.sourceStepId || !binding.sourceOutputName) {
          issues.push(`${step.title}: input "${inputDef.name}" has an incomplete step-output reference.`);
          continue;
        }
        const sourceIndex = stepIndex.get(binding.sourceStepId);
        const currentIndex = stepIndex.get(step.id) ?? 0;
        if (typeof sourceIndex !== "number") {
          issues.push(`${step.title}: input "${inputDef.name}" references a missing step.`);
          continue;
        }
        if (sourceIndex >= currentIndex) {
          issues.push(`${step.title}: input "${inputDef.name}" references a step that executes later.`);
        }
      } else if (inputDef.required && !String(binding.literalValue ?? "").trim()) {
        issues.push(`${step.title}: input "${inputDef.name}" is empty.`);
      }
    }
    for (const outputDef of command.outputDefs) {
      if (!outputDef.name.trim()) issues.push(`${step.title}: an output is missing its name.`);
      if (!outputDef.selector.trim()) issues.push(`${step.title}: output "${outputDef.name || "(unnamed)"}" is missing its selector.`);
      if (outputDef.source === "regex") {
        try {
          void new RegExp(outputDef.selector, "m");
        } catch {
          issues.push(`${step.title}: output "${outputDef.name || "(unnamed)"}" has an invalid regex.`);
        }
      }
    }
  }
  return issues;
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
  const [commandExecutions, setCommandExecutions] = useState<Record<string, ExecutionResult>>({});
  const [scriptExecutions, setScriptExecutions] = useState<Record<string, ExecutionResult>>({});
  const [deviceProfileOpen, setDeviceProfileOpen] = useState(false);
  const [deviceChooserOpen, setDeviceChooserOpen] = useState(false);

  const selectedDevice = state.devices.find((device) => device.id === selectedDeviceId) ?? state.devices[0] ?? null;
  const selectedScript = state.scripts.find((script) => script.id === selectedScriptId) ?? state.scripts[0] ?? null;
  const selectedCommand = selectedDevice?.commands.find((command) => command.id === selectedCommandId) ?? selectedDevice?.commands[0] ?? null;
  const selectedStep = selectedScript?.steps.find((step) => step.id === selectedStepId) ?? selectedScript?.steps[0] ?? null;
  const selectedDeviceCommandEntries = useMemo(() => selectedDevice ? buildCommandListEntries(selectedDevice.commands) : [], [selectedDevice]);
  const selectedScriptCommandGroups = useMemo(() => {
    if (!selectedScript) return [];
    const commands = selectedScript.deviceId
      ? state.devices.find((device) => device.id === selectedScript.deviceId)?.commands ?? []
      : state.devices.flatMap((device) => device.commands.map((command) => ({ ...command, name: `${device.name} / ${command.name}` })));
    return buildCommandSelectGroups(commands);
  }, [selectedScript, state.devices]);
  const currentCommandExecution = selectedCommand ? commandExecutions[selectedCommand.id] ?? null : null;
  const currentScriptExecution = selectedScript ? scriptExecutions[selectedScript.id] ?? null : null;
  const selectedCommandInputValues = selectedCommand ? resolveCommandInputValues(selectedCommand) : {};
  const selectedCommandPreviewPayload = selectedCommand ? applyTemplate(selectedCommand.payload, selectedCommandInputValues) : "";
  const selectedStepCommand = selectedScript && selectedStep
    ? resolveCommandForStep(
      selectedStep,
      selectedScript.deviceId
        ? (state.devices.find((device) => device.id === selectedScript.deviceId)?.commands ?? [])
        : state.devices.flatMap((device) => device.commands),
    ) ?? null
    : null;
  const selectedStepOutputOptions = selectedScript
    ? buildStepOutputOptions(selectedScript, selectedScript.deviceId
      ? (state.devices.find((device) => device.id === selectedScript.deviceId)?.commands ?? [])
      : state.devices.flatMap((device) => device.commands), selectedStep?.id)
    : [];
  const activeBridge = bridgeUrl.trim() ? { url: bridgeUrl.trim(), token: bridgeToken.trim() || undefined } : null;
  const knownDevicePresets = useMemo<KnownDevicePreset[]>(() => [
    {
      id: "siglent-sds1202x-e",
      name: "Siglent SDS1202X-E",
      description: "SCPI over TCP with known starter queries and screenshot capture.",
      create: () => normalizeDevice(createDefaultState().devices[0], 0),
      createScripts: (device) => createKnownSiglentPreset(device.id, device.address).scripts,
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

  const executeSiglentWaveformCommand = useCallback(async (target: { host: string; port: number }, command: EquipmentCommand, inputValues?: Record<string, unknown>): Promise<SiglentWaveformResult> => {
    if (!activeBridge) throw new Error("Bridge URL is required before executing device commands.");
    const waveformPayload = applyTemplate(command.payload, {
      ...(inputValues ?? {}),
      channel: String(inputValues?.["channel"] ?? parseSiglentWaveformChannel(command.payload)),
    });
    const channel = parseSiglentWaveformChannel(waveformPayload);
    const [voltsPerDivResponse, offsetResponse, timeDivResponse, triggerDelayResponse, sampleRateResponse] = await Promise.all([
      fetchTcpText(activeBridge, target, `${channel}:VDIV?`),
      fetchTcpText(activeBridge, target, `${channel}:OFST?`),
      fetchTcpText(activeBridge, target, "TDIV?"),
      fetchTcpText(activeBridge, target, "TRDL?"),
      fetchTcpText(activeBridge, target, "SARA?"),
    ]);
    const sourcePointCount = Math.max(1, Math.round(parseScpiNumber(timeDivResponse) * 14 * parseScpiNumber(sampleRateResponse)));
    const computedSparsing = Math.max(1, Math.floor((sourcePointCount - 1) / Math.max(1, SIGLENT_WAVEFORM_POINT_LIMIT - 1)));
    const sparsingCandidates = Array.from(new Set([
      Math.max(1, computedSparsing - 1),
      computedSparsing,
      Math.max(1, computedSparsing + 1),
      1,
    ]));
    let result: SiglentWaveformResult | null = null;
    let waveformSetup = `WFSU SP,${computedSparsing},NP,${SIGLENT_WAVEFORM_POINT_LIMIT},FP,0`;
    let lastWaveformError: Error | null = null;
    for (const sparsing of sparsingCandidates) {
      waveformSetup = `WFSU SP,${sparsing},NP,${SIGLENT_WAVEFORM_POINT_LIMIT},FP,0`;
      await callBridge<unknown>(activeBridge, "execute_tcp_command", {
        host: target.host,
        port: target.port,
        command: waveformSetup,
        readMode: "none",
        timeoutMs: 1500,
      });

      const [descriptor, waveform] = await Promise.all([
        callBridge<TcpCommandResult>(activeBridge, "execute_tcp_command", {
          host: target.host,
          port: target.port,
          command: `${channel}:WF? DESC`,
          readMode: "until-timeout",
          timeoutMs: 8000,
          quietMs: 1500,
          encoding: "base64",
        }),
        callBridge<TcpCommandResult>(activeBridge, "execute_tcp_command", {
          host: target.host,
          port: target.port,
          command: waveformPayload,
          readMode: "until-timeout",
          timeoutMs: command.timeoutMs || 15000,
          quietMs: 1500,
          encoding: "base64",
        }),
      ]);
      try {
        result = buildSiglentWaveformResult({
          channel,
          waveform,
          descriptor,
          voltsPerDivResponse,
          offsetResponse,
          timeDivResponse,
          triggerDelayResponse,
          sampleRateResponse,
        });
        break;
      } catch (error) {
        lastWaveformError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (!result) {
      throw lastWaveformError ?? new Error("Unable to capture a valid waveform block from the scope.");
    }
    const centerTimeSeconds = parseOptionalNumber(inputValues?.["centerTimeSeconds"]);
    const timePerDivSeconds = parseOptionalNumber(inputValues?.["timePerDivSeconds"]);
    const centerVolts = parseOptionalNumber(inputValues?.["centerVolts"]);
    const scopeOffsetVolts = parseOptionalNumber(inputValues?.["scopeOffsetVolts"]);
    const voltsPerDiv = parseOptionalNumber(inputValues?.["voltsPerDiv"]);
    const horizontalHalfSpan = typeof timePerDivSeconds === "number" ? (timePerDivSeconds * result.metadata.grid / 2) : undefined;
    const verticalHalfSpan = typeof voltsPerDiv === "number" ? (voltsPerDiv * result.metadata.grid / 2) : undefined;
    const resolvedCenterVolts = typeof centerVolts === "number"
      ? centerVolts
      : (typeof scopeOffsetVolts === "number" ? -scopeOffsetVolts : undefined);
    const preferredViewport = {
      xMinSeconds: typeof centerTimeSeconds === "number" && typeof horizontalHalfSpan === "number" ? centerTimeSeconds - horizontalHalfSpan : undefined,
      xMaxSeconds: typeof centerTimeSeconds === "number" && typeof horizontalHalfSpan === "number" ? centerTimeSeconds + horizontalHalfSpan : undefined,
      yMinVolts: typeof resolvedCenterVolts === "number" && typeof verticalHalfSpan === "number" ? resolvedCenterVolts - verticalHalfSpan : undefined,
      yMaxVolts: typeof resolvedCenterVolts === "number" && typeof verticalHalfSpan === "number" ? resolvedCenterVolts + verticalHalfSpan : undefined,
    };
    if (Object.values(preferredViewport).some((value) => typeof value === "number")) {
      result.preferredViewport = preferredViewport;
    }
    result.transport.setupCommand = waveformSetup;
    return result;
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
    try {
      const inputValues = resolveCommandInputValues(command);
      const missingInputs = listMissingCommandInputs(command, inputValues);
      if (missingInputs.length) {
        throw new Error(`Missing required inputs: ${missingInputs.join(", ")}`);
      }
      const payload = applyTemplate(command.payload, inputValues);
      const output = command.parser === "siglent-waveform"
        ? await executeSiglentWaveformCommand(target, command, inputValues)
        : await callBridge<unknown>(activeBridge, "execute_tcp_command", buildTcpExecutionParams(target, command, payload));
      const result: ExecutionResult = {
        scope: "command",
        title: `${device.name} · ${command.name}`,
        startedAt: new Date().toISOString(),
        commandId: command.id,
        outputs: extractCommandOutputs(command, output),
        output,
      };
      setExecutionResult(result);
      setCommandExecutions((current) => ({ ...current, [command.id]: result }));
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
    const stepResults: NonNullable<ExecutionResult["steps"]> = [];
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

        const ref = resolveCommandForStep(step, device.commands);
        const payload = step.rawCommand ?? ref?.payload ?? "";
        if (!payload.trim()) {
          throw new Error(`Step "${step.title}" does not have a command payload.`);
        }

        const timeoutMs = ref?.timeoutMs ?? 5000;
        const output = await callBridge<unknown>(activeBridge, "execute_tcp_command", buildTcpExecutionParams(target, {
          payload,
          parser: ref?.parser ?? "text",
          timeoutMs,
          artifactMode: ref?.artifactMode ?? (step.type === "capture" ? "image" : "text"),
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

  const runScriptBound = useCallback(async (script: EquipmentScript) => {
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
    const stepResults: NonNullable<ExecutionResult["steps"]> = [];
    const stepOutputContext = new Map<string, Record<string, unknown>>();
    try {
      for (const step of script.steps) {
        if (step.type === "wait") {
          await new Promise((resolve) => window.setTimeout(resolve, step.waitMs ?? 1000));
          stepResults.push({ stepId: step.id, title: step.title, ok: true, output: { waitedMs: step.waitMs ?? 1000 } });
          continue;
        }
        if (step.type === "note") {
          stepResults.push({ stepId: step.id, title: step.title, ok: true, output: { notes: step.notes ?? "" } });
          continue;
        }

        const ref = resolveCommandForStep(step, device.commands);
        const baseCommand: EquipmentCommand = ref ?? {
          id: step.id,
          name: step.title,
          mode: "raw",
          payload: step.rawCommand ?? "",
          parser: "text",
          timeoutMs: 5000,
          saveAs: step.saveAs,
          artifactMode: step.type === "capture" ? "image" : "text",
          notes: step.notes,
          inputDefs: [],
          outputDefs: [],
          testValues: {},
        };
        const resolvedInputs: Record<string, unknown> = {};
        for (const inputDef of baseCommand.inputDefs) {
          const binding = step.inputBindings.find((entry) => entry.inputName === inputDef.name);
          if (binding?.source === "step-output") {
            resolvedInputs[inputDef.name] = stepOutputContext.get(binding.sourceStepId ?? "")?.[binding.sourceOutputName ?? ""];
          } else if (binding?.source === "literal") {
            resolvedInputs[inputDef.name] = binding.literalValue ?? "";
          } else {
            resolvedInputs[inputDef.name] = baseCommand.testValues?.[inputDef.name] ?? inputDef.defaultValue ?? "";
          }
        }
        const missingInputs = listMissingCommandInputs(baseCommand, resolvedInputs);
        if (missingInputs.length) {
          throw new Error(`Step "${step.title}" is missing required inputs: ${missingInputs.join(", ")}`);
        }

        const payload = applyTemplate(step.rawCommand ?? baseCommand.payload ?? "", resolvedInputs);
        if (!payload.trim()) {
          throw new Error(`Step "${step.title}" does not have a command payload.`);
        }

        const resolvedCommand: EquipmentCommand = {
          ...baseCommand,
          payload,
          saveAs: step.saveAs ?? baseCommand.saveAs,
        };
        const output = resolvedCommand.parser === "siglent-waveform"
          ? await executeSiglentWaveformCommand(target, resolvedCommand, resolvedInputs)
          : await callBridge<unknown>(activeBridge, "execute_tcp_command", buildTcpExecutionParams(target, resolvedCommand, payload));
        const outputs = extractCommandOutputs(resolvedCommand, output);
        stepOutputContext.set(step.id, outputs);
        stepResults.push({
          stepId: step.id,
          title: step.title,
          ok: true,
          output,
          outputs,
          commandName: baseCommand.name,
          artifactMode: resolvedCommand.artifactMode,
          parser: resolvedCommand.parser,
          payload,
          resolvedInputs,
          notes: step.notes ?? baseCommand.notes,
          saveAs: resolvedCommand.saveAs,
        });
      }

      const result: ExecutionResult = {
        scope: "script",
        title: `${device.name} · ${script.name}`,
        startedAt: new Date().toISOString(),
        scriptId: script.id,
        steps: stepResults,
      };
      setExecutionResult(result);
      setScriptExecutions((current) => ({ ...current, [script.id]: result }));
      setMessage(`Executed script ${script.name}`);
    } catch (executionError: unknown) {
      stepResults.push({ title: "Execution halted", ok: false, output: { error: (executionError as Error).message } });
      const result: ExecutionResult = {
        scope: "script",
        title: `${device.name} · ${script.name}`,
        startedAt: new Date().toISOString(),
        scriptId: script.id,
        steps: stepResults,
      };
      setExecutionResult(result);
      setScriptExecutions((current) => ({ ...current, [script.id]: result }));
      setError((executionError as Error).message);
    } finally {
      setExecuting(false);
    }
  }, [activeBridge, executeSiglentWaveformCommand, state.devices]);

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
                            inputDefs: [],
                            outputDefs: [],
                            testValues: {},
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
                      <div style={{ marginTop: "0.9rem", display: "grid", gridTemplateColumns: "260px minmax(0, 1fr)", gap: "1rem", minHeight: 520 }}>
                      <div style={{ minHeight: 0, overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 12, background: C.panel2, padding: "0.55rem", display: "grid", gap: "0.45rem" }}>
                        {selectedDeviceCommandEntries.map((entry) => {
                          if (entry.kind === "category") {
                            return (
                              <div
                                key={entry.key}
                                style={{
                                  padding: `0.2rem 0.35rem 0.15rem ${0.35 + (entry.depth * 0.75)}rem`,
                                  color: C.accent,
                                  fontSize: "0.72rem",
                                  fontWeight: 800,
                                  letterSpacing: "0.08em",
                                  textTransform: "uppercase",
                                }}
                              >
                                {entry.label}
                              </div>
                            );
                          }
                          const command = entry.command;
                          const active = command.id === selectedCommand?.id;
                          return (
                            <button
                              key={entry.key}
                              onClick={() => setSelectedCommandId(command.id)}
                              style={{
                                textAlign: "left",
                                border: `1px solid ${active ? C.accent : C.border}`,
                                background: active ? C.accentSoft : C.panel,
                                color: C.text,
                                borderRadius: 10,
                                padding: "0.38rem 0.5rem",
                                marginLeft: `${entry.depth * 0.6}rem`,
                                cursor: "pointer",
                              }}
                            >
                              <div style={{ fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1.15 }}>{command.name}</div>
                              <div style={{ marginTop: "0.14rem", color: C.muted, fontSize: "0.72rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
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
                                  {selectedCommand.builtIn ? (
                                    <>
                                      <button
                                        onClick={() => {
                                          const copy: EquipmentCommand = { ...selectedCommand, id: makeId("command"), builtIn: false, name: `${selectedCommand.name} Copy` };
                                          const next = {
                                            ...state,
                                            devices: state.devices.map((device) => device.id === selectedDevice.id ? { ...device, commands: [...device.commands, copy] } : device),
                                          };
                                          setState(next);
                                          setSelectedCommandId(copy.id);
                                          void persistState(next, "Command duplicated");
                                        }}
                                        style={buttonStyle()}
                                      >
                                        Duplicate
                                      </button>
                                      <button
                                        onClick={() => {
                                          const preset = createKnownSiglentPreset(selectedDevice.id, selectedDevice.address);
                                          const next = {
                                            ...state,
                                            devices: state.devices.map((device) => device.id === selectedDevice.id ? preset.device : device),
                                            scripts: [...state.scripts.filter((script) => !(script.builtIn && script.deviceId === selectedDevice.id)), ...preset.scripts],
                                          };
                                          setState(next);
                                          void persistState(next, "Known Siglent preset restored");
                                        }}
                                        style={buttonStyle()}
                                      >
                                        Restore Known
                                      </button>
                                    </>
                                  ) : null}
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
                                    disabled={selectedCommand.builtIn}
                                  >
                                    Delete
                                  </button>
                                </div>
                              </div>
                              {selectedCommand.builtIn ? (
                                <div style={{ marginTop: "0.55rem", color: C.muted, fontSize: "0.82rem" }}>
                                  Built-in command. Duplicate it if you want an editable copy, or use Restore Known to recover the preset set.
                                </div>
                              ) : null}
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
                                <label style={labelStyle()}>
                                  Category Path
                                  <input value={selectedCommand.categoryPath ?? ""} onChange={(event) => setState((current) => ({ ...current, devices: current.devices.map((device) => device.id === selectedDevice.id ? { ...device, commands: device.commands.map((item) => item.id === selectedCommand.id ? { ...item, categoryPath: event.target.value || undefined } : item) } : device) }))} onBlur={() => void persistState(state, "Command updated")} placeholder="Trigger / Read" style={inputStyle()} />
                                </label>
                              </div>
                              <label style={{ ...labelStyle(), marginTop: "0.8rem" }}>
                                Payload
                                <textarea value={selectedCommand.payload} onChange={(event) => setState((current) => ({ ...current, devices: current.devices.map((device) => device.id === selectedDevice.id ? { ...device, commands: device.commands.map((item) => item.id === selectedCommand.id ? { ...item, payload: event.target.value } : item) } : device) }))} onBlur={() => void persistState(state, "Command updated")} rows={4} style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.6, fontFamily: "Consolas, monospace" }} />
                              </label>
                              <section style={{ ...cardStyle(), marginTop: "0.9rem", padding: "0.85rem" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                                  <div>
                                    <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Inputs</div>
                                    <div style={{ marginTop: "0.2rem", color: C.muted, fontSize: "0.82rem" }}>Define named variables that can be referenced in the payload with <code>{"{{name}}"}</code>.</div>
                                  </div>
                                  <button
                                    onClick={() => {
                                      const next = cloneStateWithCommand(state, selectedDevice.id, selectedCommand.id, (command) => ({
                                        ...command,
                                        inputDefs: [...command.inputDefs, { id: makeId("input"), name: `input${command.inputDefs.length + 1}`, required: true }],
                                      }));
                                      setState(next);
                                      void persistState(next, "Command updated");
                                    }}
                                    style={buttonStyle("primary")}
                                  >
                                    Add Input
                                  </button>
                                </div>
                                <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.65rem" }}>
                                  {selectedCommand.inputDefs.length ? selectedCommand.inputDefs.map((inputDef) => (
                                    <div key={inputDef.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: "0.7rem", background: C.panel }}>
                                      <div style={{ display: "grid", gridTemplateColumns: "minmax(140px, 1fr) 110px minmax(140px, 1fr) minmax(160px, 1fr) auto", gap: "0.6rem", alignItems: "end" }}>
                                        <label style={labelStyle()}>
                                          Name
                                          <input value={inputDef.name} onChange={(event) => setState((current) => cloneStateWithCommand(current, selectedDevice.id, selectedCommand.id, (command) => ({ ...command, inputDefs: command.inputDefs.map((entry) => entry.id === inputDef.id ? { ...entry, name: event.target.value } : entry) })))} onBlur={() => void persistState(state, "Command updated")} style={inputStyle()} />
                                        </label>
                                        <label style={labelStyle()}>
                                          Required
                                          <select value={inputDef.required ? "yes" : "no"} onChange={(event) => {
                                            const next = cloneStateWithCommand(state, selectedDevice.id, selectedCommand.id, (command) => ({ ...command, inputDefs: command.inputDefs.map((entry) => entry.id === inputDef.id ? { ...entry, required: event.target.value === "yes" } : entry) }));
                                            setState(next);
                                            void persistState(next, "Command updated");
                                          }} style={inputStyle()}>
                                            <option value="yes">Yes</option>
                                            <option value="no">No</option>
                                          </select>
                                        </label>
                                        <label style={labelStyle()}>
                                          Default
                                          {commandInputValueControl({
                                            inputDef,
                                            value: inputDef.defaultValue ?? "",
                                            onChange: (value) => setState((current) => cloneStateWithCommand(current, selectedDevice.id, selectedCommand.id, (command) => ({ ...command, inputDefs: command.inputDefs.map((entry) => entry.id === inputDef.id ? { ...entry, defaultValue: value || undefined } : entry) }))),
                                            onBlur: () => void persistState(state, "Command updated"),
                                          })}
                                        </label>
                                        <label style={labelStyle()}>
                                          Options
                                          <input
                                            value={(inputDef.options ?? []).join(", ")}
                                            placeholder="AUTO, NORM, SINGLE"
                                            onChange={(event) => {
                                              const options = event.target.value.split(",").map((option) => option.trim()).filter(Boolean);
                                              setState((current) => cloneStateWithCommand(current, selectedDevice.id, selectedCommand.id, (command) => ({
                                                ...command,
                                                inputDefs: command.inputDefs.map((entry) => entry.id === inputDef.id ? { ...entry, options: options.length ? options : undefined } : entry),
                                              })));
                                            }}
                                            onBlur={() => void persistState(state, "Command updated")}
                                            style={inputStyle()}
                                          />
                                        </label>
                                        <button
                                          onClick={() => {
                                            const next = cloneStateWithCommand(state, selectedDevice.id, selectedCommand.id, (command) => ({ ...command, inputDefs: command.inputDefs.filter((entry) => entry.id !== inputDef.id) }));
                                            setState(next);
                                            void persistState(next, "Command updated");
                                          }}
                                          style={buttonStyle("danger")}
                                        >
                                          Remove
                                        </button>
                                      </div>
                                    </div>
                                  )) : (
                                    <div style={{ color: C.muted, fontSize: "0.84rem" }}>No command inputs defined.</div>
                                  )}
                                </div>
                              </section>
                              <section style={{ ...cardStyle(), marginTop: "0.9rem", padding: "0.85rem", display: "none" }}>
                                <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Try It</div>
                                <div style={{ marginTop: "0.2rem", color: C.muted, fontSize: "0.82rem" }}>Provide test values for the command inputs and preview the rendered payload.</div>
                                <div style={{ marginTop: "0.75rem", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "0.65rem" }}>
                                  {selectedCommand.inputDefs.map((inputDef) => (
                                    <label key={`try-${inputDef.id}`} style={labelStyle()}>
                                      {inputDef.name}
                                      {commandInputValueControl({
                                        inputDef,
                                        value: selectedCommand.testValues?.[inputDef.name] ?? "",
                                        onChange: (value) => setState((current) => cloneStateWithCommand(current, selectedDevice.id, selectedCommand.id, (command) => ({ ...command, testValues: { ...(command.testValues ?? {}), [inputDef.name]: value } }))),
                                        onBlur: () => void persistState(state, "Command updated"),
                                      })}
                                    </label>
                                  ))}
                                </div>
                                <label style={{ ...labelStyle(), marginTop: "0.75rem" }}>
                                  Rendered Payload
                                  <textarea value={selectedCommandPreviewPayload} readOnly rows={3} style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.6, fontFamily: "Consolas, monospace", opacity: 0.92 }} />
                                </label>
                              </section>
                              <section style={{ ...cardStyle(), marginTop: "0.9rem", padding: "0.85rem" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                                  <div>
                                    <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Outputs</div>
                                    <div style={{ marginTop: "0.2rem", color: C.muted, fontSize: "0.82rem" }}>Expose named values from the response for later script steps.</div>
                                  </div>
                                  <button
                                    onClick={() => {
                                      const next = cloneStateWithCommand(state, selectedDevice.id, selectedCommand.id, (command) => ({
                                        ...command,
                                        outputDefs: [...command.outputDefs, { id: makeId("output"), name: `output${command.outputDefs.length + 1}`, source: "json-path", selector: "" }],
                                      }));
                                      setState(next);
                                      void persistState(next, "Command updated");
                                    }}
                                    style={buttonStyle("primary")}
                                  >
                                    Add Output
                                  </button>
                                </div>
                                <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.65rem" }}>
                                  {selectedCommand.outputDefs.length ? selectedCommand.outputDefs.map((outputDef) => (
                                    <div key={outputDef.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: "0.7rem", background: C.panel }}>
                                      <div style={{ display: "grid", gridTemplateColumns: "minmax(140px, 1fr) 130px minmax(180px, 1fr) auto", gap: "0.6rem", alignItems: "end" }}>
                                        <label style={labelStyle()}>
                                          Name
                                          <input value={outputDef.name} onChange={(event) => setState((current) => cloneStateWithCommand(current, selectedDevice.id, selectedCommand.id, (command) => ({ ...command, outputDefs: command.outputDefs.map((entry) => entry.id === outputDef.id ? { ...entry, name: event.target.value } : entry) })))} onBlur={() => void persistState(state, "Command updated")} style={inputStyle()} />
                                        </label>
                                        <label style={labelStyle()}>
                                          Source
                                          <select value={outputDef.source} onChange={(event) => {
                                            const next = cloneStateWithCommand(state, selectedDevice.id, selectedCommand.id, (command) => ({ ...command, outputDefs: command.outputDefs.map((entry) => entry.id === outputDef.id ? { ...entry, source: event.target.value as CommandOutputSource } : entry) }));
                                            setState(next);
                                            void persistState(next, "Command updated");
                                          }} style={inputStyle()}>
                                            <option value="json-path">json-path</option>
                                            <option value="regex">regex</option>
                                          </select>
                                        </label>
                                        <label style={labelStyle()}>
                                          {outputDef.source === "regex" ? "Pattern" : "Selector"}
                                          <input value={outputDef.selector} onChange={(event) => setState((current) => cloneStateWithCommand(current, selectedDevice.id, selectedCommand.id, (command) => ({ ...command, outputDefs: command.outputDefs.map((entry) => entry.id === outputDef.id ? { ...entry, selector: event.target.value } : entry) })))} onBlur={() => void persistState(state, "Command updated")} style={inputStyle()} />
                                        </label>
                                        <button
                                          onClick={() => {
                                            const next = cloneStateWithCommand(state, selectedDevice.id, selectedCommand.id, (command) => ({ ...command, outputDefs: command.outputDefs.filter((entry) => entry.id !== outputDef.id) }));
                                            setState(next);
                                            void persistState(next, "Command updated");
                                          }}
                                          style={buttonStyle("danger")}
                                        >
                                          Remove
                                        </button>
                                      </div>
                                    </div>
                                  )) : (
                                    <div style={{ color: C.muted, fontSize: "0.84rem" }}>No command outputs defined.</div>
                                  )}
                                </div>
                              </section>
                              <section style={{ ...cardStyle(), marginTop: "0.9rem", padding: "0.85rem" }}>
                                <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Try It</div>
                                <div style={{ marginTop: "0.2rem", color: C.muted, fontSize: "0.82rem" }}>Provide test values for the command inputs and preview the rendered payload.</div>
                                <div style={{ marginTop: "0.75rem", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "0.65rem" }}>
                                  {selectedCommand.inputDefs.map((inputDef) => (
                                    <label key={`try-bottom-${inputDef.id}`} style={labelStyle()}>
                                      {inputDef.name}
                                      {commandInputValueControl({
                                        inputDef,
                                        value: selectedCommand.testValues?.[inputDef.name] ?? "",
                                        onChange: (value) => setState((current) => cloneStateWithCommand(current, selectedDevice.id, selectedCommand.id, (command) => ({ ...command, testValues: { ...(command.testValues ?? {}), [inputDef.name]: value } }))),
                                        onBlur: () => void persistState(state, "Command updated"),
                                      })}
                                    </label>
                                  ))}
                                </div>
                                <label style={{ ...labelStyle(), marginTop: "0.75rem" }}>
                                  Rendered Payload
                                  <textarea value={selectedCommandPreviewPayload} readOnly rows={3} style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.6, fontFamily: "Consolas, monospace", opacity: 0.92 }} />
                                </label>
                                <div style={{ marginTop: "0.75rem", display: "flex", justifyContent: "flex-end" }}>
                                  <button onClick={() => void runDeviceCommand(selectedDevice, selectedCommand)} style={buttonStyle("primary")} disabled={executing}>
                                    {executing ? "Running..." : "Run"}
                                  </button>
                                </div>
                              </section>
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
                                <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Parsed Outputs</div>
                                <div style={{ marginTop: "0.85rem", border: `1px solid ${C.border}`, borderRadius: 12, background: C.panel, padding: "0.9rem", minWidth: 0 }}>
                                  <pre style={{ margin: 0, color: C.text, fontSize: "0.84rem", lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" }}>
                                    {currentCommandExecution?.outputs && Object.keys(currentCommandExecution.outputs).length
                                      ? Object.entries(currentCommandExecution.outputs).map(([key, value]) => `${key}: ${stringifyTemplateValue(value)}`).join("\n")
                                      : "Run the selected command to see parsed key/value outputs here."}
                                  </pre>
                                </div>
                              </section>
                              <section style={cardStyle()}>
                                <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Interpreted Output</div>
                                <div style={{ marginTop: "0.85rem", border: `1px solid ${C.border}`, borderRadius: 12, background: C.panel2, padding: "0.9rem", overflow: "visible", minWidth: 0, height: "auto" }}>
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
                        <button
                          onClick={() => {
                            const issues = validateScript(selectedScript, state.devices);
                            if (issues.length) {
                              setError(issues.join(" "));
                              return;
                            }
                            void runScriptBound(selectedScript);
                          }}
                          style={buttonStyle("primary")}
                          disabled={executing}
                        >
                          {executing ? "Running..." : "Run Script"}
                        </button>
                        <button
                          onClick={() => {
                            const issues = validateScript(selectedScript, state.devices);
                            if (issues.length) setError(issues.join(" "));
                            else {
                              setError("");
                              setMessage("Script validation passed");
                            }
                          }}
                          style={buttonStyle()}
                        >
                          Validate
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
                    {currentScriptExecution ? <ScriptExecutionTimeline result={currentScriptExecution} /> : null}
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
                            inputBindings: [],
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
                              <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
                                <button
                                  onClick={() => {
                                    const currentIndex = selectedScript.steps.findIndex((entry) => entry.id === selectedStep.id);
                                    if (currentIndex <= 0) return;
                                    const reordered = [...selectedScript.steps];
                                    const [moved] = reordered.splice(currentIndex, 1);
                                    reordered.splice(currentIndex - 1, 0, moved!);
                                    const next = cloneStateWithScript(state, selectedScript.id, (script) => ({ ...script, steps: reordered }));
                                    setState(next);
                                    void persistState(next, "Step updated");
                                  }}
                                  style={buttonStyle()}
                                >
                                  Move Up
                                </button>
                                <button
                                  onClick={() => {
                                    const currentIndex = selectedScript.steps.findIndex((entry) => entry.id === selectedStep.id);
                                    if (currentIndex < 0 || currentIndex >= selectedScript.steps.length - 1) return;
                                    const reordered = [...selectedScript.steps];
                                    const [moved] = reordered.splice(currentIndex, 1);
                                    reordered.splice(currentIndex + 1, 0, moved!);
                                    const next = cloneStateWithScript(state, selectedScript.id, (script) => ({ ...script, steps: reordered }));
                                    setState(next);
                                    void persistState(next, "Step updated");
                                  }}
                                  style={buttonStyle()}
                                >
                                  Move Down
                                </button>
                                <button
                                  onClick={() => {
                                    const currentIndex = selectedScript.steps.findIndex((entry) => entry.id === selectedStep.id);
                                    const newStep: EquipmentScriptStep = { id: makeId("step"), type: "command", title: `${selectedStep.title} Copy`, inputBindings: [] };
                                    const reordered = [...selectedScript.steps];
                                    reordered.splice(Math.max(0, currentIndex), 0, newStep);
                                    const next = cloneStateWithScript(state, selectedScript.id, (script) => ({ ...script, steps: reordered }));
                                    setState(next);
                                    setSelectedStepId(newStep.id);
                                    void persistState(next, "Step added");
                                  }}
                                  style={buttonStyle()}
                                >
                                  Add Above
                                </button>
                                <button
                                  onClick={() => {
                                    const currentIndex = selectedScript.steps.findIndex((entry) => entry.id === selectedStep.id);
                                    const newStep: EquipmentScriptStep = { id: makeId("step"), type: "command", title: `${selectedStep.title} Follow-up`, inputBindings: [] };
                                    const reordered = [...selectedScript.steps];
                                    reordered.splice(currentIndex + 1, 0, newStep);
                                    const next = cloneStateWithScript(state, selectedScript.id, (script) => ({ ...script, steps: reordered }));
                                    setState(next);
                                    setSelectedStepId(newStep.id);
                                    void persistState(next, "Step added");
                                  }}
                                  style={buttonStyle()}
                                >
                                  Add Below
                                </button>
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
                                  {selectedScriptCommandGroups.map((group) => (
                                    <optgroup key={group.label} label={group.label}>
                                      {group.commands.map((command) => <option key={command.id} value={command.id}>{command.name}</option>)}
                                    </optgroup>
                                  ))}
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
                            {selectedStepCommand?.inputDefs.length ? (
                              <section style={{ ...cardStyle(), marginTop: "0.85rem", padding: "0.8rem" }}>
                                <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Step Inputs</div>
                                <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.82rem" }}>Bind each required command input to a literal value or an output from an earlier step.</div>
                                <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.7rem" }}>
                                  {selectedStepCommand.inputDefs.map((inputDef) => {
                                    const binding = selectedStep.inputBindings.find((entry) => entry.inputName === inputDef.name);
                                    const effectiveSource: StepInputSource = binding?.source ?? (inputDef.required && selectedStepOutputOptions.length ? "step-output" : "literal");
                                    const sourceOptionsForStep = selectedStepOutputOptions.filter((option) => !binding?.sourceStepId || option.stepId === binding.sourceStepId);
                                    return (
                                      <div key={`binding-${inputDef.id}`} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: "0.7rem", background: C.panel }}>
                                        <div style={{ display: "grid", gap: "0.65rem" }}>
                                          <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                                            <div>
                                              <div style={{ fontWeight: 700, fontSize: "0.9rem" }}>{inputDef.name}</div>
                                              <div style={{ marginTop: "0.15rem", color: C.muted, fontSize: "0.8rem" }}>
                                                {inputDef.description || (inputDef.required ? "Required input." : "Optional input.")}
                                              </div>
                                            </div>
                                            <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  const defaultOption = selectedStepOutputOptions[0];
                                                  const next = cloneStateWithScript(state, selectedScript.id, (script) => ({
                                                    ...script,
                                                    steps: script.steps.map((step) => step.id === selectedStep.id
                                                      ? upsertStepInputBinding(step, {
                                                        id: binding?.id ?? makeId("binding"),
                                                        inputName: inputDef.name,
                                                        source: "step-output",
                                                        sourceStepId: binding?.sourceStepId ?? defaultOption?.stepId,
                                                        sourceOutputName: binding?.sourceOutputName ?? defaultOption?.outputName,
                                                      })
                                                      : step),
                                                  }));
                                                  setState(next);
                                                  void persistState(next, "Step updated");
                                                }}
                                                style={buttonStyle(effectiveSource === "step-output" ? "primary" : "ghost")}
                                              >
                                                Previous Output
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  const next = cloneStateWithScript(state, selectedScript.id, (script) => ({
                                                    ...script,
                                                    steps: script.steps.map((step) => step.id === selectedStep.id
                                                      ? upsertStepInputBinding(step, {
                                                        id: binding?.id ?? makeId("binding"),
                                                        inputName: inputDef.name,
                                                        source: "literal",
                                                        literalValue: binding?.literalValue ?? inputDef.defaultValue ?? "",
                                                      })
                                                      : step),
                                                  }));
                                                  setState(next);
                                                  void persistState(next, "Step updated");
                                                }}
                                                style={buttonStyle(effectiveSource === "literal" ? "primary" : "ghost")}
                                              >
                                                Literal Value
                                              </button>
                                            </div>
                                          </div>
                                          <div style={{ display: "grid", gridTemplateColumns: effectiveSource === "step-output" ? "minmax(180px, 1fr) minmax(180px, 1fr)" : "minmax(220px, 1fr)", gap: "0.6rem", alignItems: "end" }}>
                                          {effectiveSource === "step-output" ? (
                                            <>
                                              <label style={labelStyle()}>
                                                Source Step
                                                <select value={binding?.sourceStepId ?? ""} onChange={(event) => {
                                                  const selectedOption = selectedStepOutputOptions.find((option) => option.stepId === event.target.value);
                                                  const next = cloneStateWithScript(state, selectedScript.id, (script) => ({
                                                    ...script,
                                                    steps: script.steps.map((step) => step.id === selectedStep.id
                                                      ? upsertStepInputBinding(step, {
                                                        id: binding?.id ?? makeId("binding"),
                                                        inputName: inputDef.name,
                                                        source: "step-output",
                                                        sourceStepId: event.target.value || undefined,
                                                        sourceOutputName: selectedOption?.outputName,
                                                      })
                                                      : step),
                                                  }));
                                                  setState(next);
                                                  void persistState(next, "Step updated");
                                                }} style={inputStyle()}>
                                                  <option value="">Select step</option>
                                                  {Array.from(new Map(selectedStepOutputOptions.map((option) => [option.stepId, option.stepTitle])).entries()).map(([stepId, stepTitle]) => (
                                                    <option key={`step-src-${stepId}`} value={stepId}>{stepTitle}</option>
                                                  ))}
                                                </select>
                                              </label>
                                              <label style={labelStyle()}>
                                                Output
                                                <select value={binding?.sourceOutputName ?? ""} onChange={(event) => {
                                                  const next = cloneStateWithScript(state, selectedScript.id, (script) => ({
                                                    ...script,
                                                    steps: script.steps.map((step) => step.id === selectedStep.id
                                                      ? upsertStepInputBinding(step, {
                                                        id: binding?.id ?? makeId("binding"),
                                                        inputName: inputDef.name,
                                                        source: "step-output",
                                                        sourceStepId: binding?.sourceStepId,
                                                        sourceOutputName: event.target.value || undefined,
                                                      })
                                                      : step),
                                                  }));
                                                  setState(next);
                                                  void persistState(next, "Step updated");
                                                }} style={inputStyle()}>
                                                  <option value="">Select output</option>
                                                  {sourceOptionsForStep.map((option) => <option key={`output-src-${option.stepId}-${option.outputName}`} value={option.outputName}>{option.outputName}</option>)}
                                                </select>
                                              </label>
                                            </>
                                          ) : (
                                            <label style={labelStyle()}>
                                              Literal Value
                                              {commandInputValueControl({
                                                inputDef,
                                                value: binding?.literalValue ?? inputDef.defaultValue ?? "",
                                                onChange: (value) => setState((current) => cloneStateWithScript(current, selectedScript.id, (script) => ({
                                                  ...script,
                                                  steps: script.steps.map((step) => step.id === selectedStep.id
                                                    ? upsertStepInputBinding(step, { id: binding?.id ?? makeId("binding"), inputName: inputDef.name, source: "literal", literalValue: value })
                                                    : step),
                                                }))),
                                                onBlur: () => void persistState(state, "Step updated"),
                                              })}
                                            </label>
                                          )}
                                        </div>
                                      </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </section>
                            ) : null}
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
                    const presetScripts = preset.createScripts?.(device) ?? [];
                    const retainedScripts = state.scripts.filter((script) => !(script.builtIn && script.deviceId === device.id));
                    const next = {
                      ...state,
                      devices: [...state.devices, device],
                      scripts: [...retainedScripts, ...presetScripts],
                    };
                    setState(next);
                    setSelectedDeviceId(device.id);
                    if (presetScripts[0]) setSelectedScriptId(presetScripts[0].id);
                    setDeviceChooserOpen(false);
                    void persistState(next, presetScripts.length ? "Device and scripts added" : "Device added");
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
