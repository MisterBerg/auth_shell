import type {
  SerialPortId,
  SerialRuntime,
  SerialTextListener,
} from "../types.ts";

export type LineListener = (line: string) => void;

export function subscribeLines(
  runtime: SerialRuntime,
  portId: SerialPortId,
  onLine: LineListener,
  options?: {
    keepTrailingEmpty?: boolean;
  }
): () => void {
  let buffer = "";
  const keepTrailingEmpty = options?.keepTrailingEmpty ?? false;

  const handleText: SerialTextListener = (text) => {
    buffer += text;
    const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const parts = normalized.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (part.length > 0 || keepTrailingEmpty) onLine(part);
    }
  };

  const unsubscribe = runtime.subscribeText(portId, handleText);
  return () => {
    unsubscribe();
    if (buffer.length > 0 || keepTrailingEmpty) onLine(buffer);
    buffer = "";
  };
}
