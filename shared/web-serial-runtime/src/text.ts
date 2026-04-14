export function decodeTextChunk(
  decoder: TextDecoder,
  chunk: Uint8Array
): string {
  return decoder.decode(chunk, { stream: true });
}

export function flushDecoder(decoder: TextDecoder): string {
  return decoder.decode();
}

export function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
