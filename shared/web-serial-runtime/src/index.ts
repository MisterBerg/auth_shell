import { createSerialRuntime } from "./runtime.ts";
export { encodeText, decodeTextChunk, flushDecoder } from "./text.ts";
export type * from "./types.ts";
export { subscribeLines } from "./protocols/line.ts";

type RuntimeWindow = Window & {
  __HEP_WEB_SERIAL_RUNTIME__?: ReturnType<typeof createSerialRuntime>;
};

export function getSerialRuntime() {
  const runtimeWindow = window as RuntimeWindow;
  if (!runtimeWindow.__HEP_WEB_SERIAL_RUNTIME__) {
    runtimeWindow.__HEP_WEB_SERIAL_RUNTIME__ = createSerialRuntime();
  }
  return runtimeWindow.__HEP_WEB_SERIAL_RUNTIME__;
}
