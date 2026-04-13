import { decodeTextChunk, flushDecoder } from "./text.ts";
import { getNativeSerial, type NativeSerialPort } from "./native.ts";
import type {
  SerialClaimantId,
  SerialOpenOptions,
  SerialPortEventListener,
  SerialPortId,
  SerialPortInfo,
  SerialPortState,
  SerialRawListener,
  SerialRequestFilter,
  SerialRuntime,
  SerialTextListener,
  SerialPortsListener,
} from "./types.ts";

type PortEntry = {
  id: SerialPortId;
  port: NativeSerialPort;
  label: string;
  state: SerialPortState;
  granted: boolean;
  claimedBy?: SerialClaimantId;
  lastOpenOptions?: SerialOpenOptions;
  lastError?: string;
  lastSeenAt?: string;
  reader?: ReturnType<NonNullable<NativeSerialPort["readable"]>["getReader"]>;
  decoder?: TextDecoder;
  readLoop?: Promise<void>;
  generation: number;
  rawListeners: Set<SerialRawListener>;
  textListeners: Set<SerialTextListener>;
  eventListeners: Set<SerialPortEventListener>;
};

type RuntimeState = {
  portsById: Map<SerialPortId, PortEntry>;
  idsByPort: WeakMap<NativeSerialPort, SerialPortId>;
  portListeners: Set<SerialPortsListener>;
  connected: boolean;
};

function nowIso(): string {
  return new Date().toISOString();
}

function createPortLabel(id: SerialPortId, port: NativeSerialPort): string {
  const info = port.getInfo();
  const vendor = info.usbVendorId?.toString(16).padStart(4, "0");
  const product = info.usbProductId?.toString(16).padStart(4, "0");
  const suffix = id.slice(-6);
  if (vendor || product) {
    return `Port ${suffix} (${vendor ?? "????"}:${product ?? "????"})`;
  }
  return `Port ${suffix}`;
}

function cloneInfo(entry: PortEntry): SerialPortInfo {
  const info = entry.port.getInfo();
  return {
    id: entry.id,
    label: entry.label,
    usbVendorId: info.usbVendorId,
    usbProductId: info.usbProductId,
    granted: entry.granted,
    state: entry.state,
    claimedBy: entry.claimedBy,
    subscriberCount:
      entry.rawListeners.size + entry.textListeners.size + entry.eventListeners.size,
    lastOpenOptions: entry.lastOpenOptions,
    lastError: entry.lastError,
    lastSeenAt: entry.lastSeenAt,
  };
}

function assertPortExists(
  state: RuntimeState,
  portId: SerialPortId
): PortEntry {
  const entry = state.portsById.get(portId);
  if (!entry) throw new Error(`Unknown serial port: ${portId}`);
  return entry;
}

function assertOwnership(entry: PortEntry, claimant?: SerialClaimantId): void {
  if (!entry.claimedBy) return;
  if (claimant && entry.claimedBy === claimant) return;
  throw new Error(
    `Serial port "${entry.label}" is claimed by "${entry.claimedBy}".`
  );
}

function setState(entry: PortEntry, nextState: SerialPortState, error?: string) {
  entry.state = nextState;
  entry.lastSeenAt = nowIso();
  entry.lastError = error;
}

function emitPorts(state: RuntimeState): void {
  const snapshot = [...state.portsById.values()].map(cloneInfo);
  for (const listener of state.portListeners) listener(snapshot);
}

function emitEvent(entry: PortEntry, event: Parameters<SerialPortEventListener>[0]) {
  for (const listener of entry.eventListeners) listener(event);
}

function ensureEntry(state: RuntimeState, port: NativeSerialPort): PortEntry {
  let id = state.idsByPort.get(port);
  if (!id) {
    id = `serial-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    state.idsByPort.set(port, id);
  }

  const existing = state.portsById.get(id);
  if (existing) {
    existing.granted = true;
    existing.lastSeenAt = nowIso();
    return existing;
  }

  const entry: PortEntry = {
    id,
    port,
    label: createPortLabel(id, port),
    state: "closed",
    granted: true,
    generation: 0,
    lastSeenAt: nowIso(),
    rawListeners: new Set(),
    textListeners: new Set(),
    eventListeners: new Set(),
  };
  state.portsById.set(id, entry);
  return entry;
}

async function stopReader(entry: PortEntry): Promise<void> {
  if (entry.reader) {
    try {
      await entry.reader.cancel();
    } catch {
      // ignore
    }
    try {
      entry.reader.releaseLock();
    } catch {
      // ignore
    }
  }
  entry.reader = undefined;
  entry.decoder = undefined;
  entry.readLoop = undefined;
}

function startReadLoop(state: RuntimeState, entry: PortEntry): void {
  if (!entry.port.readable || entry.readLoop) return;
  const reader = entry.port.readable.getReader();
  const decoder = new TextDecoder();
  entry.reader = reader;
  entry.decoder = decoder;
  const generation = ++entry.generation;

  entry.readLoop = (async () => {
    try {
      while (entry.state === "open" && generation === entry.generation) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        const snapshot = cloneInfo(entry);
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        for (const listener of entry.rawListeners) listener(chunk, snapshot);
        if (entry.textListeners.size > 0 && entry.decoder) {
          const text = decodeTextChunk(entry.decoder, chunk);
          if (text) {
            for (const listener of entry.textListeners) listener(text, snapshot);
          }
        }
      }
      if (entry.textListeners.size > 0 && entry.decoder) {
        const text = flushDecoder(entry.decoder);
        if (text) {
          const snapshot = cloneInfo(entry);
          for (const listener of entry.textListeners) listener(text, snapshot);
        }
      }
      if (entry.state === "open") setState(entry, "disconnected");
      emitEvent(entry, { type: "state", port: cloneInfo(entry) });
      emitPorts(state);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setState(entry, "error", message);
      emitEvent(entry, {
        type: "error",
        port: cloneInfo(entry),
        error: error instanceof Error ? error : new Error(message),
      });
      emitPorts(state);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      if (entry.reader === reader) entry.reader = undefined;
      if (entry.decoder === decoder) entry.decoder = undefined;
      if (entry.readLoop) entry.readLoop = undefined;
    }
  })();
}

export function createSerialRuntime(): SerialRuntime {
  const nativeSerial = getNativeSerial();
  const state: RuntimeState = {
    portsById: new Map(),
    idsByPort: new WeakMap(),
    portListeners: new Set(),
    connected: !!nativeSerial,
  };

  const refreshPorts = async (): Promise<SerialPortInfo[]> => {
    if (!nativeSerial) return [];
    const ports = await nativeSerial.getPorts();
    for (const port of ports) ensureEntry(state, port);
    emitPorts(state);
    return [...state.portsById.values()].map(cloneInfo);
  };

  if (nativeSerial) {
    const handleConnect = () => {
      void refreshPorts();
    };
    const handleDisconnect = (event: Event) => {
      const maybePort = (event as Event & { target?: NativeSerialPort }).target;
      if (maybePort) {
        const id = state.idsByPort.get(maybePort);
        if (id) {
          const entry = state.portsById.get(id);
          if (entry) {
            setState(entry, "disconnected");
            emitEvent(entry, { type: "state", port: cloneInfo(entry) });
          }
        }
      }
      emitPorts(state);
    };
    nativeSerial.addEventListener("connect", handleConnect);
    nativeSerial.addEventListener("disconnect", handleDisconnect);
  }

  return {
    isSupported() {
      return !!nativeSerial;
    },

    async refreshPorts() {
      return refreshPorts();
    },

    listPorts() {
      return [...state.portsById.values()].map(cloneInfo);
    },

    async requestPort(filters?: SerialRequestFilter[]) {
      if (!nativeSerial) return null;
      const port = await nativeSerial.requestPort(
        filters?.length ? { filters } : undefined
      );
      const entry = ensureEntry(state, port);
      emitPorts(state);
      return cloneInfo(entry);
    },

    async claimPort(portId, claimant, options) {
      const entry = assertPortExists(state, portId);
      if (entry.claimedBy && entry.claimedBy !== claimant) {
        throw new Error(
          `Serial port "${entry.label}" is already claimed by "${entry.claimedBy}".`
        );
      }
      entry.claimedBy = claimant;
      if (options) entry.lastOpenOptions = options;
      entry.lastSeenAt = nowIso();
      emitEvent(entry, { type: "claimed", port: cloneInfo(entry), claimant });
      emitPorts(state);
    },

    async releasePort(portId, claimant) {
      const entry = assertPortExists(state, portId);
      if (entry.claimedBy && entry.claimedBy !== claimant) {
        throw new Error(
          `Serial port "${entry.label}" is claimed by "${entry.claimedBy}", not "${claimant}".`
        );
      }
      if (entry.state === "open") {
        await this.closePort(portId, claimant);
      }
      entry.claimedBy = undefined;
      entry.lastSeenAt = nowIso();
      emitEvent(entry, { type: "released", port: cloneInfo(entry), claimant });
      emitPorts(state);
    },

    async openPort(portId, options, claimant) {
      const entry = assertPortExists(state, portId);
      assertOwnership(entry, claimant);
      if (entry.state === "open") {
        entry.lastOpenOptions = options;
        emitPorts(state);
        return;
      }
      if (entry.state === "opening") return;
      setState(entry, "opening");
      emitPorts(state);
      try {
        await entry.port.open(options);
        entry.lastOpenOptions = options;
        setState(entry, "open");
        startReadLoop(state, entry);
        emitEvent(entry, { type: "state", port: cloneInfo(entry) });
        emitPorts(state);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        setState(entry, "error", message);
        emitEvent(entry, {
          type: "error",
          port: cloneInfo(entry),
          error: error instanceof Error ? error : new Error(message),
        });
        emitPorts(state);
        throw error;
      }
    },

    async closePort(portId, claimant) {
      const entry = assertPortExists(state, portId);
      assertOwnership(entry, claimant);
      if (entry.state !== "open" && entry.state !== "error" && entry.state !== "disconnected") {
        setState(entry, "closed");
        emitPorts(state);
        return;
      }
      setState(entry, "closing");
      emitPorts(state);
      await stopReader(entry);
      try {
        await entry.port.close();
      } catch {
        // ignore close errors to avoid wedging the runtime
      }
      setState(entry, "closed");
      emitEvent(entry, { type: "state", port: cloneInfo(entry) });
      emitPorts(state);
    },

    async write(portId, data, claimant) {
      const entry = assertPortExists(state, portId);
      assertOwnership(entry, claimant);
      if (entry.state !== "open" || !entry.port.writable) {
        throw new Error(`Serial port "${entry.label}" is not open for writing.`);
      }
      const writer = entry.port.writable.getWriter();
      try {
        await writer.write(data);
      } finally {
        writer.releaseLock();
      }
    },

    setPortLabel(portId, label) {
      const entry = assertPortExists(state, portId);
      entry.label = label.trim() || createPortLabel(entry.id, entry.port);
      entry.lastSeenAt = nowIso();
      emitPorts(state);
    },

    subscribePorts(listener) {
      state.portListeners.add(listener);
      listener([...state.portsById.values()].map(cloneInfo));
      return () => {
        state.portListeners.delete(listener);
      };
    },

    subscribeRaw(portId, listener) {
      const entry = assertPortExists(state, portId);
      entry.rawListeners.add(listener);
      emitPorts(state);
      return () => {
        entry.rawListeners.delete(listener);
        emitPorts(state);
      };
    },

    subscribeText(portId, listener) {
      const entry = assertPortExists(state, portId);
      entry.textListeners.add(listener);
      emitPorts(state);
      return () => {
        entry.textListeners.delete(listener);
        emitPorts(state);
      };
    },

    subscribeEvents(portId, listener) {
      const entry = assertPortExists(state, portId);
      entry.eventListeners.add(listener);
      emitPorts(state);
      return () => {
        entry.eventListeners.delete(listener);
        emitPorts(state);
      };
    },
  };
}
