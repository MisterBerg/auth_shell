export type NativeSerialParity = "none" | "even" | "odd";
export type NativeSerialFlowControl = "none" | "hardware";

export type NativeSerialOptions = {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: NativeSerialParity;
  bufferSize?: number;
  flowControl?: NativeSerialFlowControl;
};

export type NativeSerialFilter = {
  usbVendorId?: number;
  usbProductId?: number;
};

export type NativeSerialInfo = {
  usbVendorId?: number;
  usbProductId?: number;
};

export interface NativeReadableStreamDefaultReader<T> {
  read(): Promise<{ value?: T; done: boolean }>;
  releaseLock(): void;
  cancel(reason?: unknown): Promise<void>;
}

export interface NativeWritableStreamDefaultWriter<T> {
  write(chunk: T): Promise<void>;
  close(): Promise<void>;
  releaseLock(): void;
}

export interface NativeSerialPort {
  readable: {
    getReader(): NativeReadableStreamDefaultReader<Uint8Array>;
  } | null;
  writable: {
    getWriter(): NativeWritableStreamDefaultWriter<Uint8Array>;
  } | null;
  open(options: NativeSerialOptions): Promise<void>;
  close(): Promise<void>;
  forget?: () => Promise<void>;
  getInfo(): NativeSerialInfo;
}

export interface NativeSerial {
  getPorts(): Promise<NativeSerialPort[]>;
  requestPort(options?: { filters?: NativeSerialFilter[] }): Promise<NativeSerialPort>;
  addEventListener(type: "connect" | "disconnect", listener: EventListener): void;
  removeEventListener(type: "connect" | "disconnect", listener: EventListener): void;
}

export function getNativeSerial(): NativeSerial | null {
  const nav = navigator as Navigator & { serial?: NativeSerial };
  return nav.serial ?? null;
}
