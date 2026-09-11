/**
 * agent-log-server.ts
 *
 * A tiny, standalone HTTP server whose only job is printing agent-chat's OpenAI traffic to this
 * process's console. Deliberately separate from agent-bridge.ts: the bridge grants real local
 * capabilities (filesystem, shell, Python, TCP/HTTP device access) and is optional — a project can
 * run agent-chat with local runtime disabled. Watching what the model is sent and sent back is a
 * different, unrelated concern and shouldn't require opting into any of that, and shouldn't put
 * chat's core ability to talk to the model behind whether some other local process happens to be
 * up. So this has no RPC dispatch, no filesystem access, nothing dangerous — just one endpoint that
 * accepts a JSON blob and logs it. agent-chat calls it fire-and-forget (see mirrorToLogServer in
 * index.tsx): if this process isn't running, that fetch just fails silently and chat is unaffected.
 *
 * Prints exactly two things, unedited: every item in INPUT (what was sent to the model) and every
 * item in OUTPUT (what came back), one item per line as compact JSON straight from the API — no
 * relabeling, no guessing which tool call a result belongs to, no dropping any item type. The only
 * things left out are the response-level bookkeeping fields (id, created_at, usage, status, ...)
 * that describe the API call, not the model's input/output. A prior version of this file tried to
 * reformat these into a "User: ... / Assistant: ..." narrative — don't reintroduce that; it invents
 * structure the data doesn't actually assert (e.g. inferring a tool result's name from a call_id
 * lookup) and makes it impossible to tell whether what you're reading is what actually happened.
 *
 * Usage:
 *   npm run agent:log-server
 *   (already started automatically by `npm run run:local`, sharing that terminal)
 *
 * Env:
 *   AGENT_LOG_SERVER_PORT   default 4318
 */

import { appendFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { createServer, type IncomingMessage, type ServerResponse } from "http";

const PORT = Number(process.env["AGENT_LOG_SERVER_PORT"] ?? "4318");
const HOST = "127.0.0.1";

const logFilePath = resolve(join("logs", "agent-log-server", `${new Date().toISOString().replace(/[:.]/g, "-")}.log`));
mkdirSync(join(logFilePath, ".."), { recursive: true });

function isAllowedOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(origin);
}

function addCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text.trim() ? JSON.parse(text) : {};
}

type AnyItem = Record<string, unknown>;

function logEntry(entry: Record<string, unknown>): void {
  const at = typeof entry["at"] === "string" ? entry["at"] : new Date().toISOString();
  const model = entry["model"] ?? "?";
  const status = entry["status"] ?? "?";
  const instructions = typeof entry["instructions"] === "string" ? entry["instructions"] : "";
  const input = Array.isArray(entry["input"]) ? entry["input"] : [];
  const response = (entry["response"] ?? {}) as AnyItem;
  const output = Array.isArray(response["output"]) ? response["output"] : [];
  const outputText = typeof response["output_text"] === "string" ? response["output_text"] : "";
  const apiError = (response["error"] as { message?: string } | undefined)?.message;

  const lines: string[] = [];
  lines.push(`\n${"=".repeat(8)} agent-chat OpenAI call — ${at} ${"=".repeat(8)}`);
  lines.push(`model=${model}  status=${status}`);
  lines.push(`--- INSTRUCTIONS sent to the model ---`);
  lines.push(instructions);
  lines.push(`--- INPUT sent to the model (${input.length} item(s)) ---`);
  for (const item of input) lines.push(JSON.stringify(item));
  lines.push(`--- OUTPUT received from the model (${output.length} item(s)) ---`);
  for (const item of output) lines.push(JSON.stringify(item));
  if (outputText) lines.push(`--- output_text ---\n${outputText}`);
  if (apiError) lines.push(`--- API ERROR ---\n${apiError}`);

  const body = lines.join("\n");
  appendFileSync(logFilePath, `${body}\n`);
  console.log(body);
}

createServer(async (req, res) => {
  try {
    addCors(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "Jeffspace agent log server" }));
      return;
    }

    if (req.method === "POST" && req.url === "/log") {
      const body = (await readJson(req)) as Record<string, unknown>;
      logEntry(body);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Not found." }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[agent-log-server] error handling request: ${message}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: message }));
  }
}).listen(PORT, HOST, () => {
  console.log(`[agent-log-server] listening on http://${HOST}:${PORT}`);
  console.log(`[agent-log-server] transcript also being written to: ${logFilePath}`);
  console.log("[agent-log-server] agent-chat OpenAI calls will print here as a plain-text transcript.");
});
