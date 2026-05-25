import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import { extname, isAbsolute, resolve, join } from "path";
import { pathToFileURL } from "url";

type RpcRequest = {
  method?: string;
  params?: Record<string, unknown>;
};

type RpcSuccess = {
  ok: true;
  result: unknown;
};

type RpcFailure = {
  ok: false;
  error: string;
};

const PORT = Number(process.env["AGENT_BRIDGE_PORT"] ?? "4317");
const HOST = "127.0.0.1";
const TOKEN = process.env["AGENT_BRIDGE_TOKEN"] ?? "";
let workspaceRoot = resolve(process.env["AGENT_BRIDGE_WORKSPACE_ROOT"] ?? process.cwd());
const allowedOrigins = new Set(
  (process.env["AGENT_BRIDGE_ALLOWED_ORIGINS"] ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

if (!TOKEN) {
  throw new Error("AGENT_BRIDGE_TOKEN is required.");
}

createServer(async (req, res) => {
  try {
    addCors(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    validateOrigin(req);
    validateToken(req);

    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, {
        ok: true,
        result: {
          status: "ok",
          workspaceRoot,
          methods: [
            "get_bridge_status",
            "set_workspace_root",
            "list_workspace_files",
            "create_directory",
            "read_workspace_file",
            "run_workspace_command",
            "extract_pdf_text",
          ],
        },
      } satisfies RpcSuccess);
      return;
    }

    if (req.method === "POST" && req.url === "/rpc") {
      const body = (await readJson(req)) as RpcRequest;
      const result = await runRpc(body);
      sendJson(res, 200, { ok: true, result } satisfies RpcSuccess);
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found." } satisfies RpcFailure);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { ok: false, error: message } satisfies RpcFailure);
  }
}).listen(PORT, HOST, () => {
  console.log(`[agent-bridge] listening on http://${HOST}:${PORT}`);
  console.log(`[agent-bridge] workspace root: ${workspaceRoot}`);
});

async function runRpc(body: RpcRequest): Promise<unknown> {
  switch (body.method) {
    case "get_bridge_status":
      return getBridgeStatus();
    case "set_workspace_root":
      return setWorkspaceRoot(body.params);
    case "list_workspace_files":
      return listWorkspaceFiles(body.params);
    case "create_directory":
      return createDirectory(body.params);
    case "read_workspace_file":
      return readWorkspaceFile(body.params);
    case "run_workspace_command":
      return runWorkspaceCommand(body.params);
    case "extract_pdf_text":
      return extractPdfText(body.params);
    default:
      throw new Error(`Unsupported RPC method: ${body.method ?? "unknown"}`);
  }
}

function addCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function validateOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (!origin) return;
  if (!isAllowedOrigin(origin)) {
    throw new Error(`Origin not allowed: ${origin}`);
  }
}

function isAllowedOrigin(origin: string): boolean {
  if (allowedOrigins.has(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(origin);
}

function validateToken(req: IncomingMessage): void {
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${TOKEN}`) {
    throw new Error("Unauthorized.");
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text ? JSON.parse(text) : {};
}

function sendJson(res: ServerResponse, statusCode: number, payload: RpcSuccess | RpcFailure): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function resolvePath(inputPath: unknown): string {
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    throw new Error("A non-empty path is required.");
  }
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(workspaceRoot, inputPath);
}

function getBridgeStatus(): unknown {
  return {
    status: "ok",
    workspaceRoot,
  };
}

async function setWorkspaceRoot(params: Record<string, unknown> = {}): Promise<unknown> {
  const nextRoot = resolvePath(params["path"]);
  const stats = await fs.stat(nextRoot);
  if (!stats.isDirectory()) {
    throw new Error("Workspace root must be a directory.");
  }
  workspaceRoot = nextRoot;
  return {
    status: "ok",
    workspaceRoot,
  };
}

async function listWorkspaceFiles(params: Record<string, unknown> = {}): Promise<unknown> {
  const target = resolvePath(typeof params["path"] === "string" ? params["path"] : ".");
  const recursive = params["recursive"] === true;
  const limit = clampNumber(params["limit"], 1, 1000, 200);
  const files: Array<{ path: string; kind: "file" | "directory"; sizeBytes?: number }> = [];

  async function visit(currentPath: string): Promise<void> {
    if (files.length >= limit) return;
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= limit) return;
      const fullPath = join(currentPath, entry.name);
      const relative = fullPath.startsWith(currentPath)
        ? fullPath.slice(currentPath.length + 1).replaceAll("\\", "/")
        : fullPath.replaceAll("\\", "/");
      if (entry.isDirectory()) {
        files.push({ path: relative, kind: "directory" });
        if (recursive) {
          await visit(fullPath);
        }
      } else {
        const stats = await fs.stat(fullPath);
        files.push({ path: relative, kind: "file", sizeBytes: stats.size });
      }
    }
  }

  await visit(target);
  return {
    root: target,
    recursive,
    count: files.length,
    files,
  };
}

async function createDirectory(params: Record<string, unknown> = {}): Promise<unknown> {
  const parentPath = resolvePath(typeof params["parentPath"] === "string" ? params["parentPath"] : ".");
  const name = typeof params["name"] === "string" ? params["name"].trim() : "";
  if (!name) {
    throw new Error("Directory name is required.");
  }
  const target = join(parentPath, name);
  await fs.mkdir(target, { recursive: true });
  return {
    status: "ok",
    path: target,
  };
}

async function readWorkspaceFile(params: Record<string, unknown> = {}): Promise<unknown> {
  const target = resolvePath(params["path"]);
  const encoding = params["encoding"] === "base64" ? "base64" : "utf8";
  const buffer = await fs.readFile(target);
  return {
    path: target,
    encoding,
    content: encoding === "base64" ? buffer.toString("base64") : buffer.toString("utf-8"),
  };
}

async function runWorkspaceCommand(params: Record<string, unknown> = {}): Promise<unknown> {
  const command = typeof params["command"] === "string" ? params["command"].trim() : "";
  if (!command) throw new Error("Command is required.");
  const cwd = params["cwd"] ? resolvePath(params["cwd"]) : workspaceRoot;
  const timeoutMs = clampNumber(params["timeoutMs"], 100, 600000, 120000);

  return new Promise((resolveResult, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs}ms.`));
        return;
      }
      resolveResult({
        cwd,
        command,
        exitCode: code ?? 0,
        signal: signal ?? null,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      });
    });
  });
}

async function extractPdfText(params: Record<string, unknown> = {}): Promise<unknown> {
  const target = resolvePath(params["path"]);
  if (extname(target).toLowerCase() !== ".pdf") {
    throw new Error("extract_pdf_text requires a .pdf path.");
  }

  const maxPages = clampNumber(params["maxPages"], 1, 500, 50);
  const data = await fs.readFile(target);
  const pdfjs = await import(pathToFileURL(resolve("node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href);
  const document = await pdfjs.getDocument({ data: new Uint8Array(data), useWorkerFetch: false, isEvalSupported: false }).promise;

  const pages: Array<{ pageNumber: number; text: string }> = [];
  const pageCount = Math.min(document.numPages, maxPages);
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item: { str?: string }) => item.str ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push({ pageNumber, text });
  }

  return {
    path: target,
    pageCount: document.numPages,
    extractedPages: pages.length,
    pages,
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}
