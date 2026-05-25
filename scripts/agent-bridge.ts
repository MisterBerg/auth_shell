import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { promises as fs } from "fs";
import { execFileSync, spawn } from "child_process";
import { dirname, extname, isAbsolute, resolve, join } from "path";
import { pathToFileURL } from "url";
import { randomUUID } from "crypto";
import { homedir } from "os";

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
let workspaceRoot = process.env["AGENT_BRIDGE_WORKSPACE_ROOT"]?.trim()
  ? resolve(process.env["AGENT_BRIDGE_WORKSPACE_ROOT"]!)
  : null;
const bridgeStateRoot = resolve(process.env["AGENT_BRIDGE_STATE_ROOT"] ?? join(process.cwd(), ".agent-bridge"));
const pythonStateRoot = resolve(process.env["AGENT_BRIDGE_PYTHON_ROOT"] ?? join(bridgeStateRoot, "python"));
const defaultBrowseRoot = resolve(process.env["AGENT_BRIDGE_BROWSE_ROOT"] ?? homedir());
const allowedOrigins = new Set(
  (process.env["AGENT_BRIDGE_ALLOWED_ORIGINS"] ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

type PythonAllowlistEntry = {
  version: string;
  importName: string;
  description: string;
};

const PYTHON_ALLOWLIST: Record<string, PythonAllowlistEntry> = {
  beautifulsoup4: {
    version: "4.13.5",
    importName: "bs4",
    description: "HTML and XML parsing",
  },
  lxml: {
    version: "6.0.1",
    importName: "lxml",
    description: "Fast HTML and XML parsing",
  },
  openpyxl: {
    version: "3.1.5",
    importName: "openpyxl",
    description: "Excel workbook parsing",
  },
  pandas: {
    version: "2.3.3",
    importName: "pandas",
    description: "Tabular data analysis",
  },
  pillow: {
    version: "11.3.0",
    importName: "PIL",
    description: "Image processing",
  },
  pypdf: {
    version: "6.1.3",
    importName: "pypdf",
    description: "PDF text and structure parsing",
  },
  "python-docx": {
    version: "1.2.0",
    importName: "docx",
    description: "Word document parsing",
  },
  requests: {
    version: "2.32.5",
    importName: "requests",
    description: "HTTP client",
  },
};

type PythonCommand = {
  command: string;
  args: string[];
};

type CommandResult = {
  cwd: string;
  command: string;
  exitCode: number;
  signal: string | null;
  stdout: string;
  stderr: string;
};

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
          browseStartPath: defaultBrowseRoot,
          methods: [
            "get_bridge_status",
            "set_workspace_root",
            "list_workspace_files",
            "create_directory",
            "read_workspace_file",
            "write_workspace_file",
            "run_workspace_command",
            "get_python_environment",
            "check_python_dependencies",
            "install_python_dependencies",
            "run_python_script",
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
  console.log(`[agent-bridge] workspace root: ${workspaceRoot ?? "<unset>"}`);
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
    case "write_workspace_file":
      return writeWorkspaceFile(body.params);
    case "run_workspace_command":
      return runWorkspaceCommand(body.params);
    case "get_python_environment":
      return getPythonEnvironment();
    case "check_python_dependencies":
      return checkPythonDependencies(body.params);
    case "install_python_dependencies":
      return installPythonDependencies(body.params);
    case "run_python_script":
      return runPythonScript(body.params);
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
  if (isAbsolute(inputPath)) return resolve(inputPath);
  if (!workspaceRoot) {
    throw new Error("Workspace root is not set.");
  }
  return resolve(workspaceRoot, inputPath);
}

function getBridgeStatus(): unknown {
  return {
    status: "ok",
    workspaceRoot,
    pythonRoot: pythonStateRoot,
    browseStartPath: defaultBrowseRoot,
  };
}

async function setWorkspaceRoot(params: Record<string, unknown> = {}): Promise<unknown> {
  const rawPath = typeof params["path"] === "string" ? params["path"].trim() : "";
  if (!rawPath) {
    throw new Error("Workspace root path is required.");
  }
  const nextRoot = isAbsolute(rawPath)
    ? resolve(rawPath)
    : workspaceRoot
      ? resolve(workspaceRoot, rawPath)
      : resolve(defaultBrowseRoot, rawPath);
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
  const pathParam = typeof params["path"] === "string" ? params["path"].trim() : "";
  const target = pathParam
    ? resolvePath(pathParam)
    : (workspaceRoot ?? defaultBrowseRoot);
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
  const parentParam = typeof params["parentPath"] === "string" ? params["parentPath"].trim() : "";
  const parentPath = parentParam
    ? resolvePath(parentParam)
    : (workspaceRoot ?? defaultBrowseRoot);
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

async function writeWorkspaceFile(params: Record<string, unknown> = {}): Promise<unknown> {
  const target = resolvePath(params["path"]);
  const content = typeof params["content"] === "string" ? params["content"] : "";
  const encoding = params["encoding"] === "base64" ? "base64" : "utf8";
  const mode = params["mode"] === "append" ? "append" : "overwrite";
  await fs.mkdir(dirname(target), { recursive: true });

  if (mode === "append") {
    await fs.appendFile(target, content, encoding === "base64" ? { encoding: "base64" } : { encoding: "utf8" });
  } else {
    await fs.writeFile(target, content, encoding === "base64" ? { encoding: "base64" } : { encoding: "utf8" });
  }

  const stats = await fs.stat(target);
  return {
    status: "ok",
    path: target,
    sizeBytes: stats.size,
    mode,
    encoding,
  };
}

async function runWorkspaceCommand(params: Record<string, unknown> = {}): Promise<unknown> {
  const command = typeof params["command"] === "string" ? params["command"].trim() : "";
  if (!command) throw new Error("Command is required.");
  const cwd = params["cwd"] ? resolvePath(params["cwd"]) : workspaceRoot;
  if (!cwd) {
    throw new Error("Workspace root is not set.");
  }
  const timeoutMs = clampNumber(params["timeoutMs"], 100, 600000, 120000);
  const shellSpec = getWorkspaceShellCommand(command);

  console.log(
    `[agent-bridge] run_workspace_command start shell="${shellSpec.label}" cwd="${cwd}" command="${command}"`
  );

  const result = await spawnCommand({
    command: shellSpec.command,
    args: shellSpec.args,
    cwd,
    timeoutMs,
  });

  if (shellSpec.label === "powershell" && result.stderr.trim()) {
    console.log("[agent-bridge] run_workspace_command powershell stderr detected");
    throw new Error(
      [
        "PowerShell command reported an error on stderr.",
        `cwd: ${cwd}`,
        `command: ${command}`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
      ].filter(Boolean).join("\n")
    );
  }

  if (result.exitCode !== 0) {
    console.log(`[agent-bridge] run_workspace_command fail exit=${result.exitCode} signal=${result.signal ?? "none"}`);
    throw new Error(
      [
        `Command failed with exit code ${result.exitCode}.`,
        `cwd: ${cwd}`,
        `command: ${command}`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
      ].filter(Boolean).join("\n")
    );
  }

  console.log(`[agent-bridge] run_workspace_command ok exit=${result.exitCode}`);
  return result;
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

function getWorkspaceShellCommand(command: string): { label: string; command: string; args: string[] } {
  if (process.platform === "win32") {
    const unwrapped = unwrapNestedPowerShellCommand(command);
    return {
      label: "powershell",
      command: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-Command", unwrapped],
    };
  }

  return {
    label: "sh",
    command: "sh",
    args: ["-lc", command],
  };
}

function unwrapNestedPowerShellCommand(command: string): string {
  const trimmed = command.trim();
  const match = trimmed.match(/^(?:powershell|pwsh)(?:\.exe)?\s+(.*)$/i);
  if (!match) return trimmed;

  const remainder = match[1]?.trim() ?? "";
  const commandArgMatch = remainder.match(/^(?:-NoProfile\s+)?(?:-NonInteractive\s+)?-Command\s+([\s\S]+)$/i);
  if (!commandArgMatch) return trimmed;

  const rawScript = commandArgMatch[1]?.trim() ?? "";
  if (
    (rawScript.startsWith("\"") && rawScript.endsWith("\"")) ||
    (rawScript.startsWith("'") && rawScript.endsWith("'"))
  ) {
    return rawScript.slice(1, -1);
  }
  return rawScript;
}

function normalizePackageName(value: string): string {
  return value.trim().toLowerCase();
}

function getRequestedPackages(params: Record<string, unknown> = {}): string[] {
  const raw = Array.isArray(params["packages"]) ? params["packages"] : [];
  const names = raw
    .filter((value): value is string => typeof value === "string")
    .map(normalizePackageName)
    .filter(Boolean);

  if (!names.length) {
    throw new Error("At least one package name is required.");
  }

  return [...new Set(names)];
}

function getPythonEnvironmentPaths(): { root: string; scriptsRoot: string; pythonPath: string } {
  const scriptsRoot = process.platform === "win32"
    ? join(pythonStateRoot, "Scripts")
    : join(pythonStateRoot, "bin");
  const pythonPath = process.platform === "win32"
    ? join(scriptsRoot, "python.exe")
    : join(scriptsRoot, "python");
  return {
    root: pythonStateRoot,
    scriptsRoot,
    pythonPath,
  };
}

function getBootstrapPythonCommand(): PythonCommand {
  const override = process.env["AGENT_BRIDGE_PYTHON"];
  if (override?.trim()) {
    return { command: override.trim(), args: [] };
  }

  const candidates: PythonCommand[] = process.platform === "win32"
    ? [
        { command: "py", args: ["-3"] },
        { command: "python", args: [] },
        { command: "python3", args: [] },
      ]
    : [
        { command: "python3", args: [] },
        { command: "python", args: [] },
      ];

  for (const candidate of candidates) {
    try {
      execFileSync(candidate.command, [...candidate.args, "--version"], { stdio: "pipe" });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error("No usable Python interpreter was found. Install Python 3 or set AGENT_BRIDGE_PYTHON.");
}

async function ensurePythonEnvironment(): Promise<{ root: string; scriptsRoot: string; pythonPath: string; bootstrap: PythonCommand }> {
  const envPaths = getPythonEnvironmentPaths();
  await fs.mkdir(bridgeStateRoot, { recursive: true });

  try {
    await fs.access(envPaths.pythonPath);
  } catch {
    const bootstrap = getBootstrapPythonCommand();
    console.log(`[agent-bridge] creating managed python environment at ${envPaths.root}`);
    const createResult = await spawnCommand({
      command: bootstrap.command,
      args: [...bootstrap.args, "-m", "venv", envPaths.root],
      cwd: bridgeStateRoot,
      timeoutMs: 240000,
    });
    if (createResult.exitCode !== 0) {
      throw new Error(
        [
          "Failed to create the managed Python environment.",
          createResult.stdout ? `stdout:\n${createResult.stdout}` : "",
          createResult.stderr ? `stderr:\n${createResult.stderr}` : "",
        ].filter(Boolean).join("\n")
      );
    }
  }

  return {
    ...envPaths,
    bootstrap: getBootstrapPythonCommand(),
  };
}

async function getPythonEnvironment(): Promise<unknown> {
  const envInfo = await ensurePythonEnvironment();
  const versionResult = await spawnCommand({
    command: envInfo.pythonPath,
    args: ["--version"],
    cwd: bridgeStateRoot,
    timeoutMs: 20000,
  });
  if (versionResult.exitCode !== 0) {
    throw new Error(versionResult.stderr || versionResult.stdout || "Unable to read Python version.");
  }

  return {
    status: "ok",
    root: envInfo.root,
    pythonPath: envInfo.pythonPath,
    version: (versionResult.stdout || versionResult.stderr).trim(),
    allowlist: Object.entries(PYTHON_ALLOWLIST).map(([name, entry]) => ({
      package: name,
      version: entry.version,
      importName: entry.importName,
      description: entry.description,
    })),
  };
}

async function checkPythonDependencies(params: Record<string, unknown> = {}): Promise<unknown> {
  const envInfo = await ensurePythonEnvironment();
  const requested = getRequestedPackages(params);
  const unsupported = requested.filter((name) => !PYTHON_ALLOWLIST[name]);
  const allowed = requested.filter((name) => Boolean(PYTHON_ALLOWLIST[name]));

  const script = [
    "import importlib.metadata",
    "import json",
    "packages = json.loads(" + JSON.stringify(JSON.stringify(allowed)) + ")",
    "results = []",
    "for package in packages:",
    "    try:",
    "        version = importlib.metadata.version(package)",
    "        results.append({'package': package, 'installed': True, 'installedVersion': version})",
    "    except importlib.metadata.PackageNotFoundError:",
    "        results.append({'package': package, 'installed': False, 'installedVersion': None})",
    "print(json.dumps(results))",
  ].join("\n");

  const result = allowed.length
    ? await spawnCommand({
        command: envInfo.pythonPath,
        args: ["-c", script],
        cwd: bridgeStateRoot,
        timeoutMs: 30000,
      })
    : {
        cwd: bridgeStateRoot,
        command: envInfo.pythonPath,
        exitCode: 0,
        signal: null,
        stdout: "[]",
        stderr: "",
      } satisfies CommandResult;

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to inspect Python dependencies.");
  }

  const installed = JSON.parse(result.stdout || "[]") as Array<{
    package: string;
    installed: boolean;
    installedVersion: string | null;
  }>;

  return {
    requested,
    unsupported,
    packages: installed.map((entry) => ({
      package: entry.package,
      installed: entry.installed,
      installedVersion: entry.installedVersion,
      pinnedVersion: PYTHON_ALLOWLIST[entry.package]?.version ?? null,
      importName: PYTHON_ALLOWLIST[entry.package]?.importName ?? null,
    })),
  };
}

async function installPythonDependencies(params: Record<string, unknown> = {}): Promise<unknown> {
  const envInfo = await ensurePythonEnvironment();
  const requested = getRequestedPackages(params);
  const unsupported = requested.filter((name) => !PYTHON_ALLOWLIST[name]);
  if (unsupported.length) {
    throw new Error(
      `These Python packages are not on the approved allowlist: ${unsupported.join(", ")}.`
    );
  }

  const pipUpgrade = await spawnCommand({
    command: envInfo.pythonPath,
    args: ["-m", "pip", "install", "--upgrade", "pip"],
    cwd: bridgeStateRoot,
    timeoutMs: 240000,
  });
  if (pipUpgrade.exitCode !== 0) {
    throw new Error(
      [
        "Failed to upgrade pip in the managed environment.",
        pipUpgrade.stdout ? `stdout:\n${pipUpgrade.stdout}` : "",
        pipUpgrade.stderr ? `stderr:\n${pipUpgrade.stderr}` : "",
      ].filter(Boolean).join("\n")
    );
  }

  const specs = requested.map((name) => `${name}==${PYTHON_ALLOWLIST[name]!.version}`);
  const installResult = await spawnCommand({
    command: envInfo.pythonPath,
    args: ["-m", "pip", "install", ...specs],
    cwd: bridgeStateRoot,
    timeoutMs: 600000,
  });
  if (installResult.exitCode !== 0) {
    throw new Error(
      [
        "Failed to install approved Python dependencies.",
        `packages: ${specs.join(", ")}`,
        installResult.stdout ? `stdout:\n${installResult.stdout}` : "",
        installResult.stderr ? `stderr:\n${installResult.stderr}` : "",
      ].filter(Boolean).join("\n")
    );
  }

  return {
    status: "ok",
    root: envInfo.root,
    installed: requested.map((name) => ({
      package: name,
      version: PYTHON_ALLOWLIST[name]!.version,
      importName: PYTHON_ALLOWLIST[name]!.importName,
    })),
    stdout: installResult.stdout,
    stderr: installResult.stderr,
  };
}

async function runPythonScript(params: Record<string, unknown> = {}): Promise<unknown> {
  const envInfo = await ensurePythonEnvironment();
  const script = typeof params["script"] === "string" ? params["script"] : "";
  if (!script.trim()) {
    throw new Error("Python script content is required.");
  }

  const cwd = params["cwd"] ? resolvePath(params["cwd"]) : workspaceRoot;
  if (!cwd) {
    throw new Error("Workspace root is not set.");
  }
  const timeoutMs = clampNumber(params["timeoutMs"], 100, 600000, 120000);
  const tempDir = join(bridgeStateRoot, "tmp");
  await fs.mkdir(tempDir, { recursive: true });
  const tempPath = join(tempDir, `agent-script-${Date.now()}-${randomUUID()}.py`);

  try {
    await fs.writeFile(tempPath, script, "utf8");
    const result = await spawnCommand({
      command: envInfo.pythonPath,
      args: [tempPath],
      cwd,
      timeoutMs,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        [
          `Python script failed with exit code ${result.exitCode}.`,
          `cwd: ${cwd}`,
          result.stdout ? `stdout:\n${result.stdout}` : "",
          result.stderr ? `stderr:\n${result.stderr}` : "",
        ].filter(Boolean).join("\n")
      );
    }
    return result;
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

async function spawnCommand(args: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  shell?: boolean;
}): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(args.command, args.args, {
      cwd: args.cwd,
      shell: args.shell ?? false,
      env: process.env,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, args.timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out after ${args.timeoutMs}ms.`));
        return;
      }
      resolveResult({
        cwd: args.cwd,
        command: [args.command, ...args.args].join(" "),
        exitCode: code ?? 0,
        signal: signal ?? null,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      });
    });
  });
}
