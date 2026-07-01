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
const PROTOCOL_VERSION = 1;
const CAPABILITIES = [
  "filesystem",
  "shell",
  "python",
  "pdf_text",
  "workspace_root",
  "appspace_context",
  "appspace_operation_queue",
  "organizer_memory",
];

type AppspaceOperation = {
  id: string;
  operation: string;
  args: Record<string, unknown>;
  status: "queued" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
};

type AppspaceSession = {
  sessionId: string;
  updatedAt: string;
  context: Record<string, unknown>;
  operations: AppspaceOperation[];
};

type OrganizerTimingState = "overdue" | "upcoming" | "no-dates";

type OrganizerItem = {
  id: string;
  kind: string;
  title: string;
  details?: string;
  status: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
  dueAt?: string;
  followUpAt?: string;
  linkedWorkItemIds?: string[];
  objectiveIds?: string[];
  scopeIds?: string[];
};

type WorkScope = {
  id: string;
  title: string;
  scope?: string;
  status: string;
  parentScopeId?: string;
  subjects?: string[];
  notes?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
  targetAt?: string;
  linkedOrganizerItemIds?: string[];
  linkedWorkItemIds?: string[];
  linkedAssetIds?: string[];
};

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

const appspaceSessions = new Map<string, AppspaceSession>();

createServer(async (req, res) => {
  try {
    addCors(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    validateOrigin(req);

    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, {
        ok: true,
        result: {
          status: "ok",
          name: "Jeffspace local agent bridge",
          protocolVersion: PROTOCOL_VERSION,
          capabilities: CAPABILITIES,
          requiresPairingToken: Boolean(TOKEN),
        },
      } satisfies RpcSuccess);
      return;
    }

    if (req.method === "POST" && req.url === "/rpc") {
      validateToken(req);
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
    case "sync_appspace_context":
      return syncAppspaceContext(body.params);
    case "get_appspace_context":
      return getAppspaceContext(body.params);
    case "search_appspace_assets":
      return searchAppspaceAssets(body.params);
    case "get_organizer_overview":
      return getOrganizerOverview(body.params);
    case "list_work_scope_index":
      return listWorkScopeIndex(body.params);
    case "search_work_scope_graph":
      return searchWorkScopeGraph(body.params);
    case "get_work_scope_context":
      return getWorkScopeContext(body.params);
    case "create_work_scopes":
      return createWorkScopes(body.params);
    case "replace_organizer_store":
      return replaceOrganizerStore(body.params);
    case "update_work_scope":
      return updateWorkScope(body.params);
    case "archive_work_scope":
      return archiveWorkScope(body.params);
    case "list_organizer_items":
      return listOrganizerItems(body.params);
    case "create_organizer_items":
      return createOrganizerItems(body.params);
    case "upsert_sweep_review":
      return upsertSweepReview(body.params);
    case "batch_update_organizer_items":
      return batchUpdateOrganizerItems(body.params);
    case "mark_organizer_items_complete":
      return markOrganizerItemsComplete(body.params);
    case "queue_appspace_operation":
      return queueAppspaceOperation(body.params);
    case "list_appspace_operations":
      return listAppspaceOperations(body.params);
    case "complete_appspace_operation":
      return completeAppspaceOperation(body.params);
    default:
      throw new Error(`Unsupported RPC method: ${body.method ?? "unknown"}`);
  }
}

function addCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    if (req.headers["access-control-request-private-network"] === "true") {
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
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
  return (
    /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(origin) ||
    /^https:\/\/[a-z0-9-]+\.cloudfront\.net$/i.test(origin)
  );
}

function validateToken(req: IncomingMessage): void {
  if (!TOKEN) return;
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
    appspaceSessions: [...appspaceSessions.values()].map((session) => ({
      sessionId: session.sessionId,
      updatedAt: session.updatedAt,
      queuedOperationCount: session.operations.filter((operation) => operation.status === "queued").length,
    })),
  };
}

function readSessionId(params: Record<string, unknown> = {}, fallbackLatest = true): string {
  const raw = typeof params["sessionId"] === "string" ? params["sessionId"].trim() : "";
  if (raw) return raw;
  if (fallbackLatest) {
    const latest = [...appspaceSessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (latest) return latest.sessionId;
    throw new Error(
      "No appspace session is synced. The bridge service is running, but Jeffspace must be open with the chat module local runtime enabled before appspace context is available."
    );
  }
  throw new Error("sessionId is required.");
}

function getSession(params: Record<string, unknown> = {}, fallbackLatest = true): AppspaceSession {
  const sessionId = readSessionId(params, fallbackLatest);
  const session = appspaceSessions.get(sessionId);
  if (!session) {
    throw new Error(`No appspace session is registered for ${sessionId}.`);
  }
  return session;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function syncAppspaceContext(params: Record<string, unknown> = {}): unknown {
  const sessionId = readSessionId(params, false);
  const context = readRecord(params["context"], "context");
  const now = new Date().toISOString();
  const existing = appspaceSessions.get(sessionId);
  const operations = existing?.operations ?? [];
  const project = readOptionalRecord(context["project"]);
  console.log(
    `[agent-bridge] sync_appspace_context session=${sessionId} project=${String(project?.["projectId"] ?? "<unknown>")} keys=${Object.keys(context).length}`
  );
  appspaceSessions.set(sessionId, {
    sessionId,
    updatedAt: now,
    context,
    operations,
  });
  return {
    status: "ok",
    sessionId,
    updatedAt: now,
    queuedOperationCount: operations.filter((operation) => operation.status === "queued").length,
  };
}

function readOptionalRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getAppspaceContext(params: Record<string, unknown> = {}): unknown {
  const session = getSession(params);
  return {
    sessionId: session.sessionId,
    updatedAt: session.updatedAt,
    context: session.context,
  };
}

function searchAppspaceAssets(params: Record<string, unknown> = {}): unknown {
  const session = getSession(params);
  const query = typeof params["query"] === "string" ? params["query"].trim().toLowerCase() : "";
  const limit = clampNumber(params["limit"], 1, 200, 25);
  const assets = Array.isArray(session.context["assets"])
    ? session.context["assets"] as unknown[]
    : [];
  const matches = assets
    .map((asset) => {
      const text = JSON.stringify(asset).toLowerCase();
      let score = query ? 0 : 1;
      if (query && text.includes(query)) score += 25;
      for (const token of query.split(/\s+/).filter(Boolean)) {
        if (text.includes(token)) score += 10;
      }
      return { asset, score };
    })
    .filter((entry) => !query || entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.asset);

  return {
    sessionId: session.sessionId,
    query,
    count: matches.length,
    assets: matches,
  };
}

function readOrganizerItemsFromSession(session: AppspaceSession): OrganizerItem[] {
  const organizer = session.context["organizer"];
  if (!organizer || typeof organizer !== "object" || Array.isArray(organizer)) {
    throw new Error("Organizer context is not available in the synced appspace snapshot.");
  }
  const items = (organizer as Record<string, unknown>)["items"];
  if (!Array.isArray(items)) {
    throw new Error("Organizer items are not available in the synced appspace snapshot.");
  }
  return items.filter((item): item is OrganizerItem => Boolean(item && typeof item === "object"));
}

function readOrganizerScopesFromSession(session: AppspaceSession): WorkScope[] {
  const organizer = session.context["organizer"];
  if (!organizer || typeof organizer !== "object" || Array.isArray(organizer)) {
    throw new Error("Organizer context is not available in the synced appspace snapshot.");
  }
  const scopes = (organizer as Record<string, unknown>)["scopes"];
  if (!Array.isArray(scopes)) {
    return [];
  }
  return scopes.filter((scope): scope is WorkScope => Boolean(scope && typeof scope === "object"));
}

function readOrganizerSnapshot(params: Record<string, unknown> = {}): { session: AppspaceSession; scopes: WorkScope[]; items: OrganizerItem[] } {
  const session = getSession(params);
  return {
    session,
    scopes: readOrganizerScopesFromSession(session),
    items: readOrganizerItemsFromSession(session),
  };
}

function scopeExcerpt(scope: WorkScope): string {
  const text = [
    scope.scope ?? "",
    scope.notes ?? "",
    (scope.subjects ?? []).join(", "),
    (scope.tags ?? []).join(", "),
  ].filter(Boolean).join(" ");
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function itemScopeIds(item: OrganizerItem): string[] {
  return [...(item.scopeIds ?? []), ...(item.objectiveIds ?? [])];
}

function linkedItemsForScope(scope: WorkScope, items: OrganizerItem[]): OrganizerItem[] {
  const linkedIds = new Set(scope.linkedOrganizerItemIds ?? []);
  return items.filter((item) => itemScopeIds(item).includes(scope.id) || linkedIds.has(item.id));
}

function compactScopeRecord(scope: WorkScope, scopes: WorkScope[], items: OrganizerItem[]): Record<string, unknown> {
  return {
    scopeId: scope.id,
    title: scope.title,
    status: scope.status,
    parentScopeId: scope.parentScopeId,
    excerpt: scopeExcerpt(scope),
    childCount: scopes.filter((candidate) => candidate.parentScopeId === scope.id).length,
    linkedItemCount: linkedItemsForScope(scope, items).length,
  };
}

function scopeSearchText(scope: WorkScope, items: OrganizerItem[]): string {
  const linkedItems = linkedItemsForScope(scope, items);
  return [
    scope.id,
    scope.title,
    scope.status,
    scope.parentScopeId ?? "",
    scope.scope ?? "",
    scope.notes ?? "",
    (scope.subjects ?? []).join(" "),
    (scope.tags ?? []).join(" "),
    scope.targetAt ?? "",
    linkedItems.map((item) => [
      item.id,
      item.kind,
      item.title,
      item.details ?? "",
      item.status,
      (item.tags ?? []).join(" "),
      item.dueAt ?? "",
      item.followUpAt ?? "",
    ].join(" ")).join(" "),
  ].join(" ").toLowerCase();
}

function scoreScopeSearch(scope: WorkScope, items: OrganizerItem[], query: string): number {
  const terms = query.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean);
  if (!terms.length) return 1;
  const text = scopeSearchText(scope, items);
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) score += 10;
    if (scope.title.toLowerCase().includes(term)) score += 20;
    if ((scope.subjects ?? []).join(" ").toLowerCase().includes(term)) score += 12;
    if ((scope.tags ?? []).join(" ").toLowerCase().includes(term)) score += 8;
  }
  return score;
}

function getOrganizerOverview(params: Record<string, unknown> = {}): unknown {
  const { session, scopes, items } = readOrganizerSnapshot(params);
  const visibleScopes = scopes.filter((scope) => scope.status !== "archived");
  const visibleItems = items.filter((item) => item.status !== "archived");
  return {
    sessionId: session.sessionId,
    scopeCount: visibleScopes.length,
    itemCount: visibleItems.length,
    openItemCount: visibleItems.filter((item) => item.status === "open").length,
    activeItemCount: visibleItems.filter((item) => item.status === "active").length,
    waitingItemCount: visibleItems.filter((item) => item.kind === "waiting-on").length,
    scopes: visibleScopes.map((scope) => compactScopeRecord(scope, visibleScopes, visibleItems)),
    unassignedItems: visibleItems
      .filter((item) => itemScopeIds(item).length === 0)
      .map((item) => ({ id: item.id, kind: item.kind, title: item.title, status: item.status, excerpt: item.details?.slice(0, 220) ?? "" })),
  };
}

function listWorkScopeIndex(params: Record<string, unknown> = {}): unknown {
  const { session, scopes, items } = readOrganizerSnapshot(params);
  const includeArchived = params["includeArchived"] === true;
  const visibleScopes = scopes
    .filter((scope) => (includeArchived ? true : scope.status !== "archived"))
    .sort((a, b) => (a.parentScopeId ?? "").localeCompare(b.parentScopeId ?? "") || a.title.localeCompare(b.title));
  const visibleItems = items.filter((item) => item.status !== "archived");
  return {
    sessionId: session.sessionId,
    count: visibleScopes.length,
    index: visibleScopes.map((scope) => compactScopeRecord(scope, visibleScopes, visibleItems)),
  };
}

function searchWorkScopeGraph(params: Record<string, unknown> = {}): unknown {
  const { session, scopes, items } = readOrganizerSnapshot(params);
  const query = typeof params["query"] === "string" ? params["query"].trim() : "";
  if (!query) throw new Error("query is required.");
  const includeArchived = params["includeArchived"] === true;
  const visibleScopes = scopes.filter((scope) => (includeArchived ? true : scope.status !== "archived"));
  const visibleItems = items.filter((item) => item.status !== "archived");
  const results = visibleScopes
    .map((scope) => ({ scope, score: scoreScopeSearch(scope, visibleItems, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.scope.title.localeCompare(b.scope.title))
    .map((entry) => ({ ...compactScopeRecord(entry.scope, visibleScopes, visibleItems), score: entry.score }));
  return {
    sessionId: session.sessionId,
    query,
    count: results.length,
    results,
  };
}

function getWorkScopeContext(params: Record<string, unknown> = {}): unknown {
  const { session, scopes, items } = readOrganizerSnapshot(params);
  const scopeId = typeof params["scopeId"] === "string" ? params["scopeId"].trim() : "";
  if (!scopeId) throw new Error("scopeId is required.");
  const direction = params["direction"] === "self" || params["direction"] === "upstream" || params["direction"] === "downstream" || params["direction"] === "both"
    ? params["direction"]
    : "both";
  const depth = clampNumber(params["depth"], 0, 20, 3);
  const includeLinkedItems = params["includeLinkedItems"] !== false;
  const visibleScopes = scopes.filter((scope) => scope.status !== "archived");
  const byId = new Map(visibleScopes.map((scope) => [scope.id, scope]));
  const selected = byId.get(scopeId);
  if (!selected) throw new Error(`Work scope not found: ${scopeId}`);

  const upstream: WorkScope[] = [];
  let current = selected;
  while ((direction === "upstream" || direction === "both") && current.parentScopeId && upstream.length < depth) {
    const parent = byId.get(current.parentScopeId);
    if (!parent) break;
    upstream.unshift(parent);
    current = parent;
  }

  const downstream: WorkScope[] = [];
  if (direction === "downstream" || direction === "both") {
    const queue = [{ id: selected.id, depth: 0 }];
    while (queue.length) {
      const next = queue.shift()!;
      if (next.depth >= depth) continue;
      for (const child of visibleScopes.filter((scope) => scope.parentScopeId === next.id)) {
        downstream.push(child);
        queue.push({ id: child.id, depth: next.depth + 1 });
      }
    }
  }

  const contextScopes = direction === "self" ? [selected] : [...upstream, selected, ...downstream];
  const contextScopeIds = new Set(contextScopes.map((scope) => scope.id));
  const linkedItems = includeLinkedItems
    ? items.filter((item) => item.status !== "archived" && itemScopeIds(item).some((id) => contextScopeIds.has(id)))
    : [];

  return {
    sessionId: session.sessionId,
    selected,
    upstream,
    downstream,
    scopes: contextScopes,
    linkedItems,
  };
}

function getOrganizerAnchorDate(item: OrganizerItem): string | undefined {
  return item.dueAt ?? item.followUpAt;
}

function matchesOrganizerTimingState(
  item: OrganizerItem,
  timingState: OrganizerTimingState | undefined,
  now = Date.now(),
): boolean {
  if (!timingState) return true;
  const anchor = getOrganizerAnchorDate(item);
  if (timingState === "no-dates") {
    return !anchor;
  }
  if (!anchor) return false;
  if (item.status === "done" || item.status === "archived") {
    return false;
  }
  const anchorTime = new Date(anchor).getTime();
  if (Number.isNaN(anchorTime)) {
    return false;
  }
  return timingState === "overdue" ? anchorTime < now : anchorTime >= now;
}

function matchesText(haystack: string, query: string): boolean {
  if (!query.trim()) return true;
  return haystack.toLowerCase().includes(query.trim().toLowerCase());
}

function listOrganizerItems(params: Record<string, unknown> = {}): unknown {
  const session = getSession(params);
  const query = typeof params["query"] === "string" ? params["query"] : "";
  const kind = typeof params["kind"] === "string" ? params["kind"] : "";
  const status = typeof params["status"] === "string" ? params["status"] : "";
  const timingState = typeof params["timingState"] === "string"
    ? params["timingState"] as OrganizerTimingState
    : undefined;
  const includeArchived = params["includeArchived"] === true;
  const limit = clampNumber(params["limit"], 1, 200, 50);
  const items = readOrganizerItemsFromSession(session)
    .filter((item) => (includeArchived ? true : item.status !== "archived"))
    .filter((item) => (kind ? item.kind === kind : true))
    .filter((item) => (status ? item.status === status : true))
    .filter((item) => matchesOrganizerTimingState(item, timingState))
    .filter((item) => matchesText(JSON.stringify(item), query))
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, limit);
  return {
    sessionId: session.sessionId,
    count: items.length,
    totalVisible: readOrganizerItemsFromSession(session).filter((item) => item.status !== "archived").length,
    items,
  };
}

function queueSessionOperation(session: AppspaceSession, operation: string, args: Record<string, unknown>): AppspaceOperation {
  const now = new Date().toISOString();
  const queued: AppspaceOperation = {
    id: `op_${Date.now()}_${randomUUID()}`,
    operation,
    args,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  session.operations.push(queued);
  return queued;
}

async function waitForOperationCompletion(
  sessionId: string,
  operationId: string,
  timeoutMs = 20000,
  pollMs = 250,
): Promise<AppspaceOperation> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const session = appspaceSessions.get(sessionId);
    const operation = session?.operations.find((item) => item.id === operationId);
    if (!operation) {
      throw new Error(`Queued appspace operation disappeared: ${operationId}`);
    }
    if (operation.status === "completed" || operation.status === "failed") {
      return operation;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
  throw new Error(`Timed out waiting for appspace operation ${operationId}.`);
}

async function queueOrganizerMutationAndWait(
  params: Record<string, unknown>,
  operation: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const session = getSession(params);
  const queued = queueSessionOperation(session, operation, args);
  const timeoutMs = clampNumber(params["timeoutMs"], 1000, 120000, 20000);
  const completed = await waitForOperationCompletion(session.sessionId, queued.id, timeoutMs);
  if (completed.status === "failed") {
    throw new Error(completed.error ?? `Organizer operation failed: ${operation}`);
  }
  const result = completed.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    const output = typeof record["output"] === "string" ? record["output"] : "";
    if (output) {
      try {
        return JSON.parse(output) as unknown;
      } catch {
        return {
          ...record,
          output,
        };
      }
    }
  }
  return result ?? {
    status: "completed",
    sessionId: session.sessionId,
    operationId: queued.id,
  };
}

async function createWorkScopes(params: Record<string, unknown> = {}): Promise<unknown> {
  const scopes = Array.isArray(params["scopes"]) ? params["scopes"] : [];
  if (!scopes.length) {
    throw new Error("scopes must be a non-empty array.");
  }
  return queueOrganizerMutationAndWait(params, "create_work_scopes", { scopes });
}

async function replaceOrganizerStore(params: Record<string, unknown> = {}): Promise<unknown> {
  const scopes = Array.isArray(params["scopes"]) ? params["scopes"] : [];
  const items = Array.isArray(params["items"]) ? params["items"] : [];
  return queueOrganizerMutationAndWait(params, "replace_organizer_store", { scopes, items });
}

async function updateWorkScope(params: Record<string, unknown> = {}): Promise<unknown> {
  const scopeId = typeof params["scopeId"] === "string" ? params["scopeId"].trim() : "";
  if (!scopeId) {
    throw new Error("scopeId is required.");
  }
  const patch = params["patch"];
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("patch must be an object.");
  }
  return queueOrganizerMutationAndWait(params, "update_work_scope", { scopeId, patch });
}

async function archiveWorkScope(params: Record<string, unknown> = {}): Promise<unknown> {
  const scopeId = typeof params["scopeId"] === "string" ? params["scopeId"].trim() : "";
  if (!scopeId) {
    throw new Error("scopeId is required.");
  }
  return queueOrganizerMutationAndWait(params, "archive_work_scope", { scopeId });
}

async function createOrganizerItems(params: Record<string, unknown> = {}): Promise<unknown> {
  const items = Array.isArray(params["items"]) ? params["items"] : [];
  if (!items.length) {
    throw new Error("items must be a non-empty array.");
  }
  return queueOrganizerMutationAndWait(params, "create_organizer_items", { items });
}

async function upsertSweepReview(params: Record<string, unknown> = {}): Promise<unknown> {
  const statusUpdates = Array.isArray(params["statusUpdates"]) ? params["statusUpdates"] : [];
  const checklist = Array.isArray(params["checklist"]) ? params["checklist"] : [];
  return queueOrganizerMutationAndWait(params, "upsert_sweep_review", { statusUpdates, checklist });
}

async function batchUpdateOrganizerItems(params: Record<string, unknown> = {}): Promise<unknown> {
  const itemIds = Array.isArray(params["itemIds"]) ? params["itemIds"] : [];
  if (!itemIds.length) {
    throw new Error("itemIds must be a non-empty array.");
  }
  const patch = params["patch"];
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("patch must be an object.");
  }
  return queueOrganizerMutationAndWait(params, "batch_update_organizer_items", {
    itemIds,
    patch,
  });
}

async function markOrganizerItemsComplete(params: Record<string, unknown> = {}): Promise<unknown> {
  const itemIds = Array.isArray(params["itemIds"]) ? params["itemIds"] : [];
  if (!itemIds.length) {
    throw new Error("itemIds must be a non-empty array.");
  }
  return queueOrganizerMutationAndWait(params, "mark_organizer_items_complete", {
    itemIds,
  });
}

function queueAppspaceOperation(params: Record<string, unknown> = {}): unknown {
  const session = getSession(params);
  const operation = typeof params["operation"] === "string" ? params["operation"].trim() : "";
  if (!operation) {
    throw new Error("operation is required.");
  }
  const opArgs = params["args"] === undefined ? {} : readRecord(params["args"], "args");
  const queued = queueSessionOperation(session, operation, opArgs);
  return {
    status: "queued",
    sessionId: session.sessionId,
    operationId: queued.id,
    operation,
  };
}

function listAppspaceOperations(params: Record<string, unknown> = {}): unknown {
  const session = getSession(params);
  const status = typeof params["status"] === "string" ? params["status"] : "";
  const limit = clampNumber(params["limit"], 1, 200, 50);
  const operations = session.operations
    .filter((operation) => !status || operation.status === status)
    .slice(-limit);
  return {
    sessionId: session.sessionId,
    count: operations.length,
    operations,
  };
}

function completeAppspaceOperation(params: Record<string, unknown> = {}): unknown {
  const session = getSession(params, false);
  const operationId = typeof params["operationId"] === "string" ? params["operationId"].trim() : "";
  if (!operationId) {
    throw new Error("operationId is required.");
  }
  const operation = session.operations.find((item) => item.id === operationId);
  if (!operation) {
    throw new Error(`No queued appspace operation found for ${operationId}.`);
  }
  const status = params["status"] === "failed" ? "failed" : "completed";
  operation.status = status;
  operation.updatedAt = new Date().toISOString();
  if (status === "failed") {
    operation.error = typeof params["error"] === "string" ? params["error"] : "Operation failed.";
  } else {
    operation.result = params["result"];
  }
  return {
    status: "ok",
    sessionId: session.sessionId,
    operationId,
    operationStatus: operation.status,
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
