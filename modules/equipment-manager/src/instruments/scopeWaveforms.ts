type BridgeConfig = {
  url: string;
  token?: string;
};

type EquipmentCommand = {
  payload: string;
  timeoutMs: number;
};

type TcpCommandResult = {
  bytesBase64?: string;
  bytesLength?: number;
  text?: string;
  data?: string;
};

type SiglentWaveformResult = {
  kind: "siglent-waveform" | "keysight-waveform";
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
  points: Array<{
    index: number;
    timeSeconds: number;
    voltage: number;
    rawCode: number;
  }>;
};

const SIGLENT_WAVEFORM_SETUP = "WFSU SP,1,NP,20000,FP,0";
const SIGLENT_WAVEFORM_POINT_LIMIT = 20000;
const KEYSIGHT_WAVEFORM_POINT_LIMIT = 20000;

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
  if (!match) throw new Error(`Unable to parse numeric value from response: ${text}`);
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
      for (const value of bytes) samples.push(value > 127 ? value - 255 : value);
      return samples;
    }
    const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 32)));
    throw new Error(`Waveform response did not contain a SCPI binary block. Prefix: ${JSON.stringify(prefix)}`);
  }
  const digitCount = bytes[hashIndex + 1] - 48;
  if (digitCount < 1 || digitCount > 9) throw new Error("Waveform response contained an invalid binary-block length header.");
  const lengthText = new TextDecoder().decode(bytes.slice(hashIndex + 2, hashIndex + 2 + digitCount));
  const blockLength = Number(lengthText);
  if (!Number.isFinite(blockLength) || blockLength < 0) throw new Error("Waveform response contained an invalid binary-block length value.");
  const dataStart = hashIndex + 2 + digitCount;
  const dataEnd = dataStart + blockLength;
  if (dataEnd > bytes.length) throw new Error("Waveform response ended before the advertised binary block length.");
  const samples: number[] = [];
  for (const value of bytes.slice(dataStart, dataEnd)) samples.push(value > 127 ? value - 255 : value);
  return samples;
}

function extractScpiBlockPayload(bytesBase64: string): Uint8Array {
  const bytes = base64ToBytes(bytesBase64);
  const hashIndex = bytes.indexOf(35);
  if (hashIndex < 0 || hashIndex + 1 >= bytes.length) return bytes;
  const digitCount = bytes[hashIndex + 1] - 48;
  if (digitCount < 1 || digitCount > 9) return bytes;
  const lengthText = new TextDecoder().decode(bytes.slice(hashIndex + 2, hashIndex + 2 + digitCount));
  const blockLength = Number(lengthText);
  if (!Number.isFinite(blockLength) || blockLength < 0) return bytes;
  const dataStart = hashIndex + 2 + digitCount;
  const dataEnd = Math.min(bytes.length, dataStart + blockLength);
  return bytes.slice(dataStart, dataEnd);
}

function readInt32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, true);
}

function readFloat32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(offset, true);
}

function parseSiglentWaveDescriptor(bytesBase64: string, returnedPointCount: number, fallbackSpanSeconds: number) {
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
  const totalSpanSeconds = sourcePointCount > 0 && sourceIntervalSeconds > 0 ? sourcePointCount * sourceIntervalSeconds : fallbackSpanSeconds;
  const effectiveIntervalSeconds = totalSpanSeconds / safeReturnedCount;
  if (!Number.isFinite(totalSpanSeconds) || totalSpanSeconds <= 0 || !Number.isFinite(effectiveIntervalSeconds) || effectiveIntervalSeconds <= 0) return null;
  return { waveArrayCount: sourcePointCount, returnedPointCount: safeReturnedCount, sourceIntervalSeconds, effectiveIntervalSeconds, totalSpanSeconds };
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
  const descriptor = args.descriptor?.bytesBase64 ? parseSiglentWaveDescriptor(args.descriptor.bytesBase64, codes.length, fallbackSpanSeconds) : null;
  const intervalSeconds = descriptor?.effectiveIntervalSeconds ?? (fallbackSpanSeconds / Math.max(1, codes.length));
  const totalSpanSeconds = descriptor?.totalSpanSeconds ?? fallbackSpanSeconds;
  const startTimeSeconds = triggerDelaySeconds - (totalSpanSeconds / 2);
  const points = codes.map((rawCode, index) => ({ index, rawCode, timeSeconds: startTimeSeconds + (index * intervalSeconds), voltage: rawCode * (voltsPerDiv / 25) - offsetVolts }));
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
    metadata: { voltsPerDiv, offsetVolts, timePerDivSeconds, triggerDelaySeconds, sampleRateHz, grid },
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

function parseKeysightWaveformPreamble(text: string) {
  const values = text.split(",").map((part) => Number(part.trim())).filter((value) => Number.isFinite(value));
  if (values.length < 10) throw new Error(`Unexpected Keysight preamble: ${text}`);
  return {
    xIncrement: values[4]!,
    xOrigin: values[5]!,
    xReference: values[6]!,
    yIncrement: values[7]!,
    yOrigin: values[8]!,
    yReference: values[9]!,
  };
}

function buildKeysightWaveformResult(args: {
  channel: string;
  waveform: TcpCommandResult;
  preambleResponse: string;
  voltsPerDivResponse: string;
  offsetResponse: string;
  timeDivResponse: string;
  sampleRateResponse?: string;
}): SiglentWaveformResult {
  const preamble = parseKeysightWaveformPreamble(args.preambleResponse);
  const payload = extractScpiBlockPayload(args.waveform.bytesBase64 ?? "");
  const points = Array.from(payload).map((rawCode, index) => ({
    index,
    rawCode,
    timeSeconds: preamble.xOrigin + ((index - preamble.xReference) * preamble.xIncrement),
    voltage: ((rawCode - preamble.yReference) * preamble.yIncrement) + preamble.yOrigin,
  }));
  const minVoltage = points.length ? points.reduce((min, point) => Math.min(min, point.voltage), Number.POSITIVE_INFINITY) : 0;
  const maxVoltage = points.length ? points.reduce((max, point) => Math.max(max, point.voltage), Number.NEGATIVE_INFINITY) : 0;
  const voltsPerDiv = parseScpiNumber(args.voltsPerDivResponse);
  const offsetVolts = parseScpiNumber(args.offsetResponse);
  const timePerDivSeconds = parseScpiNumber(args.timeDivResponse);
  const sampleRateHz = args.sampleRateResponse ? parseScpiNumber(args.sampleRateResponse) : (preamble.xIncrement > 0 ? 1 / preamble.xIncrement : 0);
  return {
    kind: "keysight-waveform",
    channel: args.channel,
    sampleCount: points.length,
    intervalSeconds: preamble.xIncrement,
    startTimeSeconds: points[0]?.timeSeconds ?? preamble.xOrigin,
    endTimeSeconds: points[points.length - 1]?.timeSeconds ?? preamble.xOrigin,
    minVoltage,
    maxVoltage,
    metadata: { voltsPerDiv, offsetVolts, timePerDivSeconds, triggerDelaySeconds: 0, sampleRateHz, grid: 10 },
    transport: {
      waveformBytes: args.waveform.bytesLength ?? 0,
      setupCommand: ":WAVeform:SOURce / :WAVeform:FORMat / :WAVeform:PREamble? / :WAVeform:DATA?",
      setupReadMode: "until-timeout",
      queries: {
        preamble: args.preambleResponse,
        voltsPerDiv: args.voltsPerDivResponse,
        offset: args.offsetResponse,
        timeDiv: args.timeDivResponse,
        sampleRate: args.sampleRateResponse ?? "",
      },
    },
    points,
  };
}

export async function executeSiglentWaveformCommand(args: {
  activeBridge: BridgeConfig;
  target: { host: string; port: number };
  command: EquipmentCommand;
  inputValues?: Record<string, unknown>;
  applyTemplate: (template: string, values: Record<string, unknown>) => string;
  fetchTcpText: (bridge: BridgeConfig, target: { host: string; port: number }, command: string, timeoutMs?: number) => Promise<string>;
  callBridge: <T>(bridge: BridgeConfig, method: string, params?: Record<string, unknown>) => Promise<T>;
  parseOptionalNumber: (value: unknown) => number | undefined;
}): Promise<SiglentWaveformResult> {
  const waveformPayload = args.applyTemplate(args.command.payload, {
    ...(args.inputValues ?? {}),
    channel: String(args.inputValues?.["channel"] ?? parseSiglentWaveformChannel(args.command.payload)),
  });
  const channel = parseSiglentWaveformChannel(waveformPayload);
  const [voltsPerDivResponse, offsetResponse, timeDivResponse, triggerDelayResponse, sampleRateResponse] = await Promise.all([
    args.fetchTcpText(args.activeBridge, args.target, `${channel}:VDIV?`),
    args.fetchTcpText(args.activeBridge, args.target, `${channel}:OFST?`),
    args.fetchTcpText(args.activeBridge, args.target, "TDIV?"),
    args.fetchTcpText(args.activeBridge, args.target, "TRDL?"),
    args.fetchTcpText(args.activeBridge, args.target, "SARA?"),
  ]);
  const sourcePointCount = Math.max(1, Math.round(parseScpiNumber(timeDivResponse) * 14 * parseScpiNumber(sampleRateResponse)));
  const computedSparsing = Math.max(1, Math.floor((sourcePointCount - 1) / Math.max(1, SIGLENT_WAVEFORM_POINT_LIMIT - 1)));
  const sparsingCandidates = Array.from(new Set([Math.max(1, computedSparsing - 1), computedSparsing, Math.max(1, computedSparsing + 1), 1]));
  let result: SiglentWaveformResult | null = null;
  let waveformSetup = `WFSU SP,${computedSparsing},NP,${SIGLENT_WAVEFORM_POINT_LIMIT},FP,0`;
  let lastWaveformError: Error | null = null;
  for (const sparsing of sparsingCandidates) {
    waveformSetup = `WFSU SP,${sparsing},NP,${SIGLENT_WAVEFORM_POINT_LIMIT},FP,0`;
    await args.callBridge<unknown>(args.activeBridge, "execute_tcp_command", { host: args.target.host, port: args.target.port, command: waveformSetup, readMode: "none", timeoutMs: 1500 });
    const [descriptor, waveform] = await Promise.all([
      args.callBridge<TcpCommandResult>(args.activeBridge, "execute_tcp_command", { host: args.target.host, port: args.target.port, command: `${channel}:WF? DESC`, readMode: "until-timeout", timeoutMs: 8000, quietMs: 1500, encoding: "base64" }),
      args.callBridge<TcpCommandResult>(args.activeBridge, "execute_tcp_command", { host: args.target.host, port: args.target.port, command: waveformPayload, readMode: "until-timeout", timeoutMs: args.command.timeoutMs || 15000, quietMs: 1500, encoding: "base64" }),
    ]);
    try {
      result = buildSiglentWaveformResult({ channel, waveform, descriptor, voltsPerDivResponse, offsetResponse, timeDivResponse, triggerDelayResponse, sampleRateResponse });
      break;
    } catch (error) {
      lastWaveformError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (!result) throw lastWaveformError ?? new Error("Unable to capture a valid waveform block from the scope.");
  const centerTimeSeconds = args.parseOptionalNumber(args.inputValues?.["centerTimeSeconds"]);
  const timePerDivSeconds = args.parseOptionalNumber(args.inputValues?.["timePerDivSeconds"]);
  const centerVolts = args.parseOptionalNumber(args.inputValues?.["centerVolts"]);
  const scopeOffsetVolts = args.parseOptionalNumber(args.inputValues?.["scopeOffsetVolts"]);
  const voltsPerDiv = args.parseOptionalNumber(args.inputValues?.["voltsPerDiv"]);
  const horizontalHalfSpan = typeof timePerDivSeconds === "number" ? (timePerDivSeconds * result.metadata.grid / 2) : undefined;
  const verticalHalfSpan = typeof voltsPerDiv === "number" ? (voltsPerDiv * result.metadata.grid / 2) : undefined;
  const resolvedCenterVolts = typeof centerVolts === "number" ? centerVolts : (typeof scopeOffsetVolts === "number" ? -scopeOffsetVolts : undefined);
  const preferredViewport = {
    xMinSeconds: typeof centerTimeSeconds === "number" && typeof horizontalHalfSpan === "number" ? centerTimeSeconds - horizontalHalfSpan : undefined,
    xMaxSeconds: typeof centerTimeSeconds === "number" && typeof horizontalHalfSpan === "number" ? centerTimeSeconds + horizontalHalfSpan : undefined,
    yMinVolts: typeof resolvedCenterVolts === "number" && typeof verticalHalfSpan === "number" ? resolvedCenterVolts - verticalHalfSpan : undefined,
    yMaxVolts: typeof resolvedCenterVolts === "number" && typeof verticalHalfSpan === "number" ? resolvedCenterVolts + verticalHalfSpan : undefined,
  };
  if (Object.values(preferredViewport).some((value) => typeof value === "number")) result.preferredViewport = preferredViewport;
  result.transport.setupCommand = waveformSetup;
  return result;
}

export async function executeKeysightWaveformCommand(args: {
  activeBridge: BridgeConfig;
  target: { host: string; port: number };
  command: EquipmentCommand;
  inputValues?: Record<string, unknown>;
  fetchTcpText: (bridge: BridgeConfig, target: { host: string; port: number }, command: string, timeoutMs?: number) => Promise<string>;
  callBridge: <T>(bridge: BridgeConfig, method: string, params?: Record<string, unknown>) => Promise<T>;
}): Promise<SiglentWaveformResult> {
  const channelNumber = String(args.inputValues?.["channelNumber"] ?? "1").trim() || "1";
  const channel = `CHANnel${channelNumber}`;
  await args.callBridge<unknown>(args.activeBridge, "execute_tcp_command", { host: args.target.host, port: args.target.port, command: `:WAVeform:SOURce ${channel}`, readMode: "none", timeoutMs: 1500 });
  await args.callBridge<unknown>(args.activeBridge, "execute_tcp_command", { host: args.target.host, port: args.target.port, command: ":WAVeform:FORMat BYTE", readMode: "none", timeoutMs: 1500 });
  await args.callBridge<unknown>(args.activeBridge, "execute_tcp_command", { host: args.target.host, port: args.target.port, command: ":WAVeform:UNSigned 1", readMode: "none", timeoutMs: 1500 });
  await args.callBridge<unknown>(args.activeBridge, "execute_tcp_command", { host: args.target.host, port: args.target.port, command: ":WAVeform:POINts:MODE RAW", readMode: "none", timeoutMs: 1500 });
  await args.callBridge<unknown>(args.activeBridge, "execute_tcp_command", { host: args.target.host, port: args.target.port, command: `:WAVeform:POINts ${KEYSIGHT_WAVEFORM_POINT_LIMIT}`, readMode: "none", timeoutMs: 1500 });
  const [preamble, waveform, voltsPerDivResponse, offsetResponse, timeDivResponse, sampleRateResponse] = await Promise.all([
    args.fetchTcpText(args.activeBridge, args.target, ":WAVeform:PREamble?"),
    args.callBridge<TcpCommandResult>(args.activeBridge, "execute_tcp_command", { host: args.target.host, port: args.target.port, command: args.command.payload || ":WAVeform:DATA?", readMode: "until-timeout", timeoutMs: args.command.timeoutMs || 15000, quietMs: 800, encoding: "base64" }),
    args.fetchTcpText(args.activeBridge, args.target, `:CHANnel${channelNumber}:SCALe?`),
    args.fetchTcpText(args.activeBridge, args.target, `:CHANnel${channelNumber}:OFFSet?`),
    args.fetchTcpText(args.activeBridge, args.target, ":TIMebase:SCALe?"),
    args.fetchTcpText(args.activeBridge, args.target, ":ACQuire:SRATe?").catch(() => ""),
  ]);
  return buildKeysightWaveformResult({ channel, waveform, preambleResponse: preamble, voltsPerDivResponse, offsetResponse, timeDivResponse, sampleRateResponse });
}
