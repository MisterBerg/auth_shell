// Shared client for talking to local HTTP device adapters (e.g. the Thermal Master P3 server)
// over the agent bridge's execute_http_request / read_workspace_file RPCs. Used by both
// equipment-manager and test-manager so the two don't drift on parsing, error handling, or the
// convention these adapters use to describe a file they wrote to disk.

export type HttpRequestResult = {
  url?: string;
  method?: string;
  status?: number;
  statusText?: string;
  ok?: boolean;
  contentType?: string;
  text?: string;
  data?: string;
  bytesBase64?: string;
  bytesLength?: number;
  durationMs?: number;
};

/** Matches each module's own callBridge(bridge, method, params) once the bridge is bound in. */
export type RpcCaller = <T>(method: string, params: Record<string, unknown>) => Promise<T>;

/** Splits a spec-style payload like "POST http://127.0.0.1:47121/v1/captures/image" into parts. */
export function parseHttpCommandPayload(payload: string): { method: string; url: string } {
  const trimmed = payload.trim();
  const match = trimmed.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(.+)$/i);
  if (match) return { method: match[1]!.toUpperCase(), url: match[2]!.trim() };
  return { method: "GET", url: trimmed };
}

/** Parses JSON text into a plain object; anything else (null, an array, unparseable text) becomes {}. */
export function parseJsonObject(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

/** Dot-path lookup into a parsed JSON object, e.g. getJsonPathValue(parsed, "metadata.status"). */
export function getJsonPathValue(value: unknown, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export type HttpDeviceArtifact = {
  /** Absolute path the adapter reported, as read back via read_workspace_file. */
  path: string;
  artifactType: string;
  mimeType: string;
  bytesBase64: string;
};

export type HttpDeviceCommandOutcome = {
  result: HttpRequestResult;
  parsed: Record<string, unknown>;
  /** True when the raw response body was the literal JSON value `null` (e.g. "stop" with nothing active). */
  isNullBody: boolean;
  /** Set when the response described a ready file (a `path`, not still `metadata.status: "recording"`) and it was fetched. */
  artifact?: HttpDeviceArtifact;
};

/**
 * Runs an http-mode instrument command end to end: parses the "METHOD url" payload, calls
 * execute_http_request, throws a descriptive Error on a non-2xx response, and — when the JSON
 * response describes a ready file (a `path` field, and `metadata.status` isn't `"recording"`) —
 * fetches its bytes via read_workspace_file. The artifact convention (path/artifact_type/
 * mime_type/metadata.status) matches the Thermal Master P3 server's ArtifactResponse shape.
 */
export async function executeHttpDeviceCommand(
  rpc: RpcCaller,
  commandLabel: string,
  payload: string,
  body: string | undefined,
  timeoutMs: number,
): Promise<HttpDeviceCommandOutcome> {
  const { method, url } = parseHttpCommandPayload(payload);
  if (!url) throw new Error(`HTTP command "${commandLabel}" does not define a URL.`);
  const result = await rpc<HttpRequestResult>("execute_http_request", {
    method,
    url,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body || undefined,
    timeoutMs,
  });
  const succeeded = result.ok ?? (typeof result.status === "number" && result.status >= 200 && result.status < 300);
  const isNullBody = result.text?.trim() === "null";
  const parsed = result.text && !isNullBody ? parseJsonObject(result.text) : {};
  if (!succeeded) {
    const detail = String(getJsonPathValue(parsed, "detail") ?? "") || result.text || result.statusText || "";
    throw new Error(`${commandLabel} failed (HTTP ${result.status ?? "?"}${result.statusText ? ` ${result.statusText}` : ""})${detail ? `: ${detail}` : "."}`);
  }
  const path = String(getJsonPathValue(parsed, "path") ?? "");
  const recordingStatus = String(getJsonPathValue(parsed, "metadata.status") ?? "");
  if (!path || recordingStatus === "recording") {
    return { result, parsed, isNullBody };
  }
  const fileResult = await rpc<{ path: string; encoding: string; content: string }>("read_workspace_file", {
    path,
    encoding: "base64",
  });
  return {
    result,
    parsed,
    isNullBody,
    artifact: {
      path,
      artifactType: String(getJsonPathValue(parsed, "artifact_type") ?? ""),
      mimeType: String(getJsonPathValue(parsed, "mime_type") ?? ""),
      bytesBase64: fileResult.content,
    },
  };
}
