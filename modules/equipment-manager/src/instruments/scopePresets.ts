type CommandOutputSource = "json-path" | "regex";
type ParserMode = "text" | "json" | "number" | "csv" | "binary" | "none" | "siglent-waveform" | "keysight-waveform";
type ArtifactMode = "none" | "text" | "json" | "csv" | "image" | "binary";
type ScriptStepType = "command" | "wait" | "capture" | "note";
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
  mode: "scpi" | "http" | "raw" | "custom";
  payload: string;
  parser: ParserMode;
  timeoutMs: number;
  saveAs?: string;
  artifactMode: ArtifactMode;
  notes?: string;
  inputDefs: CommandInputDef[];
  outputDefs: CommandOutputDef[];
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
  transport: "serial" | "tcp-scpi" | "http-rest" | "visa" | "can" | "custom";
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

export function createSiglentDefaultState(args: {
  makeId: (prefix: string) => string;
  scpiValueRegex: string;
}): EquipmentManagerState {
  const { makeId, scpiValueRegex } = args;
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
            { id: makeId("output"), name: "voltsPerDiv", source: "regex", selector: scpiValueRegex, captureGroup: 1 },
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
            { id: makeId("output"), name: "offsetVolts", source: "regex", selector: scpiValueRegex, captureGroup: 1 },
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
            { id: makeId("output"), name: "timePerDivSeconds", source: "regex", selector: scpiValueRegex, captureGroup: 1 },
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
            { id: makeId("output"), name: "triggerDelaySeconds", source: "regex", selector: scpiValueRegex, captureGroup: 1 },
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

export function createKnownSiglentPreset(args: {
  baseState: EquipmentManagerState;
  targetDeviceId?: string;
  targetAddress?: string;
}): { device: EquipmentDevice; scripts: EquipmentScript[] } {
  const device = {
    ...args.baseState.devices[0]!,
    id: args.targetDeviceId ?? args.baseState.devices[0]!.id,
    address: args.targetAddress ?? args.baseState.devices[0]!.address,
  };
  const scripts = args.baseState.scripts.map((script) => ({ ...script, deviceId: device.id }));
  return { device, scripts };
}

export function createKnownKeysightPreset(args: {
  makeId: (prefix: string) => string;
  scpiValueRegex: string;
  targetDeviceId?: string;
  targetAddress?: string;
}): { device: EquipmentDevice; scripts: EquipmentScript[] } {
  const { makeId, scpiValueRegex, targetAddress, targetDeviceId } = args;
  const deviceId = targetDeviceId ?? makeId("device");
  const identifyCommandId = makeId("cmd");
  const channelScaleCommandId = makeId("cmd");
  const channelOffsetCommandId = makeId("cmd");
  const timebaseCommandId = makeId("cmd");
  const sampleRateCommandId = makeId("cmd");
  const triggerModeCommandId = makeId("cmd");
  const triggerSourceCommandId = makeId("cmd");
  const triggerLevelCommandId = makeId("cmd");
  const triggerSlopeCommandId = makeId("cmd");
  const setTriggerSlopeCommandId = makeId("cmd");
  const runCommandId = makeId("cmd");
  const stopCommandId = makeId("cmd");
  const armSingleCommandId = makeId("cmd");
  const setTimebaseCommandId = makeId("cmd");
  const setChannelScaleCommandId = makeId("cmd");
  const setChannelOffsetCommandId = makeId("cmd");
  const captureCommandId = makeId("cmd");
  const waveformCommandId = makeId("cmd");
  const scriptId = makeId("script");
  const makeStep = (title: string, commandId: string, type: ScriptStepType = "command", saveAs?: string): EquipmentScriptStep => ({
    id: makeId("step"),
    type,
    title,
    commandId,
    saveAs,
    inputBindings: [],
  });
  const device: EquipmentDevice = {
    id: deviceId,
    name: "Keysight MSOX4054A",
    transport: "tcp-scpi",
    address: targetAddress ?? "",
    capabilities: ["scpi", "tcp", "waveform", "screenshot"],
    notes: "Keysight InfiniiVision 4000 X-Series preset for MSOX4054A over LAN SCPI.",
    commands: [
      { id: identifyCommandId, name: "Identify", categoryPath: "Device / Info", builtIn: true, mode: "scpi", payload: "*IDN?", parser: "text", timeoutMs: 3000, artifactMode: "text", saveAs: "identity.txt", notes: "Queries the oscilloscope identity string.", inputDefs: [], outputDefs: [] },
      { id: channelScaleCommandId, name: "Read CH1 Scale", categoryPath: "Channel / CH1", builtIn: true, mode: "scpi", payload: ":CHANnel1:SCALe?", parser: "text", timeoutMs: 3000, artifactMode: "text", notes: "Reads volts-per-division for analog channel 1.", inputDefs: [], outputDefs: [{ id: makeId("output"), name: "voltsPerDivText", source: "json-path", selector: "text" }, { id: makeId("output"), name: "voltsPerDiv", source: "regex", selector: scpiValueRegex, captureGroup: 1 }] },
      { id: channelOffsetCommandId, name: "Read CH1 Offset", categoryPath: "Channel / CH1", builtIn: true, mode: "scpi", payload: ":CHANnel1:OFFSet?", parser: "text", timeoutMs: 3000, artifactMode: "text", notes: "Reads the vertical offset for analog channel 1.", inputDefs: [], outputDefs: [{ id: makeId("output"), name: "offsetVoltsText", source: "json-path", selector: "text" }, { id: makeId("output"), name: "offsetVolts", source: "regex", selector: scpiValueRegex, captureGroup: 1 }] },
      { id: timebaseCommandId, name: "Read Timebase", categoryPath: "Acquire / Timing", builtIn: true, mode: "scpi", payload: ":TIMebase:SCALe?", parser: "text", timeoutMs: 3000, artifactMode: "text", notes: "Reads the horizontal scale in seconds per division.", inputDefs: [], outputDefs: [{ id: makeId("output"), name: "timeDivText", source: "json-path", selector: "text" }, { id: makeId("output"), name: "timePerDivSeconds", source: "regex", selector: scpiValueRegex, captureGroup: 1 }] },
      { id: sampleRateCommandId, name: "Read Sample Rate", categoryPath: "Acquire / Timing", builtIn: true, mode: "scpi", payload: ":ACQuire:SRATe?", parser: "text", timeoutMs: 3000, artifactMode: "text", notes: "Reads the current sample rate when supported by the scope firmware.", inputDefs: [], outputDefs: [{ id: makeId("output"), name: "sampleRateText", source: "json-path", selector: "text" }, { id: makeId("output"), name: "sampleRateHz", source: "regex", selector: scpiValueRegex, captureGroup: 1 }] },
      { id: triggerModeCommandId, name: "Read Trigger Mode", categoryPath: "Trigger / Read", builtIn: true, mode: "scpi", payload: ":TRIGger:MODE?", parser: "text", timeoutMs: 3000, artifactMode: "text", notes: "Reads the active trigger mode.", inputDefs: [], outputDefs: [{ id: makeId("output"), name: "triggerMode", source: "json-path", selector: "text" }] },
      { id: triggerSourceCommandId, name: "Read Trigger Source", categoryPath: "Trigger / Read", builtIn: true, mode: "scpi", payload: ":TRIGger:EDGE:SOURce?", parser: "text", timeoutMs: 3000, artifactMode: "text", notes: "Reads the edge trigger source.", inputDefs: [], outputDefs: [{ id: makeId("output"), name: "triggerSource", source: "json-path", selector: "text" }] },
      { id: triggerLevelCommandId, name: "Read Trigger Level", categoryPath: "Trigger / Read", builtIn: true, mode: "scpi", payload: ":TRIGger:LEVel?", parser: "text", timeoutMs: 3000, artifactMode: "text", notes: "Reads the active trigger level.", inputDefs: [], outputDefs: [{ id: makeId("output"), name: "triggerLevelText", source: "json-path", selector: "text" }, { id: makeId("output"), name: "triggerLevelVolts", source: "regex", selector: scpiValueRegex, captureGroup: 1 }] },
      { id: triggerSlopeCommandId, name: "Read Trigger Slope", categoryPath: "Trigger / Read", builtIn: true, mode: "scpi", payload: ":TRIGger:EDGE:SLOPe?", parser: "text", timeoutMs: 3000, artifactMode: "text", notes: "Reads the active edge trigger slope.", inputDefs: [], outputDefs: [{ id: makeId("output"), name: "triggerSlope", source: "json-path", selector: "text" }] },
      { id: setTriggerSlopeCommandId, name: "Set Trigger Slope", categoryPath: "Trigger / Configure", builtIn: true, mode: "scpi", payload: ":TRIGger:EDGE:SLOPe {{slope}}", parser: "none", timeoutMs: 3000, artifactMode: "none", notes: "Sets the edge trigger slope. Official options include POSitive, NEGative, EITHer, and ALTernate.", inputDefs: [{ id: makeId("input"), name: "slope", required: true, defaultValue: "POSitive", options: ["POSitive", "NEGative", "EITHer", "ALTernate"] }], outputDefs: [] },
      { id: runCommandId, name: "Run", categoryPath: "Acquire / Control", builtIn: true, mode: "scpi", payload: ":RUN", parser: "none", timeoutMs: 3000, artifactMode: "none", notes: "Starts continuous acquisition.", inputDefs: [], outputDefs: [] },
      { id: stopCommandId, name: "Stop", categoryPath: "Acquire / Control", builtIn: true, mode: "scpi", payload: ":STOP", parser: "none", timeoutMs: 3000, artifactMode: "none", notes: "Stops acquisition.", inputDefs: [], outputDefs: [] },
      { id: armSingleCommandId, name: "Arm Single", categoryPath: "Acquire / Control", builtIn: true, mode: "scpi", payload: ":SINGle", parser: "none", timeoutMs: 3000, artifactMode: "none", notes: "Arms a single acquisition.", inputDefs: [], outputDefs: [] },
      { id: setTimebaseCommandId, name: "Set Timebase", categoryPath: "Acquire / Timing", builtIn: true, mode: "scpi", payload: ":TIMebase:SCALe {{timePerDivSeconds}}", parser: "none", timeoutMs: 3000, artifactMode: "none", notes: "Sets the horizontal scale in seconds per division.", inputDefs: [{ id: makeId("input"), name: "timePerDivSeconds", required: true, defaultValue: "5.00E-04" }], outputDefs: [] },
      { id: setChannelScaleCommandId, name: "Set Channel Scale", categoryPath: "Channel / Configure", builtIn: true, mode: "scpi", payload: ":CHANnel{{channelNumber}}:SCALe {{voltsPerDiv}}", parser: "none", timeoutMs: 3000, artifactMode: "none", notes: "Sets volts-per-division for an analog channel.", inputDefs: [{ id: makeId("input"), name: "channelNumber", required: true, defaultValue: "1" }, { id: makeId("input"), name: "voltsPerDiv", required: true, defaultValue: "5.00E-01" }], outputDefs: [] },
      { id: setChannelOffsetCommandId, name: "Set Channel Offset", categoryPath: "Channel / Configure", builtIn: true, mode: "scpi", payload: ":CHANnel{{channelNumber}}:OFFSet {{offsetVolts}}", parser: "none", timeoutMs: 3000, artifactMode: "none", notes: "Sets the vertical offset for an analog channel.", inputDefs: [{ id: makeId("input"), name: "channelNumber", required: true, defaultValue: "1" }, { id: makeId("input"), name: "offsetVolts", required: true, defaultValue: "0" }], outputDefs: [] },
      { id: captureCommandId, name: "Capture Screenshot", categoryPath: "Acquire / Capture", builtIn: true, mode: "scpi", payload: ":DISPlay:DATA? PNG, COLor", parser: "binary", timeoutMs: 15000, artifactMode: "image", saveAs: "scope-screen.png", notes: "Reads a PNG screenshot as an IEEE 488.2 binary block.", inputDefs: [], outputDefs: [] },
      { id: waveformCommandId, name: "Capture Waveform", categoryPath: "Acquire / Waveform", builtIn: true, mode: "scpi", payload: ":WAVeform:DATA?", parser: "keysight-waveform", timeoutMs: 15000, artifactMode: "csv", saveAs: "waveform.csv", notes: "Uses the Keysight :WAVeform preamble/data sequence to retrieve a channel waveform and render the interactive chart.", inputDefs: [{ id: makeId("input"), name: "channelNumber", required: true, defaultValue: "1" }], outputDefs: [{ id: makeId("output"), name: "sampleRateHz", source: "json-path", selector: "metadata.sampleRateHz" }, { id: makeId("output"), name: "timePerDivSeconds", source: "json-path", selector: "metadata.timePerDivSeconds" }, { id: makeId("output"), name: "voltsPerDiv", source: "json-path", selector: "metadata.voltsPerDiv" }, { id: makeId("output"), name: "offsetVolts", source: "json-path", selector: "metadata.offsetVolts" }, { id: makeId("output"), name: "windowStartSeconds", source: "json-path", selector: "startTimeSeconds" }, { id: makeId("output"), name: "windowEndSeconds", source: "json-path", selector: "endTimeSeconds" }, { id: makeId("output"), name: "minVoltage", source: "json-path", selector: "minVoltage" }, { id: makeId("output"), name: "maxVoltage", source: "json-path", selector: "maxVoltage" }] },
    ],
  };
  const scripts: EquipmentScript[] = [{
    id: scriptId,
    name: "Scope Window Snapshot",
    builtIn: true,
    deviceId,
    description: "Collect basic Keysight scope window metadata, then capture both a screenshot and a waveform.",
    steps: [
      makeStep("Identify instrument", identifyCommandId, "command", "identity.txt"),
      makeStep("Read CH1 scale", channelScaleCommandId, "command", "ch1-scale.txt"),
      makeStep("Read CH1 offset", channelOffsetCommandId, "command", "ch1-offset.txt"),
      makeStep("Read timebase", timebaseCommandId, "command", "timebase.txt"),
      makeStep("Read sample rate", sampleRateCommandId, "command", "sample-rate.txt"),
      makeStep("Read trigger mode", triggerModeCommandId, "command", "trigger-mode.txt"),
      makeStep("Read trigger source", triggerSourceCommandId, "command", "trigger-source.txt"),
      makeStep("Read trigger level", triggerLevelCommandId, "command", "trigger-level.txt"),
      makeStep("Capture scope screen", captureCommandId, "capture", "scope-screen.png"),
      { id: makeId("step"), type: "capture", title: "Capture waveform", commandId: waveformCommandId, saveAs: "ch1-waveform.csv", inputBindings: [{ id: makeId("binding"), inputName: "channelNumber", source: "literal", literalValue: "1" }] },
    ],
  }];
  return { device, scripts };
}
