import type {
  NativeSerialFilter,
  NativeSerialFlowControl,
  NativeSerialParity,
} from "./native.ts";

export type SerialPortId = string;
export type SerialClaimantId = string;

export type SerialOpenOptions = {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: NativeSerialParity;
  bufferSize?: number;
  flowControl?: NativeSerialFlowControl;
};

export type SerialPortState =
  | "closed"
  | "opening"
  | "open"
  | "closing"
  | "disconnected"
  | "error";

export type SerialRequestFilter = NativeSerialFilter;

export type SerialPortInfo = {
  id: SerialPortId;
  label: string;
  usbVendorId?: number;
  usbProductId?: number;
  granted: boolean;
  state: SerialPortState;
  claimedBy?: SerialClaimantId;
  subscriberCount: number;
  lastOpenOptions?: SerialOpenOptions;
  lastError?: string;
  lastSeenAt?: string;
};

export type SerialPortsListener = (ports: SerialPortInfo[]) => void;
export type SerialRawListener = (chunk: Uint8Array, port: SerialPortInfo) => void;
export type SerialTextListener = (text: string, port: SerialPortInfo) => void;
export type SerialPortEventListener = (
  event:
    | { type: "state"; port: SerialPortInfo }
    | { type: "error"; port: SerialPortInfo; error: Error }
    | { type: "claimed"; port: SerialPortInfo; claimant: SerialClaimantId }
    | { type: "released"; port: SerialPortInfo; claimant: SerialClaimantId }
) => void;

export type SerialRuntime = {
  isSupported(): boolean;
  refreshPorts(): Promise<SerialPortInfo[]>;
  listPorts(): SerialPortInfo[];
  requestPort(filters?: SerialRequestFilter[]): Promise<SerialPortInfo | null>;
  claimPort(
    portId: SerialPortId,
    claimant: SerialClaimantId,
    options?: SerialOpenOptions
  ): Promise<void>;
  releasePort(portId: SerialPortId, claimant: SerialClaimantId): Promise<void>;
  openPort(
    portId: SerialPortId,
    options: SerialOpenOptions,
    claimant?: SerialClaimantId
  ): Promise<void>;
  closePort(portId: SerialPortId, claimant?: SerialClaimantId): Promise<void>;
  write(
    portId: SerialPortId,
    data: Uint8Array,
    claimant?: SerialClaimantId
  ): Promise<void>;
  setPortLabel(portId: SerialPortId, label: string): void;
  subscribePorts(listener: SerialPortsListener): () => void;
  subscribeRaw(portId: SerialPortId, listener: SerialRawListener): () => void;
  subscribeText(portId: SerialPortId, listener: SerialTextListener): () => void;
  subscribeEvents(
    portId: SerialPortId,
    listener: SerialPortEventListener
  ): () => void;
};
