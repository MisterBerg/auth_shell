import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type {
  AssetRecord,
  ChildSlot,
  ModuleConfig,
  ModuleProps,
  ModuleRegistryEntry,
  Resource,
} from "module-core";
import {
  buildAssetVersionKey,
  assetMatchesSearch,
  createAsset,
  createAssetId,
  createAssetRecord,
  createAssetVersionId,
  getAssetSearchText,
  getCurrentAssetVersion,
  listAssets,
  useAllResources,
  useAwsDdbClient,
  useAwsS3Client,
  useEditMode,
  useModuleRegistry,
  useTableNames,
  useUpdateSlotMeta,
  useUserProfile,
} from "module-core";

type ChatMeta = {
  title?: string;
  model?: string;
  systemPrompt?: string;
};

type AgentBridgeDefaults = {
  url?: string;
  token?: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "error" | "tool";
  text: string;
};

type ResponsesApiOutputText = {
  type?: string;
  text?: string;
};

type ResponsesApiMessage = {
  type?: string;
  role?: string;
  content?: ResponsesApiOutputText[];
};

type ResponsesApiFunctionCall = {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
};

type ResponsesApiOutputItem = ResponsesApiMessage | ResponsesApiFunctionCall | {
  type?: string;
  [key: string]: unknown;
};

type ResponsesApiResponse = {
  output_text?: string;
  output?: ResponsesApiOutputItem[];
  error?: {
    message?: string;
  };
};

type InputMessageItem = {
  type: "message";
  role: "user" | "assistant";
  content: Array<
    | {
        type: "input_text";
        text: string;
      }
    | {
        type: "output_text";
        text: string;
      }
  >;
};

type FunctionCallOutputItem = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

type ToolExecutionResult = {
  output: string;
  toolMessage?: string;
  mutatedWorkspace?: boolean;
};

type ToolDefinition = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
};

type WorkspaceContext = {
  projectId: string;
  configBucket: string;
  configPath: string;
  rootConfig: ModuleConfig;
  resources: Resource[];
};

type ModuleToolArgs = {
  moduleName: string;
  slotId: string;
  meta?: Record<string, unknown>;
  resources?: Resource[];
  title?: string;
};

type GenericSlotToolArgs = {
  moduleName?: string;
  parentSlotPath?: string[];
  slotId: string;
  meta?: Record<string, unknown>;
  resources?: Resource[];
  title?: string;
  children?: ChildSlot[];
  replaceChildren?: boolean;
};

type BridgeConfig = {
  url: string;
  token: string;
};

type BridgeStatus = {
  status: string;
  workspaceRoot: string;
  pythonRoot?: string;
};

type BridgeListResult = {
  root: string;
  recursive: boolean;
  count: number;
  files: Array<{
    path: string;
    kind: "file" | "directory";
    sizeBytes?: number;
  }>;
};

type PendingContinuation = {
  inputItems: Array<InputMessageItem | ResponsesApiOutputItem | FunctionCallOutputItem>;
  contextBits: string[];
  lastToolMessages: string[];
};

type PersistedChatSession = {
  messages: ChatMessage[];
  composer: string;
  pendingContinuation: PendingContinuation | null;
};

type AgentRunResult = {
  assistantText: string;
  lastToolMessages: string[];
  pending: PendingContinuation | null;
  shouldNavigate: boolean;
};

const RESOURCE_TYPE_VALUES: Resource["type"][] = [
  "s3-object",
  "s3-prefix",
  "dynamodb",
  "api",
  "other",
];

const RESOURCE_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    type: { type: "string", enum: RESOURCE_TYPE_VALUES },
    bucket: { type: "string" },
    key: { type: "string" },
    table: { type: "string" },
    region: { type: "string" },
    endpoint: { type: "string" },
    mimeType: { type: "string" },
    meta: { type: "object", additionalProperties: true },
  },
  required: ["id", "label", "type"],
  additionalProperties: false,
} as const;

type MarkdownFileInput = {
  path: string;
  content: string;
  mimeType?: string;
};

const DEFAULT_MODEL = "gpt-5.2-codex";
const DEFAULT_TITLE = "Codex Chat";
const TOOL_ITERATION_LIMIT = 20;
const DEFAULT_PROMPT = [
  "You are helping build and evolve this workspace.",
  "Use the provided workspace tools whenever project structure, assets, resources, or modules are relevant.",
  "By default, treat 'the app', 'the webapp', 'app data', 'documentation here', and similar phrases as referring to the active project configuration, project assets, and registered resources inside the web app.",
  "Prefer project assets, registered resources, and root-config information before searching the local bridge workspace unless the user explicitly says workspace, local files, repo, filesystem, or disk, or recent conversation is clearly about local workspace operations.",
  "Use shell commands only when no better dedicated tool is available, and pay attention to command failures.",
  "Prefer the managed Python tools for parsing, transformations, text extraction, and small file-oriented programs instead of shell-embedded Python.",
  "Only install Python packages through the dedicated dependency installer, and only when a missing dependency blocks the task.",
  "When using run_workspace_command, provide the shell body only. Do not prefix it with powershell, pwsh, cmd, or sh.",
  "On Windows, assume the bridge will run the command inside PowerShell; set $ErrorActionPreference='Stop' and ensure parent directories exist first when needed.",
  "If a tool returns an error, read it carefully, explain what failed if asked, and change approach instead of pretending the tool succeeded.",
  "When changing the workspace, explain what you changed and why.",
  "Do not claim a change happened unless the tool call succeeded.",
].join(" ");

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    name: "get_workspace_summary",
    description: "Read the active project's root config, slot tree, and high-level workspace status.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "get_root_config",
    description: "Return the full active root config JSON so the agent can inspect exact structure and module metadata.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "list_project_assets",
    description: "List project asset records from the central asset store. Uses tokenized matching over labels, paths, mime types, and metadata.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_project_asset",
    description: "Read the content of a text-like project asset by assetId or path. Works for html, markdown, txt, json, csv, xml, and similar text assets.",
    parameters: {
      type: "object",
      properties: {
        assetId: { type: "string" },
        path: { type: "string" },
        maxChars: { type: "integer", minimum: 200, maximum: 200000 },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_text_asset",
    description: "Create a new text-like project asset in the central asset store from inline content.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string" },
        filename: { type: "string" },
        content: { type: "string" },
        mimeType: { type: "string" },
        meta: { type: "object", additionalProperties: true },
      },
      required: ["label", "filename", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "import_workspace_file_as_asset",
    description: "Import a file from the local bridge workspace into the project's central asset store.",
    parameters: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        label: { type: "string" },
        filename: { type: "string" },
        mimeType: { type: "string" },
        meta: { type: "object", additionalProperties: true },
      },
      required: ["workspacePath"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_markdown_file_set",
    description: "Create a markdown-viewer compatible file set asset and child file assets from provided markdown/text files.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string" },
        entryPath: { type: "string" },
        files: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              mimeType: { type: "string" },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["label", "entryPath", "files"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_registered_resources",
    description: "List resources currently registered across the loaded module tree.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_available_modules",
    description: "List published modules available in the picker so the agent can choose a module to add or swap in.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_workspace_files",
    description: "List files and directories from the local workspace bridge.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_workspace_file",
    description: "Read a file from the local workspace bridge.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"] },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "run_workspace_command",
    description: "Run a shell command through the local workspace bridge.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "integer", minimum: 100, maximum: 600000 },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_python_environment",
    description: "Inspect the managed local Python environment and its approved dependency allowlist.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "check_python_dependencies",
    description: "Check whether approved Python packages are already installed in the managed environment.",
    parameters: {
      type: "object",
      properties: {
        packages: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
        },
      },
      required: ["packages"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "install_python_dependencies",
    description: "Install approved, pinned Python packages into the managed environment. Fails for packages outside the allowlist.",
    parameters: {
      type: "object",
      properties: {
        packages: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
        },
      },
      required: ["packages"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "run_python_script",
    description: "Run a Python script through the managed local Python environment.",
    parameters: {
      type: "object",
      properties: {
        script: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "integer", minimum: 100, maximum: 600000 },
      },
      required: ["script"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "extract_pdf_text",
    description: "Extract text from a PDF file through the local workspace bridge.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxPages: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "upsert_root_slot",
    description: "Create or update a top-level child slot in the active root config using a published module.",
    parameters: {
      type: "object",
      properties: {
        moduleName: { type: "string" },
        slotId: { type: "string" },
        title: { type: "string" },
        meta: { type: "object", additionalProperties: true },
        resources: {
          type: "array",
          items: RESOURCE_SCHEMA,
        },
      },
      required: ["moduleName", "slotId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "remove_root_slot",
    description: "Remove a top-level child slot from the active root config.",
    parameters: {
      type: "object",
      properties: {
        slotId: { type: "string" },
      },
      required: ["slotId"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "list_slot_tree",
    description: "Return the active app-space slot tree with full slot paths, module bundle keys, metadata, resources, and child counts.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "upsert_slot",
    description: "Create or update a slot anywhere in the active app-space tree using the framework's ChildSlot structure. Parent path defaults to the root.",
    parameters: {
      type: "object",
      properties: {
        parentSlotPath: {
          type: "array",
          items: { type: "string" },
        },
        slotId: { type: "string" },
        moduleName: { type: "string" },
        title: { type: "string" },
        meta: { type: "object", additionalProperties: true },
        resources: {
          type: "array",
          items: RESOURCE_SCHEMA,
        },
        children: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
        replaceChildren: { type: "boolean" },
      },
      required: ["slotId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "remove_slot",
    description: "Remove a slot anywhere in the active app-space tree by its full slot path.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
      },
      required: ["slotPath"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "update_root_config",
    description: "Update root-level app-space settings like title/meta, resources, and theme using the existing ModuleConfig contract.",
    parameters: {
      type: "object",
      properties: {
        moduleName: { type: "string" },
        meta: { type: "object", additionalProperties: true },
        resources: {
          type: "array",
          items: RESOURCE_SCHEMA,
        },
        replaceResources: { type: "boolean" },
        theme: {
          type: "object",
          properties: {
            cssKey: { type: "string" },
            cssBucket: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
];

const C = {
  bg: "#07111f",
  panel: "#0b1728",
  panelAlt: "#0f1e34",
  border: "#1a2c47",
  text: "#e5eefc",
  muted: "#8ba0c2",
  accent: "#5eead4",
  accentStrong: "#14b8a6",
  warning: "#f59e0b",
  danger: "#fda4af",
  userBubble: "#0e243f",
  assistantBubble: "#102033",
  errorBubble: "#341321",
  toolBubble: "#13273d",
};

function extractProjectId(configPath: string, fallback: string): string {
  const match = configPath.match(/(?:^|\/)projects\/([^/]+)/);
  return match?.[1] ?? fallback;
}

function buildStorageKey(projectId: string, moduleId: string) {
  return `auth-shell:chat-codex:${projectId}:${moduleId}:openai-key`;
}

function buildChatSessionKey(configBucket: string, configPath: string, moduleId: string) {
  return `auth-shell:chat-codex:${configBucket}:${configPath}:${moduleId}:session`;
}

function buildBridgeStorageKey(projectId: string, moduleId: string, field: "url" | "token") {
  return `auth-shell:chat-codex:${projectId}:${moduleId}:bridge-${field}`;
}

function buildBridgeWorkspaceRootKey(projectId: string, moduleId: string) {
  return `auth-shell:chat-codex:${projectId}:${moduleId}:bridge-workspace-root`;
}

function safeReadLocalStorage(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function safeWriteLocalStorage(key: string, value: string) {
  try {
    if (!value) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore local storage failures so the module still works in-memory.
  }
}

function readPersistedChatSession(key: string): PersistedChatSession | null {
  const raw = safeReadLocalStorage(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersistedChatSession;
  } catch {
    return null;
  }
}

function persistChatSessionNow(key: string, session: PersistedChatSession) {
  safeWriteLocalStorage(key, JSON.stringify(session));
}

function createMessage(role: ChatMessage["role"], text: string): ChatMessage {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
  };
}

function extractAssistantText(response: ResponsesApiResponse): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const chunks: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    const message = item as ResponsesApiMessage;
    if (message.role !== "assistant") continue;
    for (const content of message.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join("\n\n").trim();
}

function parseToolArgs<T>(raw: string): T {
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

function matchesQuery(haystack: string, query: string): boolean {
  if (!query.trim()) return true;
  return haystack.toLowerCase().includes(query.trim().toLowerCase());
}

function normalizeResources(resources: Resource[] | undefined, contextLabel: string): Resource[] | undefined {
  if (!resources?.length) return undefined;
  return resources.map((resource, index) => {
    if (!RESOURCE_TYPE_VALUES.includes(resource.type)) {
      throw new Error(
        `${contextLabel} resource ${index + 1} has invalid type "${String(resource.type)}". ` +
        `Allowed types: ${RESOURCE_TYPE_VALUES.join(", ")}.`,
      );
    }
    if ((resource.type === "s3-object" || resource.type === "s3-prefix") && (!resource.bucket?.trim() || !resource.key?.trim())) {
      throw new Error(`${contextLabel} resource ${resource.id} must include bucket and key for type ${resource.type}.`);
    }
    if (resource.type === "dynamodb" && !resource.table?.trim()) {
      throw new Error(`${contextLabel} resource ${resource.id} must include table for type dynamodb.`);
    }
    return resource;
  });
}

function normalizeChildSlots(children: ChildSlot[] | undefined, contextLabel: string): ChildSlot[] | undefined {
  if (!children) return undefined;
  return children.map((child, index) => {
    if (!child?.slotId?.trim()) {
      throw new Error(`${contextLabel} child ${index + 1} is missing slotId.`);
    }
    if (!child.app?.bucket?.trim() || !child.app?.key?.trim()) {
      throw new Error(
        `${contextLabel} child ${child.slotId} is missing app.bucket/app.key. ` +
        `Nested children must already be full ChildSlot objects.`,
      );
    }
    return {
      ...child,
      resources: normalizeResources(child.resources, `${contextLabel} child ${child.slotId}`),
      children: normalizeChildSlots(child.children, `${contextLabel} child ${child.slotId}`),
    };
  });
}

function assetSearchScore(asset: AssetRecord, query: string): number {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return 1;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const text = getAssetSearchText(asset);
  let score = 0;
  for (const token of tokens) {
    if (text.includes(token)) score += 10;
  }
  if (text.includes(trimmed)) score += 25;
  if ((asset.label ?? "").toLowerCase().includes(trimmed)) score += 20;
  if ((asset.versions[0]?.key ?? "").toLowerCase().includes(trimmed)) score += 15;
  if ((asset.versions[0]?.mimeType ?? "").toLowerCase().includes(trimmed)) score += 5;
  return score;
}

function isTextLikeAsset(asset: AssetRecord): boolean {
  const version = getCurrentAssetVersion(asset);
  const mime = (version.mimeType ?? "").toLowerCase();
  const key = (version.key ?? "").toLowerCase();
  return (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml") ||
    mime.includes("javascript") ||
    mime.includes("typescript") ||
    mime.includes("csv") ||
    key.endsWith(".txt") ||
    key.endsWith(".md") ||
    key.endsWith(".markdown") ||
    key.endsWith(".html") ||
    key.endsWith(".htm") ||
    key.endsWith(".json") ||
    key.endsWith(".csv") ||
    key.endsWith(".xml") ||
    key.endsWith(".js") ||
    key.endsWith(".ts")
  );
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}

function guessMimeType(filename: string, fallback = "application/octet-stream"): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".xml")) return "application/xml";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return fallback;
}

async function createProjectAssetFromBytes(args: {
  getS3Client: ReturnType<typeof useAwsS3Client>;
  getDdbClient: ReturnType<typeof useAwsDdbClient>;
  assetsTable: string;
  projectId: string;
  bucket: string;
  label: string;
  filename: string;
  bytes: Uint8Array;
  mimeType: string;
  meta?: Record<string, unknown>;
}) {
  const assetId = createAssetId();
  const versionId = createAssetVersionId();
  const key = buildAssetVersionKey({
    projectId: args.projectId,
    assetId,
    versionId,
    filename: args.filename,
  });

  const s3 = await args.getS3Client(args.bucket);
  await s3.send(new PutObjectCommand({
    Bucket: args.bucket,
    Key: key,
    Body: args.bytes,
    ContentType: args.mimeType,
  }));

  const ddb = await args.getDdbClient();
  await createAsset({
    ddb,
    tableName: args.assetsTable,
    asset: createAssetRecord({
      projectId: args.projectId,
      assetId,
      label: args.label,
      version: {
        versionId,
        bucket: args.bucket,
        key,
        mimeType: args.mimeType,
        sizeBytes: args.bytes.byteLength,
      },
      meta: args.meta,
    }),
  });

  return { assetId, versionId, bucket: args.bucket, key, mimeType: args.mimeType, sizeBytes: args.bytes.byteLength };
}

function flattenSlots(children: ChildSlot[] | undefined, depth = 0): Array<{
  slotId: string;
  moduleKey: string;
  depth: number;
  childCount: number;
}> {
  if (!children?.length) return [];
  const items: Array<{ slotId: string; moduleKey: string; depth: number; childCount: number }> = [];
  for (const child of children) {
    items.push({
      slotId: child.slotId,
      moduleKey: child.app.key,
      depth,
      childCount: child.children?.length ?? 0,
    });
    items.push(...flattenSlots(child.children, depth + 1));
  }
  return items;
}

function buildSlotTree(
  children: ChildSlot[] | undefined,
  path: string[] = [],
): Array<{
  slotId: string;
  path: string[];
  moduleKey: string;
  bucket: string;
  exportName?: string;
  meta?: Record<string, unknown>;
  resources?: Resource[];
  childCount: number;
  children: ReturnType<typeof buildSlotTree>;
}> {
  if (!children?.length) return [];
  return children.map((child) => {
    const nextPath = [...path, child.slotId];
    return {
      slotId: child.slotId,
      path: nextPath,
      moduleKey: child.app.key,
      bucket: child.app.bucket,
      exportName: child.app.exportName,
      meta: child.meta,
      resources: child.resources,
      childCount: child.children?.length ?? 0,
      children: buildSlotTree(child.children, nextPath),
    };
  });
}

function cloneChildren(children: ChildSlot[] | undefined): ChildSlot[] {
  return (children ?? []).map((child) => ({
    ...child,
    meta: child.meta ? { ...child.meta } : undefined,
    resources: child.resources ? [...child.resources] : undefined,
    children: cloneChildren(child.children),
  }));
}

function findSlotInChildren(children: ChildSlot[] | undefined, slotPath: string[]): ChildSlot | undefined {
  if (!slotPath.length) return undefined;
  let currentChildren = children ?? [];
  let currentSlot: ChildSlot | undefined;
  for (const slotId of slotPath) {
    currentSlot = currentChildren.find((child) => child.slotId === slotId);
    if (!currentSlot) return undefined;
    currentChildren = currentSlot.children ?? [];
  }
  return currentSlot;
}

function getChildrenCollectionAtPath(children: ChildSlot[] | undefined, parentSlotPath: string[]): ChildSlot[] {
  if (!parentSlotPath.length) {
    return cloneChildren(children);
  }
  const rootChildren = cloneChildren(children);
  let currentChildren = rootChildren;
  for (const slotId of parentSlotPath) {
    const currentSlot = currentChildren.find((child) => child.slotId === slotId);
    if (!currentSlot) {
      throw new Error(`Parent slot path not found: ${parentSlotPath.join(" / ")}`);
    }
    currentSlot.children = cloneChildren(currentSlot.children);
    currentChildren = currentSlot.children;
  }
  return rootChildren;
}

function upsertSlotAtPath(args: {
  children: ChildSlot[] | undefined;
  parentSlotPath: string[];
  slot: ChildSlot;
}): ChildSlot[] {
  const rootChildren = cloneChildren(args.children);
  let currentChildren = rootChildren;

  for (const slotId of args.parentSlotPath) {
    const currentSlot = currentChildren.find((child) => child.slotId === slotId);
    if (!currentSlot) {
      throw new Error(`Parent slot path not found: ${args.parentSlotPath.join(" / ")}`);
    }
    currentSlot.children = cloneChildren(currentSlot.children);
    currentChildren = currentSlot.children;
  }

  const existingIndex = currentChildren.findIndex((child) => child.slotId === args.slot.slotId);
  if (existingIndex >= 0) {
    currentChildren[existingIndex] = args.slot;
  } else {
    currentChildren.push(args.slot);
  }

  return rootChildren;
}

function removeSlotAtPath(children: ChildSlot[] | undefined, slotPath: string[]): ChildSlot[] {
  if (!slotPath.length) {
    throw new Error("slotPath is required.");
  }

  const rootChildren = cloneChildren(children);
  if (slotPath.length === 1) {
    const filtered = rootChildren.filter((child) => child.slotId !== slotPath[0]);
    if (filtered.length === rootChildren.length) {
      throw new Error(`No slot found at path ${slotPath.join(" / ")}`);
    }
    return filtered;
  }

  let currentChildren = rootChildren;
  for (let i = 0; i < slotPath.length - 1; i++) {
    const currentSlot = currentChildren.find((child) => child.slotId === slotPath[i]);
    if (!currentSlot) {
      throw new Error(`No slot found at path ${slotPath.join(" / ")}`);
    }
    currentSlot.children = cloneChildren(currentSlot.children);
    currentChildren = currentSlot.children;
  }

  const targetId = slotPath[slotPath.length - 1]!;
  const filtered = currentChildren.filter((child) => child.slotId !== targetId);
  if (filtered.length === currentChildren.length) {
    throw new Error(`No slot found at path ${slotPath.join(" / ")}`);
  }

  currentChildren.splice(0, currentChildren.length, ...filtered);
  return rootChildren;
}

function toInputItems(messages: ChatMessage[]): InputMessageItem[] {
  return messages
    .filter((message): message is ChatMessage & { role: "user" | "assistant" } =>
      message.role === "user" || message.role === "assistant"
    )
    .map((message) => ({
      type: "message",
      role: message.role,
      content: [{
        type: message.role === "user" ? "input_text" : "output_text",
        text: message.text,
      }],
    }));
}

async function createOpenAiResponse(args: {
  apiKey: string;
  input: Array<InputMessageItem | ResponsesApiOutputItem | FunctionCallOutputItem>;
  model: string;
  instructions: string;
  tools: ToolDefinition[];
}): Promise<ResponsesApiResponse> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({
      model: args.model,
      input: args.input,
      instructions: args.instructions,
      tools: args.tools,
      parallel_tool_calls: true,
    }),
  });

  const payload = (await response.json()) as ResponsesApiResponse;
  if (!response.ok) {
    throw new Error(payload.error?.message || `OpenAI request failed with status ${response.status}.`);
  }
  return payload;
}

function maskKey(value: string): string {
  if (value.length < 10) return "Saved locally";
  return `${value.slice(0, 7)}...${value.slice(-4)}`;
}

function maskBridgeToken(value: string): string {
  if (!value) return "Not connected";
  if (value.length < 10) return "Saved locally";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function readBridgeDefaults(): AgentBridgeDefaults {
  const win = window as unknown as { __AgentBridgeDefaults?: AgentBridgeDefaults };
  return win.__AgentBridgeDefaults ?? {};
}

function parentPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  if (slash <= 1) return normalized;
  return normalized.slice(0, slash);
}

async function callBridge<T>(bridge: BridgeConfig, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${bridge.url.replace(/\/$/, "")}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bridge.token}`,
    },
    body: JSON.stringify({ method, params }),
  });

  const payload = (await response.json()) as { ok?: boolean; result?: T; error?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Bridge call failed: ${response.status}`);
  }
  return payload.result as T;
}

async function syncBridgeWorkspaceRoot(args: {
  bridge: BridgeConfig;
  preferredRoot: string;
}): Promise<BridgeStatus> {
  const preferred = args.preferredRoot.trim();
  if (preferred) {
    return callBridge<BridgeStatus>(args.bridge, "set_workspace_root", { path: preferred });
  }
  return callBridge<BridgeStatus>(args.bridge, "get_bridge_status");
}

async function loadWorkspaceContext(getS3Client: ReturnType<typeof useAwsS3Client>, configBucket: string, configPath: string, projectId: string): Promise<WorkspaceContext> {
  const s3 = await getS3Client(configBucket);
  const object = await s3.send(new GetObjectCommand({ Bucket: configBucket, Key: configPath }));
  const text = await object.Body!.transformToString("utf-8");
  const rootConfig = JSON.parse(text) as ModuleConfig;
  const resources = collectResources(rootConfig);
  return { projectId, configBucket, configPath, rootConfig, resources };
}

function collectResources(config: ModuleConfig): Resource[] {
  const rootResources = config.resources ?? [];
  const childResources = collectResourcesFromChildren(config.children);
  return [...rootResources, ...childResources];
}

function collectResourcesFromChildren(children: ChildSlot[] | undefined): Resource[] {
  if (!children?.length) return [];
  const items: Resource[] = [];
  for (const child of children) {
    if (child.resources?.length) items.push(...child.resources);
    if (child.children?.length) items.push(...collectResourcesFromChildren(child.children));
  }
  return items;
}

async function writeRootConfig(args: {
  getS3Client: ReturnType<typeof useAwsS3Client>;
  configBucket: string;
  configPath: string;
  rootConfig: ModuleConfig;
}) {
  const s3 = await args.getS3Client(args.configBucket);
  await s3.send(new PutObjectCommand({
    Bucket: args.configBucket,
    Key: args.configPath,
    Body: JSON.stringify(args.rootConfig, null, 2),
    ContentType: "application/json",
    CacheControl: "no-store",
  }));
}

function findModuleEntry(entries: ModuleRegistryEntry[], moduleName: string): ModuleRegistryEntry | undefined {
  const normalized = moduleName.trim().toLowerCase();
  return entries.find((entry) => {
    return [
      entry.moduleName,
      entry.displayName,
      `${entry.moduleName}`.replace(/^module-/, ""),
      `${entry.displayName ?? ""}`.replace(/^module-/, ""),
    ]
      .filter(Boolean)
      .some((value) => value!.toLowerCase() === normalized);
  });
}

async function executeTool(args: {
  toolCall: ResponsesApiFunctionCall;
  config: ModuleConfig;
  projectId: string;
  configBucket: string;
  configPath: string;
  getS3Client: ReturnType<typeof useAwsS3Client>;
  getDdbClient: ReturnType<typeof useAwsDdbClient>;
  assetsTable?: string;
  loadedResources: ReadonlyMap<string, Resource>;
  registryEntries: ModuleRegistryEntry[];
  bridge: BridgeConfig | null;
}): Promise<ToolExecutionResult> {
  const {
    toolCall,
    config,
    projectId,
    configBucket,
    configPath,
    getS3Client,
    getDdbClient,
    assetsTable,
    loadedResources,
    registryEntries,
    bridge,
  } = args;

  switch (toolCall.name) {
    case "get_workspace_summary": {
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slots = flattenSlots(context.rootConfig.children);
      const summary = {
        projectId,
        rootModuleId: context.rootConfig.id,
        rootBundleKey: context.rootConfig.app.key,
        rootChildSlotCount: context.rootConfig.children?.length ?? 0,
        totalDescendantSlots: slots.length,
        registeredResourceCount: loadedResources.size,
        configResourceCount: context.resources.length,
        topLevelSlots: (context.rootConfig.children ?? []).map((child) => ({
          slotId: child.slotId,
          bundleKey: child.app.key,
          childCount: child.children?.length ?? 0,
        })),
      };
      return {
        output: JSON.stringify(summary, null, 2),
        toolMessage: `Read workspace summary for ${projectId}.`,
      };
    }

    case "get_root_config": {
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      return {
        output: JSON.stringify(context.rootConfig, null, 2),
        toolMessage: "Loaded the full root config JSON.",
      };
    }

    case "list_project_assets": {
      const parsed = parseToolArgs<{ query?: string; limit?: number }>(toolCall.arguments);
      if (!assetsTable) throw new Error("Project asset table is not configured.");
      const ddb = await getDdbClient();
      const assets = await listAssets({ ddb, tableName: assetsTable, projectId });
      const filtered = assets
        .map((asset) => ({ asset, score: assetSearchScore(asset, parsed.query ?? "") }))
        .filter(({ asset, score }) => {
          const query = parsed.query ?? "";
          return !query.trim() || score > 0 || assetMatchesSearch(asset, query);
        })
        .sort((a, b) => b.score - a.score || a.asset.label.localeCompare(b.asset.label))
        .slice(0, parsed.limit ?? 25)
        .map(({ asset }: { asset: AssetRecord; score: number }) => ({
          assetId: asset.assetId,
          label: asset.label,
          versionId: getCurrentAssetVersion(asset).versionId,
          key: getCurrentAssetVersion(asset).key,
          mimeType: getCurrentAssetVersion(asset).mimeType,
          sizeBytes: getCurrentAssetVersion(asset).sizeBytes,
          meta: asset.meta ?? {},
        }));
      return {
        output: JSON.stringify({ projectId, count: filtered.length, assets: filtered }, null, 2),
        toolMessage: `Listed ${filtered.length} project assets.`,
      };
    }

    case "read_project_asset": {
      const parsed = parseToolArgs<{ assetId?: string; path?: string; maxChars?: number }>(toolCall.arguments);
      if (!assetsTable) throw new Error("Project asset table is not configured.");
      const ddb = await getDdbClient();
      const assets = await listAssets({ ddb, tableName: assetsTable, projectId });
      const selected = parsed.assetId
        ? assets.find((asset) => asset.assetId === parsed.assetId)
        : parsed.path
          ? assets.find((asset) => {
              const version = getCurrentAssetVersion(asset);
              return version.key === parsed.path || asset.label === parsed.path;
            })
          : undefined;

      if (!selected) {
        throw new Error("Project asset not found. Provide an assetId or exact asset path.");
      }

      if (!isTextLikeAsset(selected)) {
        throw new Error("That asset is not a text-like file. Use another tool for PDFs or binary assets.");
      }

      const version = getCurrentAssetVersion(selected);
      const s3 = await getS3Client(version.bucket);
      const object = await s3.send(new GetObjectCommand({
        Bucket: version.bucket,
        Key: version.key,
      }));
      const content = await object.Body!.transformToString("utf-8");
      const maxChars = Math.max(200, Math.min(parsed.maxChars ?? 12000, 200000));

      return {
        output: JSON.stringify({
          assetId: selected.assetId,
          label: selected.label,
          bucket: version.bucket,
          key: version.key,
          mimeType: version.mimeType,
          truncated: content.length > maxChars,
          content: content.slice(0, maxChars),
        }, null, 2),
        toolMessage: `Read project asset ${selected.label}.`,
      };
    }

    case "create_text_asset": {
      const parsed = parseToolArgs<{
        label: string;
        filename: string;
        content: string;
        mimeType?: string;
        meta?: Record<string, unknown>;
      }>(toolCall.arguments);
      if (!assetsTable) throw new Error("Project asset table is not configured.");
      const bytes = new TextEncoder().encode(parsed.content);
      const created = await createProjectAssetFromBytes({
        getS3Client,
        getDdbClient,
        assetsTable,
        projectId,
        bucket: configBucket,
        label: parsed.label,
        filename: parsed.filename,
        bytes,
        mimeType: parsed.mimeType ?? guessMimeType(parsed.filename, "text/plain"),
        meta: {
          kind: "file",
          path: parsed.filename,
          moduleInstanceId: config.id,
          moduleType: "module-chat-codex",
          ...(parsed.meta ?? {}),
        },
      });
      return {
        output: JSON.stringify({ status: "ok", ...created }, null, 2),
        toolMessage: `Created project asset ${parsed.label}.`,
      };
    }

    case "import_workspace_file_as_asset": {
      if (!bridge) throw new Error("Local agent bridge is not configured.");
      if (!assetsTable) throw new Error("Project asset table is not configured.");
      const parsed = parseToolArgs<{
        workspacePath: string;
        label?: string;
        filename?: string;
        mimeType?: string;
        meta?: Record<string, unknown>;
      }>(toolCall.arguments);
      const workspaceFile = await callBridge<{ path: string; encoding: string; content: string }>(
        bridge,
        "read_workspace_file",
        { path: parsed.workspacePath, encoding: "base64" }
      );
      const bytes = Uint8Array.from(atob(workspaceFile.content), (ch) => ch.charCodeAt(0));
      const filename = parsed.filename ?? basename(parsed.workspacePath);
      const created = await createProjectAssetFromBytes({
        getS3Client,
        getDdbClient,
        assetsTable,
        projectId,
        bucket: configBucket,
        label: parsed.label ?? filename,
        filename,
        bytes,
        mimeType: parsed.mimeType ?? guessMimeType(filename),
        meta: {
          kind: "file",
          path: filename,
          sourceWorkspacePath: parsed.workspacePath,
          moduleInstanceId: config.id,
          moduleType: "module-chat-codex",
          ...(parsed.meta ?? {}),
        },
      });
      return {
        output: JSON.stringify({ status: "ok", workspacePath: parsed.workspacePath, ...created }, null, 2),
        toolMessage: `Imported workspace file ${parsed.workspacePath} as a project asset.`,
      };
    }

    case "create_markdown_file_set": {
      const parsed = parseToolArgs<{
        label: string;
        entryPath: string;
        files: MarkdownFileInput[];
      }>(toolCall.arguments);
      if (!assetsTable) throw new Error("Project asset table is not configured.");

      const fileSetAssetId = createAssetId();
      const fileSetVersionId = createAssetVersionId();
      const versionRoot = [
        "projects",
        encodeURIComponent(projectId).replace(/%20/g, "-"),
        "assets",
        encodeURIComponent(fileSetAssetId).replace(/%20/g, "-"),
        "versions",
        encodeURIComponent(fileSetVersionId).replace(/%20/g, "-"),
      ].join("/");
      const filesPrefix = `${versionRoot}/files`;
      const manifestKey = `${versionRoot}/manifest.json`;
      const s3 = await getS3Client(configBucket);
      const ddb = await getDdbClient();
      const childAssetRefs: Array<{ path: string; assetId: string; versionId: string; key: string; mimeType: string; sizeBytes: number }> = [];

      for (const file of parsed.files) {
        const bytes = new TextEncoder().encode(file.content);
        const key = `${filesPrefix}/${file.path}`;
        const mimeType = file.mimeType ?? guessMimeType(file.path, "text/plain");
        await s3.send(new PutObjectCommand({
          Bucket: configBucket,
          Key: key,
          Body: bytes,
          ContentType: mimeType,
        }));
        const assetId = createAssetId();
        const versionId = createAssetVersionId();
        await createAsset({
          ddb,
          tableName: assetsTable,
          asset: createAssetRecord({
            projectId,
            assetId,
            label: basename(file.path),
            version: {
              versionId,
              bucket: configBucket,
              key,
              mimeType,
              sizeBytes: bytes.byteLength,
            },
            meta: {
              kind: "file",
              parentAssetId: fileSetAssetId,
              path: file.path,
              moduleInstanceId: config.id,
              moduleType: "module-markdown-viewer",
            },
          }),
        });
        childAssetRefs.push({ path: file.path, assetId, versionId, key, mimeType, sizeBytes: bytes.byteLength });
      }

      const manifestBytes = new TextEncoder().encode(JSON.stringify({
        kind: "markdown-file-set",
        entryPath: parsed.entryPath,
        moduleInstanceId: config.id,
        files: childAssetRefs,
      }, null, 2));

      await s3.send(new PutObjectCommand({
        Bucket: configBucket,
        Key: manifestKey,
        Body: manifestBytes,
        ContentType: "application/json",
      }));

      await createAsset({
        ddb,
        tableName: assetsTable,
        asset: createAssetRecord({
          projectId,
          assetId: fileSetAssetId,
          label: parsed.label,
          version: {
            versionId: fileSetVersionId,
            bucket: configBucket,
            key: manifestKey,
            mimeType: "application/json",
            sizeBytes: manifestBytes.byteLength,
          },
          meta: {
            kind: "file-set",
            entryPath: parsed.entryPath,
            moduleInstanceId: config.id,
            moduleType: "module-markdown-viewer",
            fileCount: parsed.files.length,
          },
        }),
      });

      return {
        output: JSON.stringify({
          status: "ok",
          assetId: fileSetAssetId,
          versionId: fileSetVersionId,
          bucket: configBucket,
          manifestKey,
          prefix: filesPrefix,
          rootKey: `${filesPrefix}/${parsed.entryPath}`,
          fileCount: parsed.files.length,
        }, null, 2),
        toolMessage: `Created markdown file set ${parsed.label}.`,
      };
    }

    case "list_registered_resources": {
      const parsed = parseToolArgs<{ query?: string; limit?: number }>(toolCall.arguments);
      const resources = [...loadedResources.values()]
        .filter((resource) => matchesQuery(JSON.stringify(resource), parsed.query ?? ""))
        .slice(0, parsed.limit ?? 25)
        .map((resource) => ({
          id: resource.id,
          label: resource.label,
          type: resource.type,
          bucket: resource.bucket,
          key: resource.key,
          table: resource.table,
          mimeType: resource.mimeType,
        }));
      return {
        output: JSON.stringify({ count: resources.length, resources }, null, 2),
        toolMessage: `Listed ${resources.length} registered resources.`,
      };
    }

    case "list_available_modules": {
      const parsed = parseToolArgs<{ query?: string; limit?: number }>(toolCall.arguments);
      const modules = registryEntries
        .filter((entry) => matchesQuery(JSON.stringify(entry), parsed.query ?? ""))
        .slice(0, parsed.limit ?? 40)
        .map((entry) => ({
          moduleName: entry.moduleName,
          displayName: entry.displayName,
          description: entry.description,
          category: entry.category,
          pickerGroup: entry.pickerGroup,
          bundlePath: entry.bundlePath,
        }));
      return {
        output: JSON.stringify({ count: modules.length, modules }, null, 2),
        toolMessage: `Listed ${modules.length} available published modules.`,
      };
    }

    case "list_workspace_files": {
      if (!bridge) throw new Error("Local agent bridge is not configured.");
      const parsed = parseToolArgs<{ path?: string; recursive?: boolean; limit?: number }>(toolCall.arguments);
      const result = await callBridge<unknown>(bridge, "list_workspace_files", parsed);
      return {
        output: JSON.stringify(result, null, 2),
        toolMessage: "Listed files from the local workspace bridge.",
      };
    }

    case "read_workspace_file": {
      if (!bridge) throw new Error("Local agent bridge is not configured.");
      const parsed = parseToolArgs<{ path: string; encoding?: string }>(toolCall.arguments);
      const result = await callBridge<unknown>(bridge, "read_workspace_file", parsed);
      return {
        output: JSON.stringify(result, null, 2),
        toolMessage: `Read workspace file ${parsed.path}.`,
      };
    }

    case "write_workspace_file": {
      if (!bridge) throw new Error("Local agent bridge is not configured.");
      const parsed = parseToolArgs<{ path: string; content: string; encoding?: string; mode?: string }>(toolCall.arguments);
      const result = await callBridge<unknown>(bridge, "write_workspace_file", parsed);
      return {
        output: JSON.stringify(result, null, 2),
        toolMessage: `Wrote workspace file ${parsed.path}.`,
      };
    }

    case "run_workspace_command": {
      if (!bridge) throw new Error("Local agent bridge is not configured.");
      const parsed = parseToolArgs<{ command: string; cwd?: string; timeoutMs?: number }>(toolCall.arguments);
      const result = await callBridge<unknown>(bridge, "run_workspace_command", parsed);
      return {
        output: JSON.stringify(result, null, 2),
        toolMessage: `Ran workspace command: ${parsed.command}`,
      };
    }

    case "get_python_environment": {
      if (!bridge) throw new Error("Local agent bridge is not configured.");
      const result = await callBridge<unknown>(bridge, "get_python_environment");
      return {
        output: JSON.stringify(result, null, 2),
        toolMessage: "Loaded the managed Python environment details.",
      };
    }

    case "check_python_dependencies": {
      if (!bridge) throw new Error("Local agent bridge is not configured.");
      const parsed = parseToolArgs<{ packages: string[] }>(toolCall.arguments);
      const result = await callBridge<unknown>(bridge, "check_python_dependencies", parsed);
      return {
        output: JSON.stringify(result, null, 2),
        toolMessage: `Checked Python dependencies: ${parsed.packages.join(", ")}.`,
      };
    }

    case "install_python_dependencies": {
      if (!bridge) throw new Error("Local agent bridge is not configured.");
      const parsed = parseToolArgs<{ packages: string[] }>(toolCall.arguments);
      const result = await callBridge<unknown>(bridge, "install_python_dependencies", parsed);
      return {
        output: JSON.stringify(result, null, 2),
        toolMessage: `Installed approved Python dependencies: ${parsed.packages.join(", ")}.`,
      };
    }

    case "run_python_script": {
      if (!bridge) throw new Error("Local agent bridge is not configured.");
      const parsed = parseToolArgs<{ script: string; cwd?: string; timeoutMs?: number }>(toolCall.arguments);
      const result = await callBridge<unknown>(bridge, "run_python_script", parsed);
      return {
        output: JSON.stringify(result, null, 2),
        toolMessage: "Ran a Python script in the managed local environment.",
      };
    }

    case "extract_pdf_text": {
      if (!bridge) throw new Error("Local agent bridge is not configured.");
      const parsed = parseToolArgs<{ path: string; maxPages?: number }>(toolCall.arguments);
      const result = await callBridge<unknown>(bridge, "extract_pdf_text", parsed);
      return {
        output: JSON.stringify(result, null, 2),
        toolMessage: `Extracted PDF text from ${parsed.path}.`,
      };
    }

    case "upsert_root_slot": {
      const parsed = parseToolArgs<ModuleToolArgs>(toolCall.arguments);
      const entry = findModuleEntry(registryEntries, parsed.moduleName);
      if (!entry) {
        throw new Error(`Published module not found: ${parsed.moduleName}`);
      }

      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const children = [...(context.rootConfig.children ?? [])];
      const meta = { ...(parsed.meta ?? {}) };
      if (parsed.title && meta["title"] === undefined) {
        meta["title"] = parsed.title;
      }
      const nextResources = normalizeResources(parsed.resources, "Root slot");

      const nextSlot: ChildSlot = {
        slotId: parsed.slotId,
        app: {
          bucket: entry.bundleBucket,
          key: entry.bundlePath,
        },
        meta: Object.keys(meta).length ? meta : undefined,
        resources: nextResources,
      };

      const existingIndex = children.findIndex((child) => child.slotId === parsed.slotId);
      if (existingIndex >= 0) {
        const existing = children[existingIndex]!;
        children[existingIndex] = {
          ...existing,
          app: nextSlot.app,
          meta: nextSlot.meta ?? existing.meta,
          resources: nextSlot.resources ?? existing.resources,
        };
      } else {
        children.push(nextSlot);
      }

      const updatedRoot: ModuleConfig = {
        ...context.rootConfig,
        children,
      };

      await writeRootConfig({ getS3Client, configBucket, configPath, rootConfig: updatedRoot });
      return {
        output: JSON.stringify({
          status: "ok",
          action: existingIndex >= 0 ? "updated" : "created",
          slotId: parsed.slotId,
          moduleName: entry.moduleName,
          bundlePath: entry.bundlePath,
        }, null, 2),
        toolMessage: `${existingIndex >= 0 ? "Updated" : "Created"} root slot ${parsed.slotId} using ${entry.moduleName}.`,
        mutatedWorkspace: true,
      };
    }

    case "remove_root_slot": {
      const parsed = parseToolArgs<{ slotId: string }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const before = context.rootConfig.children ?? [];
      const after = before.filter((child) => child.slotId !== parsed.slotId);
      if (after.length === before.length) {
        throw new Error(`No top-level slot found with id ${parsed.slotId}.`);
      }
      await writeRootConfig({
        getS3Client,
        configBucket,
        configPath,
        rootConfig: { ...context.rootConfig, children: after },
      });
      return {
        output: JSON.stringify({ status: "ok", action: "removed", slotId: parsed.slotId }, null, 2),
        toolMessage: `Removed root slot ${parsed.slotId}.`,
        mutatedWorkspace: true,
      };
    }

    case "list_slot_tree": {
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const tree = buildSlotTree(context.rootConfig.children);
      return {
        output: JSON.stringify({
          projectId,
          rootModule: context.rootConfig.app,
          slotTree: tree,
        }, null, 2),
        toolMessage: "Loaded the app-space slot tree.",
      };
    }

    case "upsert_slot": {
      const parsed = parseToolArgs<GenericSlotToolArgs>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const parentPath = parsed.parentSlotPath ?? [];
      const existing = findSlotInChildren(context.rootConfig.children, [...parentPath, parsed.slotId]);

      let app = existing?.app;
      if (parsed.moduleName?.trim()) {
        const entry = findModuleEntry(registryEntries, parsed.moduleName);
        if (!entry) {
          throw new Error(`Published module not found: ${parsed.moduleName}`);
        }
        app = {
          bucket: entry.bundleBucket,
          key: entry.bundlePath,
        };
      }

      if (!app) {
        throw new Error("moduleName is required when creating a new slot.");
      }

      const mergedMeta = {
        ...(existing?.meta ?? {}),
        ...(parsed.meta ?? {}),
      };
      if (parsed.title && mergedMeta["title"] === undefined) {
        mergedMeta["title"] = parsed.title;
      } else if (parsed.title) {
        mergedMeta["title"] = parsed.title;
      }
      const nextResources = parsed.resources === undefined
        ? existing?.resources
        : normalizeResources(parsed.resources, `Slot ${[...parentPath, parsed.slotId].join(" / ")}`);

      const nextChildren = parsed.replaceChildren
        ? normalizeChildSlots(parsed.children ?? [], `Slot ${[...parentPath, parsed.slotId].join(" / ")}`)
        : (parsed.children
            ? normalizeChildSlots(parsed.children, `Slot ${[...parentPath, parsed.slotId].join(" / ")}`)
            : existing?.children);

      const nextSlot: ChildSlot = {
        slotId: parsed.slotId,
        app,
        meta: Object.keys(mergedMeta).length ? mergedMeta : undefined,
        resources: nextResources,
        children: nextChildren,
      };

      const updatedRoot: ModuleConfig = {
        ...context.rootConfig,
        children: upsertSlotAtPath({
          children: context.rootConfig.children,
          parentSlotPath: parentPath,
          slot: nextSlot,
        }),
      };

      await writeRootConfig({ getS3Client, configBucket, configPath, rootConfig: updatedRoot });
      return {
        output: JSON.stringify({
          status: "ok",
          action: existing ? "updated" : "created",
          parentSlotPath: parentPath,
          slotPath: [...parentPath, parsed.slotId],
          moduleKey: nextSlot.app.key,
        }, null, 2),
        toolMessage: `${existing ? "Updated" : "Created"} slot ${[...parentPath, parsed.slotId].join(" / ")}.`,
        mutatedWorkspace: true,
      };
    }

    case "remove_slot": {
      const parsed = parseToolArgs<{ slotPath: string[] }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const updatedRoot: ModuleConfig = {
        ...context.rootConfig,
        children: removeSlotAtPath(context.rootConfig.children, parsed.slotPath),
      };
      await writeRootConfig({ getS3Client, configBucket, configPath, rootConfig: updatedRoot });
      return {
        output: JSON.stringify({
          status: "ok",
          action: "removed",
          slotPath: parsed.slotPath,
        }, null, 2),
        toolMessage: `Removed slot ${parsed.slotPath.join(" / ")}.`,
        mutatedWorkspace: true,
      };
    }

    case "update_root_config": {
      const parsed = parseToolArgs<{
        moduleName?: string;
        meta?: Record<string, unknown>;
        resources?: Resource[];
        replaceResources?: boolean;
        theme?: ModuleConfig["theme"];
      }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const nextParsedResources = parsed.resources
        ? normalizeResources(parsed.resources, "Root config")
        : undefined;

      let nextApp = context.rootConfig.app;
      if (parsed.moduleName?.trim()) {
        const entry = findModuleEntry(registryEntries, parsed.moduleName);
        if (!entry) {
          throw new Error(`Published module not found: ${parsed.moduleName}`);
        }
        nextApp = {
          bucket: entry.bundleBucket,
          key: entry.bundlePath,
        };
      }

      const nextRoot: ModuleConfig = {
        ...context.rootConfig,
        app: nextApp,
        meta: parsed.meta
          ? { ...(context.rootConfig.meta ?? {}), ...parsed.meta }
          : context.rootConfig.meta,
        resources: nextParsedResources
          ? (parsed.replaceResources ? nextParsedResources : [...(context.rootConfig.resources ?? []), ...nextParsedResources])
          : context.rootConfig.resources,
        theme: parsed.theme
          ? { ...(context.rootConfig.theme ?? {}), ...parsed.theme }
          : context.rootConfig.theme,
      };

      await writeRootConfig({ getS3Client, configBucket, configPath, rootConfig: nextRoot });
      return {
        output: JSON.stringify({
          status: "ok",
          rootModuleKey: nextRoot.app.key,
          metaKeys: Object.keys(nextRoot.meta ?? {}),
          resourceCount: nextRoot.resources?.length ?? 0,
          theme: nextRoot.theme ?? null,
        }, null, 2),
        toolMessage: "Updated root app-space config.",
        mutatedWorkspace: true,
      };
    }

    default:
      throw new Error(`Unsupported tool: ${toolCall.name}`);
  }
}

function formatToolError(toolName: string, error: unknown): ToolExecutionResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    output: JSON.stringify({
      ok: false,
      tool: toolName,
      error: message,
    }, null, 2),
    toolMessage: `Tool ${toolName} failed: ${message}`,
  };
}

export default function ChatCodexModule({ config }: ModuleProps) {
  const { editMode } = useEditMode();
  const updateSlotMeta = useUpdateSlotMeta();
  const user = useUserProfile();
  const getS3Client = useAwsS3Client();
  const getDdbClient = useAwsDdbClient();
  const { assets: assetsTable } = useTableNames();
  const resources = useAllResources();
  const { entries: registryEntries } = useModuleRegistry();

  const params = new URLSearchParams(window.location.search);
  const configBucket = params.get("bucket") ?? "";
  const configPath = params.get("config") ?? "";
  const projectId = extractProjectId(configPath, config.id);
  const storageKey = useMemo(() => buildStorageKey(projectId, config.id), [projectId, config.id]);
  const chatSessionKey = useMemo(
    () => buildChatSessionKey(configBucket, configPath, config.id),
    [configBucket, configPath, config.id]
  );
  const bridgeUrlKey = useMemo(() => buildBridgeStorageKey(projectId, config.id, "url"), [projectId, config.id]);
  const bridgeTokenKey = useMemo(() => buildBridgeStorageKey(projectId, config.id, "token"), [projectId, config.id]);
  const bridgeWorkspaceRootKey = useMemo(() => buildBridgeWorkspaceRootKey(projectId, config.id), [projectId, config.id]);

  const meta = (config.meta as ChatMeta | undefined) ?? {};
  const title = meta.title?.trim() || DEFAULT_TITLE;
  const model = meta.model?.trim() || DEFAULT_MODEL;
  const systemPrompt = meta.systemPrompt?.trim() || DEFAULT_PROMPT;

  const [apiKey, setApiKey] = useState("");
  const [draftApiKey, setDraftApiKey] = useState("");
  const [bridgeUrl, setBridgeUrl] = useState("");
  const [bridgeToken, setBridgeToken] = useState("");
  const [bridgeWorkspaceRoot, setBridgeWorkspaceRoot] = useState("");
  const [draftBridgeUrl, setDraftBridgeUrl] = useState("");
  const [draftBridgeToken, setDraftBridgeToken] = useState("");
  const [draftBridgeWorkspaceRoot, setDraftBridgeWorkspaceRoot] = useState("");
  const [bridgeBrowserOpen, setBridgeBrowserOpen] = useState(false);
  const [bridgeBrowserPath, setBridgeBrowserPath] = useState("");
  const [bridgeBrowserEntries, setBridgeBrowserEntries] = useState<BridgeListResult["files"]>([]);
  const [bridgeBrowserLoading, setBridgeBrowserLoading] = useState(false);
  const [bridgeBrowserError, setBridgeBrowserError] = useState<string | undefined>();
  const [newFolderName, setNewFolderName] = useState("");
  const [composer, setComposer] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [pendingContinuation, setPendingContinuation] = useState<PendingContinuation | null>(null);
  const [hydratedSessionKey, setHydratedSessionKey] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | undefined>();
  const [saveError, setSaveError] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [metaDraft, setMetaDraft] = useState<Required<ChatMeta>>({
    title,
    model,
    systemPrompt,
  });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stored = safeReadLocalStorage(storageKey);
    setApiKey(stored);
    setDraftApiKey(stored);
  }, [storageKey]);

  useEffect(() => {
    setHydratedSessionKey(null);
    setMessages([]);
    setComposer("");
    setPendingContinuation(null);
    const storedSession = readPersistedChatSession(chatSessionKey);
    if (storedSession) {
      setMessages(storedSession.messages ?? []);
      setComposer(storedSession.composer ?? "");
      setPendingContinuation(storedSession.pendingContinuation ?? null);
    }
    setHydratedSessionKey(chatSessionKey);
  }, [chatSessionKey]);

  useEffect(() => {
    const defaults = readBridgeDefaults();
    const storedUrl = safeReadLocalStorage(bridgeUrlKey) || defaults.url || "";
    const storedToken = safeReadLocalStorage(bridgeTokenKey) || defaults.token || "";
    const storedWorkspaceRoot = safeReadLocalStorage(bridgeWorkspaceRootKey) || "";
    setBridgeUrl(storedUrl);
    setBridgeToken(storedToken);
    setBridgeWorkspaceRoot(storedWorkspaceRoot);
    setDraftBridgeUrl(storedUrl);
    setDraftBridgeToken(storedToken);
    setDraftBridgeWorkspaceRoot(storedWorkspaceRoot);
  }, [bridgeTokenKey, bridgeUrlKey, bridgeWorkspaceRootKey]);

  useEffect(() => {
    const normalizedUrl = bridgeUrl.trim().replace(/\/$/, "");
    const normalizedToken = bridgeToken.trim();
    if (!normalizedUrl || !normalizedToken) return;

    const bridge = { url: normalizedUrl, token: normalizedToken };
    const preferredRoot = safeReadLocalStorage(bridgeWorkspaceRootKey) || draftBridgeWorkspaceRoot || bridgeWorkspaceRoot;
    let cancelled = false;

    void syncBridgeWorkspaceRoot({ bridge, preferredRoot })
      .then((status) => {
        if (cancelled) return;
        safeWriteLocalStorage(bridgeWorkspaceRootKey, status.workspaceRoot);
        setBridgeWorkspaceRoot(status.workspaceRoot);
        setDraftBridgeWorkspaceRoot((current) => current.trim() ? current : status.workspaceRoot);
      })
      .catch((error) => {
        if (cancelled) return;
        console.debug("[chat-codex] bridge workspace sync failed", {
          message: (error as Error).message,
          preferredRoot,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [bridgeUrl, bridgeToken, bridgeWorkspaceRootKey]);

  useEffect(() => {
    setMetaDraft({ title, model, systemPrompt });
  }, [title, model, systemPrompt]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    if (hydratedSessionKey !== chatSessionKey) return;
    safeWriteLocalStorage(chatSessionKey, JSON.stringify({
      messages,
      composer,
      pendingContinuation,
    } satisfies PersistedChatSession));
  }, [chatSessionKey, composer, hydratedSessionKey, messages, pendingContinuation]);

  const connectionLabel = apiKey ? maskKey(apiKey) : "Not connected";
  const bridgeLabel = bridgeUrl ? `${bridgeUrl} · ${maskBridgeToken(bridgeToken)}` : "Not connected";
  const canSend = !!apiKey.trim() && !!composer.trim() && !busy;
  const canSaveSettings = !!metaDraft.title.trim() && !!metaDraft.model.trim() && !!metaDraft.systemPrompt.trim() && !busy;
  const continuationPending = Boolean(pendingContinuation);

  async function handleConnect() {
    const trimmed = draftApiKey.trim();
    setConnectionError(undefined);
    if (!trimmed) {
      setConnectionError("Enter an OpenAI API key to enable chat.");
      return;
    }
    safeWriteLocalStorage(storageKey, trimmed);
    setApiKey(trimmed);
  }

  function handleDisconnect() {
    safeWriteLocalStorage(storageKey, "");
    setApiKey("");
    setDraftApiKey("");
    setConnectionError(undefined);
  }

  async function handleSaveBridge() {
    const normalizedUrl = draftBridgeUrl.trim().replace(/\/$/, "");
    const normalizedToken = draftBridgeToken.trim();
    if (!normalizedUrl || !normalizedToken) {
      setConnectionError("Bridge URL and bridge token are both required.");
      return;
    }

    try {
      const bridge = { url: normalizedUrl, token: normalizedToken };
      const status = await syncBridgeWorkspaceRoot({
        bridge,
        preferredRoot: draftBridgeWorkspaceRoot || safeReadLocalStorage(bridgeWorkspaceRootKey),
      });
      safeWriteLocalStorage(bridgeUrlKey, normalizedUrl);
      safeWriteLocalStorage(bridgeTokenKey, normalizedToken);
      safeWriteLocalStorage(bridgeWorkspaceRootKey, status.workspaceRoot);
      setBridgeUrl(normalizedUrl);
      setBridgeToken(normalizedToken);
      setBridgeWorkspaceRoot(status.workspaceRoot);
      setDraftBridgeWorkspaceRoot(status.workspaceRoot);
      setConnectionError(undefined);
    } catch (error) {
      setConnectionError((error as Error).message);
    }
  }

  function handleForgetBridge() {
    safeWriteLocalStorage(bridgeUrlKey, "");
    safeWriteLocalStorage(bridgeTokenKey, "");
    safeWriteLocalStorage(bridgeWorkspaceRootKey, "");
    setBridgeUrl("");
    setBridgeToken("");
    setBridgeWorkspaceRoot("");
    setDraftBridgeUrl("");
    setDraftBridgeToken("");
    setDraftBridgeWorkspaceRoot("");
  }

  async function loadBridgeDirectory(path: string) {
    const bridge = draftBridgeUrl.trim() && draftBridgeToken.trim()
      ? { url: draftBridgeUrl.trim().replace(/\/$/, ""), token: draftBridgeToken.trim() }
      : bridgeUrl.trim() && bridgeToken.trim()
        ? { url: bridgeUrl.trim(), token: bridgeToken.trim() }
        : null;

    if (!bridge) {
      setBridgeBrowserError("Save the bridge URL and token before browsing.");
      return;
    }

    setBridgeBrowserLoading(true);
    setBridgeBrowserError(undefined);
    try {
      const result = await callBridge<BridgeListResult>(bridge, "list_workspace_files", {
        path,
        recursive: false,
        limit: 500,
      });
      setBridgeBrowserPath(result.root);
      setBridgeBrowserEntries(result.files);
    } catch (error) {
      setBridgeBrowserError((error as Error).message);
    } finally {
      setBridgeBrowserLoading(false);
    }
  }

  async function openBridgeBrowser() {
    setBridgeBrowserOpen(true);
    setNewFolderName("");
    const startPath = draftBridgeWorkspaceRoot.trim() || bridgeWorkspaceRoot || ".";
    await loadBridgeDirectory(startPath);
  }

  async function handleApplyBridgeWorkspaceRoot() {
    const bridge = draftBridgeUrl.trim() && draftBridgeToken.trim()
      ? { url: draftBridgeUrl.trim().replace(/\/$/, ""), token: draftBridgeToken.trim() }
      : bridgeUrl.trim() && bridgeToken.trim()
        ? { url: bridgeUrl.trim(), token: bridgeToken.trim() }
        : null;

    if (!bridge) {
      setConnectionError("Save the bridge URL and token before changing the workspace root.");
      return;
    }

    const path = draftBridgeWorkspaceRoot.trim();
    if (!path) {
      setConnectionError("Enter a workspace root path.");
      return;
    }

    const status = await callBridge<BridgeStatus>(bridge, "set_workspace_root", { path });
    safeWriteLocalStorage(bridgeWorkspaceRootKey, status.workspaceRoot);
    setBridgeWorkspaceRoot(status.workspaceRoot);
    setDraftBridgeWorkspaceRoot(status.workspaceRoot);
    setConnectionError(undefined);
    setBridgeBrowserOpen(false);
  }

  async function handleCreateBridgeFolder() {
    const bridge = draftBridgeUrl.trim() && draftBridgeToken.trim()
      ? { url: draftBridgeUrl.trim().replace(/\/$/, ""), token: draftBridgeToken.trim() }
      : bridgeUrl.trim() && bridgeToken.trim()
        ? { url: bridgeUrl.trim(), token: bridgeToken.trim() }
        : null;

    if (!bridge) {
      setBridgeBrowserError("Save the bridge URL and token before creating folders.");
      return;
    }

    const name = newFolderName.trim();
    if (!name) {
      setBridgeBrowserError("Enter a folder name.");
      return;
    }

    setBridgeBrowserLoading(true);
    setBridgeBrowserError(undefined);
    try {
      await callBridge(bridge, "create_directory", {
        parentPath: bridgeBrowserPath || draftBridgeWorkspaceRoot || bridgeWorkspaceRoot || ".",
        name,
      });
      setNewFolderName("");
      await loadBridgeDirectory(bridgeBrowserPath || draftBridgeWorkspaceRoot || bridgeWorkspaceRoot || ".");
    } catch (error) {
      setBridgeBrowserError((error as Error).message);
      setBridgeBrowserLoading(false);
    }
  }

  async function handleSaveSettings() {
    if (!updateSlotMeta) {
      setSaveError("Cannot save settings outside a slot container.");
      return;
    }

    setSaveError(undefined);
    try {
      await updateSlotMeta({
        title: metaDraft.title.trim(),
        model: metaDraft.model.trim(),
        systemPrompt: metaDraft.systemPrompt.trim(),
      });
      setSettingsOpen(false);
    } catch (error) {
      setSaveError((error as Error).message);
    }
  }

  async function runAgentSession(args: {
    initialInputItems: Array<InputMessageItem | ResponsesApiOutputItem | FunctionCallOutputItem>;
    contextBits: string[];
    bridge: BridgeConfig | null;
  }): Promise<AgentRunResult> {
    let inputItems = args.initialInputItems;
    let assistantText = "";
    let lastToolMessages: string[] = [];
    let shouldNavigate = false;

    for (let i = 0; i < TOOL_ITERATION_LIMIT; i++) {
      const response = await createOpenAiResponse({
        apiKey: apiKey.trim(),
        input: inputItems,
        model,
        instructions: args.contextBits.join(" "),
        tools: TOOL_DEFINITIONS,
      });

      const functionCalls = (response.output ?? []).filter(
        (item): item is ResponsesApiFunctionCall =>
          item.type === "function_call" &&
          typeof (item as ResponsesApiFunctionCall).name === "string" &&
          typeof (item as ResponsesApiFunctionCall).call_id === "string"
      );

      console.debug("[chat-codex] response loop", {
        iteration: i,
        functionCalls: functionCalls.map((call) => call.name),
      });

      if (!functionCalls.length) {
        assistantText = extractAssistantText(response) || "The model returned no text output.";
        return { assistantText, lastToolMessages, pending: null, shouldNavigate };
      }

      const toolOutputs: FunctionCallOutputItem[] = [];
      lastToolMessages = [];

      for (const call of functionCalls) {
        console.debug("[chat-codex] tool call", {
          name: call.name,
          arguments: call.arguments,
        });
        let result: ToolExecutionResult;
        try {
          result = await executeTool({
            toolCall: call,
            config,
            projectId,
            configBucket,
            configPath,
            getS3Client,
            getDdbClient,
            assetsTable,
            loadedResources: resources,
            registryEntries,
            bridge: args.bridge,
          });
        } catch (error) {
          result = formatToolError(call.name, error);
        }

        toolOutputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: result.output,
        });

        console.debug("[chat-codex] tool result", {
          name: call.name,
          toolMessage: result.toolMessage,
          outputPreview: result.output.slice(0, 300),
        });

        if (result.toolMessage) {
          lastToolMessages.push(result.toolMessage);
        }
        if (result.mutatedWorkspace) {
          shouldNavigate = true;
        }
      }

      inputItems = [
        ...inputItems,
        ...(response.output ?? []),
        ...toolOutputs,
      ];
    }

    return {
      assistantText:
        `I reached the current tool-work limit of ${TOOL_ITERATION_LIMIT} steps. ` +
        "I still have my current working context and can keep going from here if you want.",
      lastToolMessages,
      pending: {
        inputItems,
        contextBits: args.contextBits,
        lastToolMessages,
      },
      shouldNavigate,
    };
  }

  async function handleSend() {
    const input = composer.trim();
    if (!apiKey.trim() || !input) return;

    const userMessage = createMessage("user", input);
    const history = [...messages, userMessage];
    setMessages(history);
    setComposer("");
    setBusy(true);
    setPendingContinuation(null);
    persistChatSessionNow(chatSessionKey, {
      messages: history,
      composer: "",
      pendingContinuation: null,
    });
    setConnectionError(undefined);

    try {
      const bridge = bridgeUrl.trim() && bridgeToken.trim()
        ? { url: bridgeUrl.trim(), token: bridgeToken.trim() }
        : null;
      const contextBits: string[] = [
        systemPrompt,
        "You are running inside a browser-based project workspace shell.",
        "Prefer calling tools before making assumptions about project structure or available files/modules.",
        "When the user asks about information 'in here' or app documentation, start with project assets and registered resources before the local bridge workspace unless they explicitly ask for local files.",
        `Current project ID: ${projectId}.`,
        `Current module ID: ${config.id}.`,
        assetsTable ? `Project asset table is available as ${assetsTable}.` : "Project asset table is not configured.",
        `Loaded resource count: ${resources.size}.`,
        `Published module count: ${registryEntries.length}.`,
        bridge ? `Local bridge is connected with workspace root ${bridgeWorkspaceRoot || "unknown"}.` : "Local bridge is not connected.",
        user?.email ? `Signed-in user: ${user.email}.` : undefined,
      ].filter((value): value is string => Boolean(value));

      const session = await runAgentSession({
        initialInputItems: toInputItems(history),
        contextBits,
        bridge,
      });
      setPendingContinuation(session.pending);
      const nextMessages = [...history];
      if (session.lastToolMessages.length) {
        nextMessages.push(createMessage("tool", session.lastToolMessages.join("\n")));
      }
      nextMessages.push(createMessage("assistant", session.assistantText || "The model returned no text output."));
      setMessages(nextMessages);
      persistChatSessionNow(chatSessionKey, {
        messages: nextMessages,
        composer: "",
        pendingContinuation: session.pending,
      });
      if (session.shouldNavigate) {
        window.dispatchEvent(new Event("shell:navigate"));
      }
    } catch (error) {
      console.debug("[chat-codex] tool loop error", {
        message: (error as Error).message,
      });
      setMessages((current) => [
        ...current,
        createMessage("error", (error as Error).message),
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function handleContinueWorking() {
    const pending = pendingContinuation;
    if (!apiKey.trim() || !pending || busy) return;

    setBusy(true);
    setPendingContinuation(null);
    setConnectionError(undefined);

    try {
      const bridge = bridgeUrl.trim() && bridgeToken.trim()
        ? { url: bridgeUrl.trim(), token: bridgeToken.trim() }
        : null;
      const session = await runAgentSession({
        initialInputItems: pending.inputItems,
        contextBits: pending.contextBits,
        bridge,
      });
      setPendingContinuation(session.pending);
      const nextMessages = [...messages];
      if (session.lastToolMessages.length) {
        nextMessages.push(createMessage("tool", session.lastToolMessages.join("\n")));
      }
      nextMessages.push(createMessage("assistant", session.assistantText || "The model returned no text output."));
      setMessages(nextMessages);
      persistChatSessionNow(chatSessionKey, {
        messages: nextMessages,
        composer,
        pendingContinuation: session.pending,
      });
      if (session.shouldNavigate) {
        window.dispatchEvent(new Event("shell:navigate"));
      }
    } catch (error) {
      console.debug("[chat-codex] continuation error", {
        message: (error as Error).message,
      });
      setMessages((current) => [
        ...current,
        createMessage("error", (error as Error).message),
      ]);
    } finally {
      setBusy(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }

  function clearConversation() {
    setPendingContinuation(null);
    setComposer("");
    setMessages([]);
    persistChatSessionNow(chatSessionKey, {
      messages: [],
      composer: "",
      pendingContinuation: null,
    });
  }

  return (
    <div style={{ height: "100%", display: "grid", gridTemplateRows: "auto 1fr auto", background: C.bg, color: C.text, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem 0.9rem", borderBottom: `1px solid ${C.border}`, background: C.panel }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: "0.95rem", fontWeight: 700 }}>{title}</div>
          <div style={{ fontSize: "0.74rem", color: C.muted }}>
            {model} · OpenAI {connectionLabel} · Bridge {bridgeLabel}
          </div>
        </div>
        <button onClick={clearConversation} style={ghostButtonStyle}>
          Clear
        </button>
        <button onClick={() => setSettingsOpen((value) => !value)} style={ghostButtonStyle}>
          {settingsOpen ? "Close" : "Settings"}
        </button>
      </div>

      {settingsOpen && (
        <div style={{ padding: "0.9rem", borderBottom: `1px solid ${C.border}`, background: C.panelAlt, display: "grid", gap: "0.7rem" }}>
          <div style={{ display: "grid", gap: "0.35rem" }}>
            <label style={labelStyle}>OpenAI API key</label>
            <div style={{ display: "flex", gap: "0.55rem", flexWrap: "wrap" }}>
              <input
                value={draftApiKey}
                onChange={(event) => setDraftApiKey(event.currentTarget.value)}
                placeholder="sk-..."
                type="password"
                style={{ ...inputStyle, flex: "1 1 280px" }}
              />
              <button onClick={handleConnect} style={primaryButtonStyle}>
                Save Locally
              </button>
              {apiKey && (
                <button onClick={handleDisconnect} style={dangerButtonStyle}>
                  Forget Key
                </button>
              )}
            </div>
            <div style={{ fontSize: "0.72rem", color: C.muted }}>
              Stored only in this browser for this project/module instance. It is not written into shared project config.
            </div>
            {connectionError && <div style={{ fontSize: "0.74rem", color: C.danger }}>{connectionError}</div>}
          </div>

          <div style={{ display: "grid", gap: "0.35rem" }}>
            <label style={labelStyle}>Local bridge</label>
            <input
              value={draftBridgeUrl}
              onChange={(event) => setDraftBridgeUrl(event.currentTarget.value)}
              placeholder="http://127.0.0.1:4317"
              style={inputStyle}
            />
            <input
              value={draftBridgeToken}
              onChange={(event) => setDraftBridgeToken(event.currentTarget.value)}
              placeholder="Bridge token"
              type="password"
              style={inputStyle}
            />
            <div style={{ display: "flex", gap: "0.55rem", flexWrap: "wrap" }}>
              <button onClick={handleSaveBridge} style={primaryButtonStyle}>
                Save Bridge
              </button>
              {(bridgeUrl || bridgeToken) && (
                <button onClick={handleForgetBridge} style={dangerButtonStyle}>
                  Forget Bridge
                </button>
              )}
            </div>
            <div style={{ fontSize: "0.72rem", color: C.muted }}>
              Used for local file access, command execution, and host-side analysis tools.
            </div>
            <input
              value={draftBridgeWorkspaceRoot}
              onChange={(event) => setDraftBridgeWorkspaceRoot(event.currentTarget.value)}
              placeholder={bridgeWorkspaceRoot || "Workspace root path"}
              style={inputStyle}
            />
            <div style={{ display: "flex", gap: "0.55rem", flexWrap: "wrap", alignItems: "center" }}>
              <button onClick={() => void handleApplyBridgeWorkspaceRoot()} style={primaryButtonStyle}>
                Set Workspace Root
              </button>
              <button onClick={() => void openBridgeBrowser()} style={ghostButtonStyle}>
                Browse...
              </button>
              <span style={{ fontSize: "0.72rem", color: C.muted }}>
                Current root: {bridgeWorkspaceRoot || "not set"}
              </span>
            </div>
          </div>

          {editMode && (
            <>
              <div style={{ display: "grid", gap: "0.35rem" }}>
                <label style={labelStyle}>Module title</label>
                <input
                  value={metaDraft.title}
                  onChange={(event) => setMetaDraft((current) => ({ ...current, title: event.currentTarget.value }))}
                  style={inputStyle}
                />
              </div>
              <div style={{ display: "grid", gap: "0.35rem" }}>
                <label style={labelStyle}>Model</label>
                <input
                  value={metaDraft.model}
                  onChange={(event) => setMetaDraft((current) => ({ ...current, model: event.currentTarget.value }))}
                  style={inputStyle}
                />
              </div>
              <div style={{ display: "grid", gap: "0.35rem" }}>
                <label style={labelStyle}>System prompt</label>
                <textarea
                  value={metaDraft.systemPrompt}
                  onChange={(event) => setMetaDraft((current) => ({ ...current, systemPrompt: event.currentTarget.value }))}
                  rows={4}
                  style={{ ...inputStyle, resize: "vertical", minHeight: 92 }}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", flexWrap: "wrap" }}>
                <button disabled={!canSaveSettings} onClick={handleSaveSettings} style={primaryButtonStyle}>
                  Save Module Settings
                </button>
                {saveError && <span style={{ fontSize: "0.74rem", color: C.danger }}>{saveError}</span>}
              </div>
            </>
          )}
        </div>
      )}

      <div ref={scrollRef} style={{ minHeight: 0, overflowY: "auto", padding: "1rem", display: "grid", gap: "0.8rem", alignContent: messages.length ? "start" : "center" }}>
        {messages.length === 0 ? (
          <div style={{ maxWidth: 720, margin: "0 auto", padding: "1.2rem 1.25rem", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16 }}>
            <div style={{ fontSize: "0.95rem", fontWeight: 700, marginBottom: "0.45rem" }}>Workspace-side Codex test module</div>
            <div style={{ fontSize: "0.82rem", lineHeight: 1.6, color: C.muted }}>
              This version can inspect the workspace, browse assets and resources, list published modules, add, update, or remove top-level slots, and use a local bridge for files, commands, and PDF analysis.
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} style={{ display: "flex", justifyContent: message.role === "user" ? "flex-end" : "flex-start" }}>
              <div style={bubbleStyle(message.role)}>
                <div style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.08em", color: C.muted, marginBottom: "0.3rem" }}>
                  {message.role === "user" ? "You" : message.role === "assistant" ? "Codex" : message.role === "tool" ? "Tool" : "Error"}
                </div>
                <div style={{ fontSize: "0.86rem", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{message.text}</div>
              </div>
            </div>
          ))
        )}
        {busy && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div style={bubbleStyle("assistant")}>
              <div style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.08em", color: C.muted, marginBottom: "0.3rem" }}>
                Codex
              </div>
              <div style={{ fontSize: "0.86rem", lineHeight: 1.6, color: C.muted }}>Thinking and possibly using tools...</div>
            </div>
          </div>
        )}
      </div>

      <div style={{ borderTop: `1px solid ${C.border}`, background: C.panel, padding: "0.85rem" }}>
        {!apiKey && (
          <div style={{ marginBottom: "0.65rem", fontSize: "0.76rem", color: C.warning }}>
            Open Settings and add an OpenAI API key before sending messages.
          </div>
        )}
        {continuationPending && (
          <div style={{ marginBottom: "0.65rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", padding: "0.7rem 0.85rem", border: `1px solid ${C.border}`, borderRadius: 12, background: "#0d1d31" }}>
            <div style={{ fontSize: "0.76rem", color: C.muted }}>
              The agent paused after {TOOL_ITERATION_LIMIT} tool steps and still has its working context in memory.
            </div>
            <button disabled={busy} onClick={() => void handleContinueWorking()} style={primaryButtonStyle}>
              Continue Working
            </button>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "0.65rem", alignItems: "end" }}>
          <textarea
            value={composer}
            onChange={(event) => setComposer(event.currentTarget.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Ask Codex to inspect the workspace or make a concrete module/config change..."
            rows={3}
            style={{ ...inputStyle, resize: "none", minHeight: 84 }}
          />
          <button disabled={!canSend} onClick={handleSend} style={sendButtonStyle(canSend)}>
            {busy ? "Sending..." : "Send"}
          </button>
        </div>
      </div>

      {bridgeBrowserOpen && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(3,8,15,0.76)", display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem", zIndex: 40 }}>
          <div style={{ width: "min(820px, 100%)", maxHeight: "min(720px, 92vh)", display: "grid", gridTemplateRows: "auto auto 1fr auto", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, overflow: "hidden", boxShadow: "0 28px 80px rgba(0,0,0,0.45)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", padding: "0.9rem 1rem", borderBottom: `1px solid ${C.border}` }}>
              <div>
                <div style={{ fontSize: "0.92rem", fontWeight: 700 }}>Choose Workspace Root</div>
                <div style={{ fontSize: "0.75rem", color: C.muted }}>{bridgeBrowserPath || "Loading..."}</div>
              </div>
              <button onClick={() => setBridgeBrowserOpen(false)} style={ghostButtonStyle}>Close</button>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.55rem", alignItems: "center", padding: "0.85rem 1rem", borderBottom: `1px solid ${C.border}` }}>
              <button
                onClick={() => void loadBridgeDirectory(parentPath(bridgeBrowserPath || draftBridgeWorkspaceRoot || bridgeWorkspaceRoot || "."))}
                style={ghostButtonStyle}
                disabled={bridgeBrowserLoading}
              >
                Up
              </button>
              <button
                onClick={() => void handleApplyBridgeWorkspaceRoot()}
                style={primaryButtonStyle}
                disabled={bridgeBrowserLoading || !draftBridgeWorkspaceRoot.trim()}
              >
                Use Current Folder
              </button>
              <input
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.currentTarget.value)}
                placeholder="New folder name"
                style={{ ...inputStyle, flex: "1 1 220px", minWidth: 180 }}
              />
              <button onClick={() => void handleCreateBridgeFolder()} style={ghostButtonStyle} disabled={bridgeBrowserLoading}>
                Create Folder
              </button>
            </div>

            <div style={{ minHeight: 0, overflowY: "auto", padding: "0.8rem 1rem" }}>
              {bridgeBrowserLoading && <div style={{ fontSize: "0.82rem", color: C.muted }}>Loading folders...</div>}
              {bridgeBrowserError && <div style={{ fontSize: "0.82rem", color: C.danger }}>{bridgeBrowserError}</div>}
              {!bridgeBrowserLoading && !bridgeBrowserError && (
                <div style={{ display: "grid", gap: "0.45rem" }}>
                  {bridgeBrowserEntries
                    .filter((entry) => entry.kind === "directory")
                    .sort((a, b) => a.path.localeCompare(b.path))
                    .map((entry) => {
                      const nextPath = `${bridgeBrowserPath.replace(/[\\/]+$/, "")}/${entry.path}`.replaceAll("//", "/");
                      return (
                        <div key={entry.path} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "0.55rem", alignItems: "center", padding: "0.6rem 0.75rem", border: `1px solid ${C.border}`, borderRadius: 10, background: "#091423" }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: "0.84rem", fontWeight: 600 }}>{entry.path}</div>
                            <div style={{ fontSize: "0.72rem", color: C.muted }}>Folder</div>
                          </div>
                          <button onClick={() => void loadBridgeDirectory(nextPath)} style={ghostButtonStyle}>
                            Open
                          </button>
                          <button
                            onClick={() => {
                              setDraftBridgeWorkspaceRoot(nextPath);
                              setBridgeBrowserPath(nextPath);
                            }}
                            style={primaryButtonStyle}
                          >
                            Select
                          </button>
                        </div>
                      );
                    })}
                  {bridgeBrowserEntries.filter((entry) => entry.kind === "directory").length === 0 && (
                    <div style={{ fontSize: "0.8rem", color: C.muted }}>No subfolders found here.</div>
                  )}
                </div>
              )}
            </div>

            <div style={{ padding: "0.8rem 1rem", borderTop: `1px solid ${C.border}`, fontSize: "0.74rem", color: C.muted }}>
              Selected path: {draftBridgeWorkspaceRoot || bridgeBrowserPath || "none"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const labelStyle: CSSProperties = {
  fontSize: "0.72rem",
  color: C.muted,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const inputStyle: CSSProperties = {
  width: "100%",
  border: `1px solid ${C.border}`,
  borderRadius: 10,
  background: "#071321",
  color: C.text,
  padding: "0.65rem 0.8rem",
  fontSize: "0.84rem",
  boxSizing: "border-box",
  outline: "none",
};

const ghostButtonStyle: CSSProperties = {
  border: `1px solid ${C.border}`,
  borderRadius: 999,
  background: "transparent",
  color: C.text,
  fontSize: "0.76rem",
  padding: "0.45rem 0.8rem",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 999,
  background: C.accent,
  color: "#062b29",
  fontWeight: 700,
  fontSize: "0.78rem",
  padding: "0.6rem 0.95rem",
  cursor: "pointer",
};

const dangerButtonStyle: CSSProperties = {
  border: `1px solid ${C.border}`,
  borderRadius: 999,
  background: "transparent",
  color: C.danger,
  fontWeight: 700,
  fontSize: "0.78rem",
  padding: "0.6rem 0.95rem",
  cursor: "pointer",
};

function bubbleStyle(role: ChatMessage["role"]): CSSProperties {
  return {
    maxWidth: "min(760px, 90%)",
    padding: "0.9rem 1rem",
    borderRadius: 16,
    border: `1px solid ${C.border}`,
    background:
      role === "user" ? C.userBubble :
      role === "assistant" ? C.assistantBubble :
      role === "tool" ? C.toolBubble :
      C.errorBubble,
  };
}

function sendButtonStyle(enabled: boolean): CSSProperties {
  return {
    alignSelf: "stretch",
    minWidth: 110,
    border: "none",
    borderRadius: 14,
    background: enabled ? C.accentStrong : "#17304d",
    color: enabled ? "#ecfeff" : "#6b87ab",
    fontWeight: 700,
    fontSize: "0.84rem",
    padding: "0.8rem 1rem",
    cursor: enabled ? "pointer" : "default",
  };
}
