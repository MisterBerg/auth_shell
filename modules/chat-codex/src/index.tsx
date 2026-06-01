import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
import {
  assignPaths,
  createLinkedPage,
  getDocKey,
  getStorageConfig,
  loadDocumentationState,
  moveDoc,
  removeDoc,
  renameDoc,
  writeTextObject,
  deleteObjectIfExists,
  type ContentMap,
  type DocumentationManifest,
  type LinkAction,
  type MoveDirection,
  type StorageConfig,
} from "../../documentation-viewer/src/model.ts";

type ChatMeta = {
  title?: string;
  model?: string;
  systemPrompt?: string;
};

type AgentBridgeDefaults = {
  url?: string;
  token?: string;
  installBaseUrl?: string;
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
  workspaceRoot: string | null;
  pythonRoot?: string;
  browseStartPath?: string;
};

type BridgeHealth = {
  status: string;
  name?: string;
  protocolVersion?: number;
  capabilities?: string[];
  requiresPairingToken?: boolean;
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

type BridgeAppspaceOperation = {
  id: string;
  operation: string;
  args: Record<string, unknown>;
  status: "queued" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
};

type BridgeAppspaceOperationsResult = {
  sessionId: string;
  count: number;
  operations: BridgeAppspaceOperation[];
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

type OrganizerItemKind = "note" | "todo" | "follow-up" | "waiting-on" | "idea" | "reminder";
type OrganizerItemStatus = "open" | "active" | "done" | "archived";
type OrganizerTimingState = "overdue" | "upcoming" | "no-dates";

type OrganizerItem = {
  id: string;
  kind: OrganizerItemKind;
  title: string;
  details: string;
  status: OrganizerItemStatus;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  dueAt?: string;
  followUpAt?: string;
  linkedWorkItemIds: string[];
};

type OrganizerStore = {
  version: 1;
  projectId: string;
  items: OrganizerItem[];
};

type OrganizerItemInput = {
  id?: string;
  kind?: OrganizerItemKind;
  title: string;
  details?: string;
  status?: OrganizerItemStatus;
  tags?: string[];
  dueAt?: string;
  followUpAt?: string;
  linkedWorkItemIds?: string[];
};

type AgentRunResult = {
  assistantText: string;
  lastToolMessages: string[];
  pending: PendingContinuation | null;
  shouldNavigate: boolean;
};

type AgentProgressEvent =
  | { kind: "status"; text: string }
  | { kind: "tool_call"; name: string; arguments: string }
  | { kind: "tool_result"; name: string; text: string };

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

type TaskStatus = "open" | "in-progress" | "blocked" | "done" | "archived";
type TaskPriority = "low" | "normal" | "high" | "urgent";

type TaskAttachment = {
  id: string;
  name: string;
  bucket: string;
  key: string;
  size: number;
  contentType?: string;
  uploadedAt: string;
  uploadedBy?: string;
};

type TaskRecord = {
  id: string;
  title: string;
  description: string;
  notes: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee?: string;
  tags: string[];
  repeatable: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  attachments: TaskAttachment[];
};

type TaskStore = {
  version: 1;
  projectId: string;
  tasks: TaskRecord[];
};

type WorkKind = "task" | "event" | "task-event" | "milestone";
type WorkStatus = "open" | "in-progress" | "blocked" | "done" | "archived";
type WorkPriority = "low" | "normal" | "high" | "urgent";

type WorkAttachment = {
  id: string;
  name: string;
  bucket: string;
  key: string;
  size: number;
  contentType?: string;
  uploadedAt: string;
  uploadedBy?: string;
};

type WorkItem = {
  id: string;
  kind: WorkKind;
  title: string;
  description: string;
  notes: string;
  status: WorkStatus;
  priority: WorkPriority;
  assignee?: string;
  tags: string[];
  repeatable: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  attachments: WorkAttachment[];
  startAt?: string;
  durationDays?: number;
  allDay: boolean;
  location?: string;
  progress: number;
  dependencies: string[];
  lane?: string;
};

type WorkStore = {
  version: 1;
  projectId: string;
  items: WorkItem[];
};

type WorkItemInput = Partial<WorkItem> & {
  title: string;
  dependencyTitles?: string[];
};

const DEFAULT_MODEL = "gpt-5.2-codex";
const DEFAULT_TITLE = "Codex Chat";
const TOOL_ITERATION_LIMIT = 20;
const BROWSER_CONTEXT_ITEM_LIMIT = 18;
const BROWSER_CONTEXT_CHAR_BUDGET = 24000;
const BROWSER_CONTEXT_SUMMARY_LIMIT = 2800;
const DEFAULT_PROMPT = [
  "You are helping build and evolve this workspace.",
  "Use the provided workspace tools whenever project structure, assets, resources, or modules are relevant.",
  "By default, treat 'the app', 'the webapp', 'app data', 'documentation here', and similar phrases as referring to the active project configuration, project assets, and registered resources inside the web app.",
  "Prefer project assets, registered resources, and root-config information before searching the local bridge workspace unless the user explicitly says workspace, local files, repo, filesystem, or disk, or recent conversation is clearly about local workspace operations.",
  "Prefer module-native tools for task tracker, documentation, markdown, document-viewer, links, and webview data when they are available instead of editing their backing files indirectly.",
  "Use shell commands only when no better dedicated tool is available, and pay attention to command failures.",
  "Prefer the managed Python tools for parsing, transformations, text extraction, and small file-oriented programs instead of shell-embedded Python.",
  "Only install Python packages through the dedicated dependency installer, and only when a missing dependency blocks the task.",
  "When using run_workspace_command, provide the shell body only. Do not prefix it with powershell, pwsh, cmd, or sh.",
  "On Windows, assume the bridge will run the command inside PowerShell; set $ErrorActionPreference='Stop' and ensure parent directories exist first when needed.",
  "If a tool returns an error, read it carefully, explain what failed if asked, and change approach instead of pretending the tool succeeded.",
  "When changing the workspace, explain what you changed and why.",
  "Do not claim a change happened unless the tool call succeeded.",
].join(" ");

const WORK_ITEM_INPUT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: ["task", "event", "task-event", "milestone"] },
    title: { type: "string" },
    description: { type: "string" },
    notes: { type: "string" },
    status: { type: "string", enum: ["open", "in-progress", "blocked", "done", "archived"] },
    priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
    assignee: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    repeatable: { type: "boolean" },
    startAt: { type: "string", description: "ISO timestamp or YYYY-MM-DD date." },
    durationDays: { type: "integer", minimum: 0 },
    allDay: { type: "boolean" },
    location: { type: "string" },
    progress: { type: "number", minimum: 0, maximum: 100 },
    dependencies: { type: "array", items: { type: "string" }, description: "Work item ids this item depends on." },
    dependencyTitles: { type: "array", items: { type: "string" }, description: "Dependency titles to resolve to ids during this operation." },
    lane: { type: "string" },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

const WORK_ITEM_PATCH_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["task", "event", "task-event", "milestone"] },
    title: { type: "string" },
    description: { type: "string" },
    notes: { type: "string" },
    status: { type: "string", enum: ["open", "in-progress", "blocked", "done", "archived"] },
    priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
    assignee: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    repeatable: { type: "boolean" },
    startAt: { type: "string", description: "ISO timestamp or YYYY-MM-DD date. Empty string clears the date." },
    durationDays: { type: "integer", minimum: 0 },
    allDay: { type: "boolean" },
    location: { type: "string" },
    progress: { type: "number", minimum: 0, maximum: 100 },
    dependencies: { type: "array", items: { type: "string" } },
    dependencyTitles: { type: "array", items: { type: "string" } },
    lane: { type: "string" },
  },
  additionalProperties: false,
} as const;

const ORGANIZER_ITEM_INPUT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: ["note", "todo", "follow-up", "waiting-on", "idea", "reminder"] },
    title: { type: "string" },
    details: { type: "string" },
    status: { type: "string", enum: ["open", "active", "done", "archived"] },
    tags: { type: "array", items: { type: "string" } },
    dueAt: { type: "string", description: "ISO timestamp or YYYY-MM-DD date." },
    followUpAt: { type: "string", description: "ISO timestamp or YYYY-MM-DD date." },
    linkedWorkItemIds: { type: "array", items: { type: "string" } },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

const ORGANIZER_ITEM_PATCH_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["note", "todo", "follow-up", "waiting-on", "idea", "reminder"] },
    title: { type: "string" },
    details: { type: "string" },
    status: { type: "string", enum: ["open", "active", "done", "archived"] },
    tags: { type: "array", items: { type: "string" } },
    dueAt: { type: "string", description: "ISO timestamp or YYYY-MM-DD date. Empty string clears the date." },
    followUpAt: { type: "string", description: "ISO timestamp or YYYY-MM-DD date. Empty string clears the date." },
    linkedWorkItemIds: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
} as const;

const ORGANIZER_TIMING_STATE_SCHEMA = {
  type: "string",
  enum: ["overdue", "upcoming", "no-dates"],
} as const;

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
    name: "get_appspace_context",
    description: "Return the current browser appspace context snapshot that is also published to the local bridge when enabled.",
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
    name: "export_project_asset_to_workspace",
    description: "Export a central project asset to a file in the local bridge workspace so the local runtime can inspect or modify it.",
    parameters: {
      type: "object",
      properties: {
        assetId: { type: "string" },
        path: { type: "string" },
        workspacePath: { type: "string" },
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
    name: "create_markdown_slot_from_content",
    description: "Create a markdown-viewer slot and its backing markdown file-set asset in one operation.",
    parameters: {
      type: "object",
      properties: {
        parentSlotPath: { type: "array", items: { type: "string" } },
        slotId: { type: "string" },
        title: { type: "string" },
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
      required: ["slotId", "title", "entryPath", "files"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_document_viewer_slot",
    description: "Create a document-viewer slot wired either to an existing PDF asset or by importing a local workspace PDF.",
    parameters: {
      type: "object",
      properties: {
        parentSlotPath: { type: "array", items: { type: "string" } },
        slotId: { type: "string" },
        title: { type: "string" },
        assetId: { type: "string" },
        workspacePath: { type: "string" },
        filename: { type: "string" },
        label: { type: "string" },
      },
      required: ["slotId", "title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_task_tracker_slot",
    description: "Create a task-tracker slot and optionally seed it with initial tasks in one operation.",
    parameters: {
      type: "object",
      properties: {
        parentSlotPath: { type: "array", items: { type: "string" } },
        slotId: { type: "string" },
        title: { type: "string" },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              notes: { type: "string" },
              status: { type: "string", enum: ["open", "in-progress", "blocked", "done", "archived"] },
              priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
              assignee: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              repeatable: { type: "boolean" },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      required: ["slotId", "title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_documentation_slot",
    description: "Create a documentation-viewer slot and initialize it with starter pages and content in one operation.",
    parameters: {
      type: "object",
      properties: {
        parentSlotPath: { type: "array", items: { type: "string" } },
        slotId: { type: "string" },
        title: { type: "string" },
        pages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              content: { type: "string" },
              action: { type: "string", enum: ["child", "sibling"] },
              afterDocTitle: { type: "string" },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      required: ["slotId", "title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_work_manager_slot",
    description: "Create a work-manager slot and optionally seed it with schedule items, milestones, dependencies, lanes, dates, and progress.",
    parameters: {
      type: "object",
      properties: {
        parentSlotPath: { type: "array", items: { type: "string" } },
        slotId: { type: "string" },
        title: { type: "string" },
        items: {
          type: "array",
          items: WORK_ITEM_INPUT_SCHEMA,
        },
      },
      required: ["slotId", "title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_organizer_items",
    description: "List organizer memory items stored for this chat module instance. Supports text, kind, status, and semantic timing filters such as overdue or upcoming.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string", enum: ["note", "todo", "follow-up", "waiting-on", "idea", "reminder"] },
        status: { type: "string", enum: ["open", "active", "done", "archived"] },
        timingState: ORGANIZER_TIMING_STATE_SCHEMA,
        includeArchived: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_organizer_items",
    description: "Create one or more organizer memory items such as notes, todos, follow-ups, reminders, or waiting-on entries.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          items: ORGANIZER_ITEM_INPUT_SCHEMA,
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "update_organizer_item",
    description: "Update an existing organizer memory item by id.",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        patch: ORGANIZER_ITEM_PATCH_SCHEMA,
      },
      required: ["itemId", "patch"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "delete_organizer_item",
    description: "Delete an organizer memory item by id.",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "batch_update_organizer_items",
    description: "Update several organizer memory items in one call using the same patch.",
    parameters: {
      type: "object",
      properties: {
        itemIds: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
        },
        patch: ORGANIZER_ITEM_PATCH_SCHEMA,
      },
      required: ["itemIds", "patch"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "mark_organizer_items_complete",
    description: "Mark one or more organizer memory items complete by setting their status to done.",
    parameters: {
      type: "object",
      properties: {
        itemIds: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
        },
      },
      required: ["itemIds"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_work_manager_items",
    description: "List work items from a work-manager module slot by its full slot path. Supports text filtering over titles, notes, tags, lanes, assignees, and dependencies.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        query: { type: "string" },
      },
      required: ["slotPath"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_work_manager_items",
    description: "Create one or more work-manager schedule items. Dependencies can be provided by id or by title.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        items: {
          type: "array",
          minItems: 1,
          items: WORK_ITEM_INPUT_SCHEMA,
        },
      },
      required: ["slotPath", "items"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "update_work_manager_item",
    description: "Update a work-manager item by id. Dependencies can be provided by id or by title.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        itemId: { type: "string" },
        patch: WORK_ITEM_PATCH_SCHEMA,
      },
      required: ["slotPath", "itemId", "patch"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "delete_work_manager_item",
    description: "Delete a work-manager item by id and remove that id from other items' dependency lists. Set deleteAttachments to also delete attached S3 objects.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        itemId: { type: "string" },
        deleteAttachments: { type: "boolean" },
      },
      required: ["slotPath", "itemId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "attach_project_asset_to_work_item",
    description: "Attach an existing central project asset version to a work-manager item.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        itemId: { type: "string" },
        assetId: { type: "string" },
      },
      required: ["slotPath", "itemId", "assetId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "replace_work_manager_items",
    description: "Replace or upsert the complete work-manager schedule from structured items. Use replaceExisting=true only when intentionally replacing the whole schedule.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        replaceExisting: { type: "boolean" },
        items: {
          type: "array",
          items: WORK_ITEM_INPUT_SCHEMA,
        },
      },
      required: ["slotPath", "items"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_markdown_slot",
    description: "Read the current markdown-viewer slot content, including its file-set manifest and truncated file contents.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        maxCharsPerFile: { type: "integer", minimum: 200, maximum: 50000 },
      },
      required: ["slotPath"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "replace_markdown_slot_content",
    description: "Replace a markdown-viewer slot's backing file set in one operation by creating a fresh asset version and rewiring the slot.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        title: { type: "string" },
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
      required: ["slotPath", "entryPath", "files"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_links_slot",
    description: "Create a links module slot with an initial set of links.",
    parameters: {
      type: "object",
      properties: {
        parentSlotPath: { type: "array", items: { type: "string" } },
        slotId: { type: "string" },
        title: { type: "string" },
        links: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              url: { type: "string" },
            },
            required: ["text", "url"],
            additionalProperties: false,
          },
        },
      },
      required: ["slotId", "title", "links"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "set_links_slot_items",
    description: "Replace the configured links inside a links module slot.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        links: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              url: { type: "string" },
            },
            required: ["text", "url"],
            additionalProperties: false,
          },
        },
      },
      required: ["slotPath", "links"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_webview_slot",
    description: "Create a webview slot with an initial URL.",
    parameters: {
      type: "object",
      properties: {
        parentSlotPath: { type: "array", items: { type: "string" } },
        slotId: { type: "string" },
        title: { type: "string" },
        url: { type: "string" },
      },
      required: ["slotId", "title", "url"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "set_webview_url",
    description: "Update the URL inside a webview slot.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        url: { type: "string" },
      },
      required: ["slotPath", "url"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "replace_document_viewer_asset",
    description: "Replace the configured document in a document-viewer slot using either an existing asset or a local workspace file import.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        assetId: { type: "string" },
        workspacePath: { type: "string" },
        filename: { type: "string" },
        label: { type: "string" },
      },
      required: ["slotPath"],
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
    name: "write_workspace_file",
    description: "Write a file through the local workspace bridge.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"] },
        mode: { type: "string", enum: ["overwrite", "append"] },
      },
      required: ["path", "content"],
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
    name: "focus_slot",
    description: "Navigate the browser to a project if needed, then scroll to and highlight a specific slot path in the current app-space.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        bucket: { type: "string" },
        configPath: { type: "string" },
      },
      required: ["slotPath"],
      additionalProperties: false,
    },
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
    name: "list_task_tracker_tasks",
    description: "List tasks from a task-tracker module slot by its full slot path.",
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
  },
  {
    type: "function",
    name: "create_task_tracker_tasks",
    description: "Create one or more tasks inside a task-tracker module slot.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        tasks: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              notes: { type: "string" },
              status: { type: "string", enum: ["open", "in-progress", "blocked", "done", "archived"] },
              priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
              assignee: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              repeatable: { type: "boolean" },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      required: ["slotPath", "tasks"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "update_task_tracker_task",
    description: "Update an existing task inside a task-tracker module slot.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        taskId: { type: "string" },
        patch: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            notes: { type: "string" },
            status: { type: "string", enum: ["open", "in-progress", "blocked", "done", "archived"] },
            priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
            assignee: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            repeatable: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      required: ["slotPath", "taskId", "patch"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "delete_task_tracker_task",
    description: "Delete a task from a task-tracker module slot by id.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        taskId: { type: "string" },
      },
      required: ["slotPath", "taskId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "attach_project_asset_to_task",
    description: "Attach an existing central project asset version to a task-tracker task.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        taskId: { type: "string" },
        assetId: { type: "string" },
      },
      required: ["slotPath", "taskId", "assetId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_documentation_tree",
    description: "Read the manifest and page summaries for a documentation-viewer module slot.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        includeContent: { type: "boolean" },
        maxCharsPerDoc: { type: "integer", minimum: 200, maximum: 50000 },
      },
      required: ["slotPath"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_documentation_content",
    description: "Search titles and markdown content inside a documentation-viewer module slot and return matching pages with snippets.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        maxSnippetChars: { type: "integer", minimum: 80, maximum: 4000 },
      },
      required: ["slotPath", "query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_documentation_pages",
    description: "Read specific documentation-viewer pages by doc id, including full or truncated content.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        docIds: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        maxCharsPerDoc: { type: "integer", minimum: 200, maximum: 50000 },
      },
      required: ["slotPath", "docIds"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_documentation_page",
    description: "Create a child or sibling page in a documentation-viewer module slot.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        currentDocId: { type: "string" },
        title: { type: "string" },
        action: { type: "string", enum: ["child", "sibling"] },
        content: { type: "string" },
      },
      required: ["slotPath", "currentDocId", "title", "action"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "update_documentation_page",
    description: "Replace the markdown content of a documentation-viewer page.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        docId: { type: "string" },
        content: { type: "string" },
      },
      required: ["slotPath", "docId", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "rename_documentation_page",
    description: "Rename a documentation-viewer page title.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        docId: { type: "string" },
        title: { type: "string" },
      },
      required: ["slotPath", "docId", "title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "move_documentation_page",
    description: "Reorder or reparent a documentation-viewer page using the module's native move directions.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        docId: { type: "string" },
        direction: { type: "string", enum: ["up", "down", "promote", "demote"] },
      },
      required: ["slotPath", "docId", "direction"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "delete_documentation_page",
    description: "Delete a page from a documentation-viewer module slot.",
    parameters: {
      type: "object",
      properties: {
        slotPath: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        docId: { type: "string" },
      },
      required: ["slotPath", "docId"],
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

function buildBridgeEnabledKey(projectId: string, moduleId: string) {
  return `auth-shell:chat-codex:${projectId}:${moduleId}:bridge-enabled`;
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

function normalizeExternalUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function arrayBufferToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeTaskId(): string {
  const cryptoId = globalThis.crypto?.randomUUID?.();
  return cryptoId ? `task-${cryptoId}` : `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeAttachmentId(): string {
  const cryptoId = globalThis.crypto?.randomUUID?.();
  return cryptoId ? `att-${cryptoId}` : `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeWorkId(): string {
  const cryptoId = globalThis.crypto?.randomUUID?.();
  return cryptoId ? `work-${cryptoId}` : `work-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeOrganizerItemId(): string {
  const cryptoId = globalThis.crypto?.randomUUID?.();
  return cryptoId ? `org-${cryptoId}` : `org-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dirnamePath(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx) : "";
}

function normalizeOptionalDate(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${fieldName} must be a string.`);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${fieldName}: ${value}`);
  return date.toISOString();
}

function defaultOrganizerItem(userEmail?: string, partial?: Partial<OrganizerItem>): OrganizerItem {
  const at = nowIso();
  return {
    id: partial?.id ?? makeOrganizerItemId(),
    kind: partial?.kind ?? "note",
    title: partial?.title ?? "New note",
    details: partial?.details ?? "",
    status: partial?.status ?? "open",
    tags: partial?.tags ?? [],
    createdAt: partial?.createdAt ?? at,
    updatedAt: partial?.updatedAt ?? at,
    createdBy: partial?.createdBy ?? userEmail,
    dueAt: partial?.dueAt,
    followUpAt: partial?.followUpAt,
    linkedWorkItemIds: partial?.linkedWorkItemIds ?? [],
  };
}

function normalizeOrganizerItem(args: {
  input: OrganizerItemInput | Partial<OrganizerItem>;
  existing?: OrganizerItem;
  userEmail?: string;
}): OrganizerItem {
  const at = nowIso();
  return {
    id: args.input.id ?? args.existing?.id ?? makeOrganizerItemId(),
    kind: (args.input.kind ?? args.existing?.kind ?? "note") as OrganizerItemKind,
    title: args.input.title ?? args.existing?.title ?? "New note",
    details: args.input.details ?? args.existing?.details ?? "",
    status: (args.input.status ?? args.existing?.status ?? "open") as OrganizerItemStatus,
    tags: args.input.tags ?? args.existing?.tags ?? [],
    createdAt: args.existing?.createdAt ?? at,
    updatedAt: at,
    createdBy: args.existing?.createdBy ?? args.userEmail,
    dueAt: "dueAt" in args.input ? normalizeOptionalDate(args.input.dueAt, "dueAt") : args.existing?.dueAt,
    followUpAt: "followUpAt" in args.input ? normalizeOptionalDate(args.input.followUpAt, "followUpAt") : args.existing?.followUpAt,
    linkedWorkItemIds: args.input.linkedWorkItemIds ?? args.existing?.linkedWorkItemIds ?? [],
  };
}

function getOrganizerStorage(configBucket: string, configPath: string, projectId: string, moduleId: string) {
  const projectDir = dirnamePath(configPath);
  const basePrefix = projectDir ? `${projectDir}/chat-codex/${moduleId}` : `chat-codex/${moduleId}`;
  return {
    bucket: configBucket,
    projectId,
    storeKey: `${basePrefix}/organizer.json`,
  };
}

async function loadOrganizerStore(
  getS3Client: ReturnType<typeof useAwsS3Client>,
  configBucket: string,
  configPath: string,
  projectId: string,
  moduleId: string,
): Promise<{ storage: ReturnType<typeof getOrganizerStorage>; store: OrganizerStore }> {
  const storage = getOrganizerStorage(configBucket, configPath, projectId, moduleId);
  const store = await readOptionalJsonObject<OrganizerStore>(getS3Client, storage.bucket, storage.storeKey);
  return {
    storage,
    store: store ?? { version: 1, projectId: storage.projectId, items: [] },
  };
}

async function saveOrganizerStore(
  getS3Client: ReturnType<typeof useAwsS3Client>,
  storage: ReturnType<typeof getOrganizerStorage>,
  store: OrganizerStore,
): Promise<void> {
  await writeJsonObject(getS3Client, storage.bucket, storage.storeKey, store);
}

function buildOrganizerQueryText(item: OrganizerItem): string {
  return [
    item.id,
    item.kind,
    item.title,
    item.details,
    item.status,
    item.tags.join(" "),
    item.createdBy ?? "",
    item.dueAt ?? "",
    item.followUpAt ?? "",
    item.linkedWorkItemIds.join(" "),
  ].join(" ").toLowerCase();
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

function summarizeOrganizerStore(store: OrganizerStore): string {
  const visible = store.items.filter((item) => item.status !== "archived");
  const open = visible.filter((item) => item.status === "open").length;
  const active = visible.filter((item) => item.status === "active").length;
  const waiting = visible.filter((item) => item.kind === "waiting-on" && item.status !== "done").length;
  const dueSoon = visible
    .filter((item) => item.dueAt && item.status !== "done")
    .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)))
    .slice(0, 3)
    .map((item) => `${item.title} (${item.dueAt?.slice(0, 10)})`);
  const recent = visible
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 4)
    .map((item) => `${item.kind}:${item.title}`);
  return [
    `Organizer memory currently has ${visible.length} visible items (${open} open, ${active} active, ${waiting} waiting-on).`,
    dueSoon.length ? `Upcoming due items: ${dueSoon.join("; ")}.` : "No due items are currently recorded.",
    recent.length ? `Recently updated items: ${recent.join("; ")}.` : "No organizer items have been captured yet.",
  ].join(" ");
}

function formatOrganizerDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

async function readOptionalJsonObject<T>(
  getS3Client: ReturnType<typeof useAwsS3Client>,
  bucket: string,
  key: string,
): Promise<T | null> {
  const s3 = await getS3Client(bucket);
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await object.Body!.transformToString("utf-8")) as T;
  } catch (error: unknown) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === "NoSuchKey" || err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw error;
  }
}

async function writeJsonObject(
  getS3Client: ReturnType<typeof useAwsS3Client>,
  bucket: string,
  key: string,
  value: unknown,
): Promise<void> {
  const s3 = await getS3Client(bucket);
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(value, null, 2),
    ContentType: "application/json",
    CacheControl: "no-store",
  }));
}

async function readTextObject(
  getS3Client: ReturnType<typeof useAwsS3Client>,
  bucket: string,
  key: string,
): Promise<string> {
  const s3 = await getS3Client(bucket);
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return response.Body!.transformToString("utf-8");
}

function getTaskTrackerStorage(slotConfig: ModuleConfig, configBucket: string, configPath: string, projectId: string) {
  const projectDir = dirnamePath(configPath);
  const basePrefix = projectDir ? `${projectDir}/tasks/${slotConfig.id}` : `tasks/${slotConfig.id}`;
  return {
    bucket: configBucket,
    projectId,
    basePrefix,
    tasksKey: `${basePrefix}/tasks.json`,
    attachmentsPrefix: `${basePrefix}/attachments`,
  };
}

function defaultTaskRecord(userEmail?: string, partial?: Partial<TaskRecord>): TaskRecord {
  const at = nowIso();
  return {
    id: partial?.id ?? makeTaskId(),
    title: partial?.title ?? "New task",
    description: partial?.description ?? "",
    notes: partial?.notes ?? "",
    status: partial?.status ?? "open",
    priority: partial?.priority ?? "normal",
    assignee: partial?.assignee,
    tags: partial?.tags ?? [],
    repeatable: partial?.repeatable ?? false,
    createdAt: partial?.createdAt ?? at,
    updatedAt: partial?.updatedAt ?? at,
    createdBy: partial?.createdBy ?? userEmail,
    attachments: partial?.attachments ?? [],
  };
}

async function loadTaskTrackerStore(
  getS3Client: ReturnType<typeof useAwsS3Client>,
  slotConfig: ModuleConfig,
  configBucket: string,
  configPath: string,
  projectId: string,
): Promise<{ storage: ReturnType<typeof getTaskTrackerStorage>; store: TaskStore }> {
  const storage = getTaskTrackerStorage(slotConfig, configBucket, configPath, projectId);
  const store = await readOptionalJsonObject<TaskStore>(getS3Client, storage.bucket, storage.tasksKey);
  return {
    storage,
    store: store ?? { version: 1, projectId: storage.projectId, tasks: [] },
  };
}

async function saveTaskTrackerStore(
  getS3Client: ReturnType<typeof useAwsS3Client>,
  storage: ReturnType<typeof getTaskTrackerStorage>,
  store: TaskStore,
): Promise<void> {
  await writeJsonObject(getS3Client, storage.bucket, storage.tasksKey, store);
}

function getWorkManagerStorage(slotConfig: ModuleConfig, configBucket: string, configPath: string, projectId: string) {
  const projectDir = dirnamePath(configPath);
  const basePrefix = projectDir ? `${projectDir}/work/${slotConfig.id}` : `work/${slotConfig.id}`;
  return {
    bucket: configBucket,
    projectId,
    basePrefix,
    storeKey: `${basePrefix}/store.json`,
    attachmentsPrefix: `${basePrefix}/attachments`,
  };
}

function normalizeWorkDate(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("startAt must be a string.");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid startAt date: ${value}`);
  return date.toISOString();
}

function normalizeWorkItem(args: {
  input: WorkItemInput;
  existing?: WorkItem;
  userEmail?: string;
  titleToId: Map<string, string>;
}): WorkItem {
  const at = nowIso();
  const kind = args.input.kind ?? args.existing?.kind ?? "task";
  const hasDependencyPatch = args.input.dependencies !== undefined || args.input.dependencyTitles !== undefined;
  const rawDependencies = [
    ...(hasDependencyPatch ? (args.input.dependencies ?? []) : (args.existing?.dependencies ?? [])),
    ...(args.input.dependencyTitles ?? []).map((title) => {
      const id = args.titleToId.get(title.trim().toLowerCase());
      if (!id) throw new Error(`Dependency title not found: ${title}`);
      return id;
    }),
  ];
  const id = args.input.id ?? args.existing?.id ?? makeWorkId();
  const dependencies = [...new Set(rawDependencies.filter((depId) => depId && depId !== id))];
  const startAt = "startAt" in args.input
    ? normalizeWorkDate(args.input.startAt)
    : args.existing?.startAt;
  const durationDays = kind === "milestone"
    ? 0
    : Math.max(1, Number(args.input.durationDays ?? args.existing?.durationDays ?? 1));
  return {
    id,
    kind,
    title: args.input.title ?? args.existing?.title ?? "New task",
    description: args.input.description ?? args.existing?.description ?? "",
    notes: args.input.notes ?? args.existing?.notes ?? "",
    status: args.input.status ?? args.existing?.status ?? "open",
    priority: args.input.priority ?? args.existing?.priority ?? (kind === "milestone" ? "high" : "normal"),
    assignee: args.input.assignee ?? args.existing?.assignee,
    tags: args.input.tags ?? args.existing?.tags ?? [],
    repeatable: args.input.repeatable ?? args.existing?.repeatable ?? false,
    createdAt: args.existing?.createdAt ?? args.input.createdAt ?? at,
    updatedAt: at,
    createdBy: args.existing?.createdBy ?? args.input.createdBy ?? args.userEmail,
    attachments: args.input.attachments ?? args.existing?.attachments ?? [],
    startAt,
    durationDays,
    allDay: args.input.allDay ?? args.existing?.allDay ?? true,
    location: args.input.location ?? args.existing?.location,
    progress: Math.max(0, Math.min(100, Number(args.input.progress ?? args.existing?.progress ?? 0))),
    dependencies,
    lane: args.input.lane ?? args.existing?.lane ?? "",
  };
}

function buildWorkTitleMap(existing: WorkItem[], inputs: WorkItemInput[]): Map<string, string> {
  const titleToId = new Map<string, string>();
  for (const item of existing) {
    titleToId.set(item.title.trim().toLowerCase(), item.id);
  }
  for (const input of inputs) {
    if (input.title?.trim()) {
      titleToId.set(input.title.trim().toLowerCase(), input.id!);
    }
  }
  return titleToId;
}

function prepareWorkInputs(inputs: WorkItemInput[]): WorkItemInput[] {
  return inputs.map((input) => ({
    ...input,
    id: input.id ?? makeWorkId(),
  }));
}

async function loadWorkManagerStore(
  getS3Client: ReturnType<typeof useAwsS3Client>,
  slotConfig: ModuleConfig,
  configBucket: string,
  configPath: string,
  projectId: string,
): Promise<{ storage: ReturnType<typeof getWorkManagerStorage>; store: WorkStore }> {
  const storage = getWorkManagerStorage(slotConfig, configBucket, configPath, projectId);
  const store = await readOptionalJsonObject<WorkStore>(getS3Client, storage.bucket, storage.storeKey);
  return {
    storage,
    store: store ?? { version: 1, projectId: storage.projectId, items: [] },
  };
}

async function saveWorkManagerStore(
  getS3Client: ReturnType<typeof useAwsS3Client>,
  storage: ReturnType<typeof getWorkManagerStorage>,
  store: WorkStore,
): Promise<void> {
  await writeJsonObject(getS3Client, storage.bucket, storage.storeKey, store);
}

async function loadDocumentationSlotState(
  getS3Client: ReturnType<typeof useAwsS3Client>,
  slotConfig: ModuleConfig,
): Promise<{ storage: StorageConfig; manifest: DocumentationManifest; contents: ContentMap }> {
  const storage = getStorageConfig(slotConfig);
  const s3 = await getS3Client(storage.bucket);
  const title =
    (slotConfig.meta?.["title"] as string | undefined) ??
    (slotConfig.meta?.["name"] as string | undefined) ??
    "Documentation";
  const state = await loadDocumentationState(s3, storage, title);
  return {
    storage,
    manifest: state.manifest,
    contents: state.contents,
  };
}

async function persistDocumentationSlotState(args: {
  getS3Client: ReturnType<typeof useAwsS3Client>;
  storage: StorageConfig;
  previousManifest: DocumentationManifest;
  nextManifest: DocumentationManifest;
  contents: ContentMap;
}): Promise<void> {
  const s3 = await args.getS3Client(args.storage.bucket);
  const previousKeys = new Set(
    Object.values(args.previousManifest.docs)
      .filter((doc) => (doc.kind ?? "page") === "page" && doc.relativePath)
      .map((doc) => getDocKey(args.storage, doc.relativePath))
  );
  const nextKeys = new Set(
    Object.values(args.nextManifest.docs)
      .filter((doc) => (doc.kind ?? "page") === "page" && doc.relativePath)
      .map((doc) => getDocKey(args.storage, doc.relativePath))
  );

  for (const doc of Object.values(args.nextManifest.docs)) {
    if ((doc.kind ?? "page") !== "page" || !doc.relativePath) continue;
    await writeTextObject(
      s3,
      args.storage.bucket,
      getDocKey(args.storage, doc.relativePath),
      args.contents[doc.id] ?? "",
      "text/markdown",
    );
  }

  for (const staleKey of previousKeys) {
    if (!nextKeys.has(staleKey)) {
      await deleteObjectIfExists(s3, args.storage.bucket, staleKey);
    }
  }

  await writeTextObject(
    s3,
    args.storage.bucket,
    args.storage.manifestKey,
    JSON.stringify(assignPaths(args.nextManifest), null, 2),
    "application/json",
  );
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

async function createMarkdownFileSetAsset(args: {
  getS3Client: ReturnType<typeof useAwsS3Client>;
  getDdbClient: ReturnType<typeof useAwsDdbClient>;
  assetsTable: string;
  projectId: string;
  bucket: string;
  label: string;
  entryPath: string;
  files: MarkdownFileInput[];
  moduleInstanceId: string;
}) {
  const fileSetAssetId = createAssetId();
  const fileSetVersionId = createAssetVersionId();
  const versionRoot = [
    "projects",
    encodeURIComponent(args.projectId).replace(/%20/g, "-"),
    "assets",
    encodeURIComponent(fileSetAssetId).replace(/%20/g, "-"),
    "versions",
    encodeURIComponent(fileSetVersionId).replace(/%20/g, "-"),
  ].join("/");
  const filesPrefix = `${versionRoot}/files`;
  const manifestKey = `${versionRoot}/manifest.json`;
  const s3 = await args.getS3Client(args.bucket);
  const ddb = await args.getDdbClient();
  const childAssetRefs: Array<{ path: string; assetId: string; versionId: string; key: string; mimeType: string; sizeBytes: number }> = [];

  for (const file of args.files) {
    const bytes = new TextEncoder().encode(file.content);
    const key = `${filesPrefix}/${file.path}`;
    const mimeType = file.mimeType ?? guessMimeType(file.path, "text/plain");
    await s3.send(new PutObjectCommand({
      Bucket: args.bucket,
      Key: key,
      Body: bytes,
      ContentType: mimeType,
    }));
    const assetId = createAssetId();
    const versionId = createAssetVersionId();
    await createAsset({
      ddb,
      tableName: args.assetsTable,
      asset: createAssetRecord({
        projectId: args.projectId,
        assetId,
        label: basename(file.path),
        version: {
          versionId,
          bucket: args.bucket,
          key,
          mimeType,
          sizeBytes: bytes.byteLength,
        },
        meta: {
          kind: "file",
          parentAssetId: fileSetAssetId,
          path: file.path,
          moduleInstanceId: args.moduleInstanceId,
          moduleType: "module-markdown-viewer",
        },
      }),
    });
    childAssetRefs.push({ path: file.path, assetId, versionId, key, mimeType, sizeBytes: bytes.byteLength });
  }

  const manifestBytes = new TextEncoder().encode(JSON.stringify({
    kind: "markdown-file-set",
    entryPath: args.entryPath,
    moduleInstanceId: args.moduleInstanceId,
    files: childAssetRefs,
  }, null, 2));

  await s3.send(new PutObjectCommand({
    Bucket: args.bucket,
    Key: manifestKey,
    Body: manifestBytes,
    ContentType: "application/json",
  }));

  await createAsset({
    ddb,
    tableName: args.assetsTable,
    asset: createAssetRecord({
      projectId: args.projectId,
      assetId: fileSetAssetId,
      label: args.label,
      version: {
        versionId: fileSetVersionId,
        bucket: args.bucket,
        key: manifestKey,
        mimeType: "application/json",
        sizeBytes: manifestBytes.byteLength,
      },
      meta: {
        kind: "file-set",
        entryPath: args.entryPath,
        moduleInstanceId: args.moduleInstanceId,
        moduleType: "module-markdown-viewer",
        fileCount: args.files.length,
      },
    }),
  });

  return {
    assetId: fileSetAssetId,
    versionId: fileSetVersionId,
    bucket: args.bucket,
    manifestKey,
    prefix: filesPrefix,
    rootKey: `${filesPrefix}/${args.entryPath}`,
    fileCount: args.files.length,
  };
}

async function readMarkdownSlotState(args: {
  getS3Client: ReturnType<typeof useAwsS3Client>;
  slot: ChildSlot;
  configBucket: string;
  maxCharsPerFile?: number;
}) {
  const meta = (args.slot.meta ?? {}) as Record<string, unknown>;
  const bucket = typeof meta["bucket"] === "string" && meta["bucket"]
    ? meta["bucket"]
    : args.configBucket;
  const rootKey = typeof meta["rootKey"] === "string" ? meta["rootKey"] : "";
  const manifestKey = typeof meta["manifestKey"] === "string" ? meta["manifestKey"] : "";
  const assetId = typeof meta["assetId"] === "string" ? meta["assetId"] : undefined;
  const versionId = typeof meta["versionId"] === "string" ? meta["versionId"] : undefined;
  const maxCharsPerFile = Math.max(200, Math.min(args.maxCharsPerFile ?? 12000, 50000));

  if (!rootKey) {
    throw new Error(`Markdown slot ${args.slot.slotId} does not have a rootKey configured.`);
  }

  const files: Array<{
    path: string;
    key: string;
    mimeType?: string;
    assetId?: string;
    versionId?: string;
    content: string;
    contentPreview: string;
  }> = [];

  let entryPath = basename(rootKey);
  let prefix = dirnamePath(rootKey);

  if (manifestKey) {
    const manifest = JSON.parse(await readTextObject(args.getS3Client, bucket, manifestKey)) as {
      entryPath?: string;
      files?: Array<{ path?: string; key?: string; mimeType?: string; assetId?: string; versionId?: string }>;
    };
    entryPath = manifest.entryPath || entryPath;
    if (Array.isArray(manifest.files)) {
      for (const file of manifest.files) {
        if (!file?.path || !file?.key) continue;
        const content = await readTextObject(args.getS3Client, bucket, file.key);
        files.push({
          path: file.path,
          key: file.key,
          mimeType: file.mimeType,
          assetId: file.assetId,
          versionId: file.versionId,
          content: content.slice(0, maxCharsPerFile),
          contentPreview: content.slice(0, 600),
        });
      }
    }
  } else {
    const content = await readTextObject(args.getS3Client, bucket, rootKey);
    files.push({
      path: basename(rootKey),
      key: rootKey,
      mimeType: guessMimeType(rootKey, "text/plain"),
      content: content.slice(0, maxCharsPerFile),
      contentPreview: content.slice(0, 600),
    });
  }

  return {
    bucket,
    prefix,
    rootKey,
    manifestKey: manifestKey || undefined,
    assetId,
    versionId,
    entryPath,
    files,
  };
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

function summarizeInputItem(item: InputMessageItem | ResponsesApiOutputItem | FunctionCallOutputItem): string {
  if ((item as FunctionCallOutputItem).type === "function_call_output") {
    const outputItem = item as FunctionCallOutputItem;
    const snippet = outputItem.output.replace(/\s+/g, " ").slice(0, 220);
    return `tool-output ${outputItem.call_id}: ${snippet}`;
  }

  if ((item as ResponsesApiFunctionCall).type === "function_call") {
    const call = item as ResponsesApiFunctionCall;
    const args = call.arguments.replace(/\s+/g, " ").slice(0, 180);
    return `tool-call ${call.name}: ${args}`;
  }

  if ((item as InputMessageItem).type === "message") {
    const message = item as InputMessageItem;
    const text = message.content.map((part) => part.text).join(" ").replace(/\s+/g, " ").slice(0, 240);
    return `${message.role}: ${text}`;
  }

  const raw = JSON.stringify(item);
  return raw.length > 240 ? `${raw.slice(0, 240)}...` : raw;
}

function compactInputItems(inputItems: Array<InputMessageItem | ResponsesApiOutputItem | FunctionCallOutputItem>) {
  const serializedLength = inputItems.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
  if (inputItems.length <= BROWSER_CONTEXT_ITEM_LIMIT && serializedLength <= BROWSER_CONTEXT_CHAR_BUDGET) {
    return { inputItems, truncatedSummary: "" };
  }

  const trailingItems = inputItems.slice(-BROWSER_CONTEXT_ITEM_LIMIT);
  const keepIndexes = new Set<number>();
  const trailingStart = Math.max(0, inputItems.length - trailingItems.length);
  for (let index = trailingStart; index < inputItems.length; index++) {
    keepIndexes.add(index);
  }

  for (let index = trailingStart; index < inputItems.length; index++) {
    const item = inputItems[index];
    if ((item as FunctionCallOutputItem).type !== "function_call_output") continue;
    for (let cursor = index - 1; cursor >= 0; cursor--) {
      const candidate = inputItems[cursor];
      const candidateType = (candidate as { type?: string }).type;
      if (candidateType === "message" || candidateType === "function_call_output") {
        break;
      }
      keepIndexes.add(cursor);
    }
  }

  const recentItems = inputItems.filter((_, index) => keepIndexes.has(index));
  const droppedItems = inputItems.filter((item) => !recentItems.includes(item));
  const summaryLines: string[] = [];
  let used = 0;
  for (const item of droppedItems) {
    const line = `- ${summarizeInputItem(item)}`;
    if (used + line.length > BROWSER_CONTEXT_SUMMARY_LIMIT) break;
    summaryLines.push(line);
    used += line.length + 1;
  }

  return {
    inputItems: recentItems,
    truncatedSummary: summaryLines.length
      ? `Older browser context was compacted. Summary of earlier turns and tool activity:\n${summaryLines.join("\n")}`
      : "Older browser context was compacted.",
  };
}

async function createOpenAiResponse(args: {
  apiKey: string;
  input: Array<InputMessageItem | ResponsesApiOutputItem | FunctionCallOutputItem>;
  model: string;
  instructions: string;
  tools: ToolDefinition[];
  signal?: AbortSignal;
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
    signal: args.signal,
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isFunctionCallOutputMismatchError(error: unknown): boolean {
  return error instanceof Error && /No tool call found for function call output with call_id/i.test(error.message);
}

function isReasoningItemMismatchError(error: unknown): boolean {
  return error instanceof Error && /was provided without its required 'reasoning' item/i.test(error.message);
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

async function getBridgeStatus(bridge: BridgeConfig): Promise<BridgeStatus> {
  return callBridge<BridgeStatus>(bridge, "get_bridge_status");
}

async function getBridgeHealth(url: string): Promise<BridgeHealth> {
  const response = await fetch(`${url.replace(/\/$/, "")}/health`);
  const payload = (await response.json()) as { ok?: boolean; result?: BridgeHealth; error?: string };
  if (!response.ok || !payload.ok || !payload.result) {
    throw new Error(payload.error || `Runtime health check failed: ${response.status}`);
  }
  return payload.result;
}

function getInstallBaseUrl(defaults: AgentBridgeDefaults): string {
  return defaults.installBaseUrl?.trim().replace(/\/$/, "") || "/downloads/agent-runtime";
}

function installHref(baseUrl: string, platform: "windows" | "macos" | "linux"): string {
  const filename =
    platform === "windows" ? "jeffspace-agent-runtime-windows-x64.msi" :
    platform === "macos" ? "jeffspace-agent-runtime-macos-universal.pkg" :
    "jeffspace-agent-runtime-linux-x64.AppImage";
  return `${baseUrl}/${filename}`;
}

async function loadWorkspaceContext(getS3Client: ReturnType<typeof useAwsS3Client>, configBucket: string, configPath: string, projectId: string): Promise<WorkspaceContext> {
  const s3 = await getS3Client(configBucket);
  const object = await s3.send(new GetObjectCommand({ Bucket: configBucket, Key: configPath }));
  const text = await object.Body!.transformToString("utf-8");
  const rootConfig = JSON.parse(text) as ModuleConfig;
  const resources = collectResources(rootConfig);
  return { projectId, configBucket, configPath, rootConfig, resources };
}

async function buildAppspaceContextSnapshot(args: {
  config: ModuleConfig;
  projectId: string;
  configBucket: string;
  configPath: string;
  getS3Client: ReturnType<typeof useAwsS3Client>;
  getDdbClient: ReturnType<typeof useAwsDdbClient>;
  assetsTable?: string;
  loadedResources: ReadonlyMap<string, Resource>;
  registryEntries: ModuleRegistryEntry[];
  bridgeWorkspaceRoot?: string;
}) {
  const context = await loadWorkspaceContext(args.getS3Client, args.configBucket, args.configPath, args.projectId);
  const slots = buildSlotTree(context.rootConfig.children);
  const { storage: organizerStorage, store: organizerStore } = await loadOrganizerStore(
    args.getS3Client,
    args.configBucket,
    args.configPath,
    args.projectId,
    args.config.id,
  );
  let assets: Array<Record<string, unknown>> = [];

  if (args.assetsTable) {
    const ddb = await args.getDdbClient();
    const records = await listAssets({ ddb, tableName: args.assetsTable, projectId: args.projectId });
    assets = records.map((asset) => {
      const version = getCurrentAssetVersion(asset);
      return {
        assetId: asset.assetId,
        label: asset.label,
        bucket: version.bucket,
        key: version.key,
        versionId: version.versionId,
        mimeType: version.mimeType,
        sizeBytes: version.sizeBytes,
        meta: asset.meta ?? {},
      };
    });
  }

  return {
    schemaVersion: 1,
    project: {
      projectId: args.projectId,
      configBucket: args.configBucket,
      configPath: args.configPath,
      rootModuleId: context.rootConfig.id,
      rootBundleKey: context.rootConfig.app.key,
      title: typeof context.rootConfig.meta?.["title"] === "string" ? context.rootConfig.meta["title"] : undefined,
    },
    activeModule: {
      moduleId: args.config.id,
      bundleKey: args.config.app.key,
      label: typeof args.config.meta?.["title"] === "string" ? args.config.meta["title"] : undefined,
      meta: args.config.meta ?? {},
    },
    slots,
    assets,
    resources: [...args.loadedResources.values()].map((resource) => ({
      id: resource.id,
      label: resource.label,
      type: resource.type,
      bucket: resource.bucket,
      key: resource.key,
      table: resource.table,
      mimeType: resource.mimeType,
      meta: resource.meta ?? {},
    })),
    availableModules: args.registryEntries.map((entry) => ({
      moduleName: entry.moduleName,
      displayName: entry.displayName,
      description: entry.description,
      category: entry.category,
      pickerGroup: entry.pickerGroup,
      bundleBucket: entry.bundleBucket,
      bundlePath: entry.bundlePath,
      latestVersion: entry.latestVersion,
    })),
    bridge: {
      workspaceRoot: args.bridgeWorkspaceRoot || undefined,
    },
    organizer: {
      bucket: organizerStorage.bucket,
      storeKey: organizerStorage.storeKey,
      summary: summarizeOrganizerStore(organizerStore),
      visibleCount: organizerStore.items.filter((item) => item.status !== "archived").length,
      items: organizerStore.items,
    },
    capabilities: {
      browserAgentCanExecuteAppspaceOperations: true,
      bridgeCanQueueAppspaceOperations: true,
      bridgeCanReadSyncedAppspaceContext: true,
    },
    appspaceOperations: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    updatedAt: new Date().toISOString(),
  };
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

function requireSlotByPath(rootConfig: ModuleConfig, slotPath: string[]): ChildSlot {
  const slot = findSlotInChildren(rootConfig.children, slotPath);
  if (!slot) {
    throw new Error(`No slot found at path ${slotPath.join(" / ")}`);
  }
  return slot;
}

function requireModuleAtPath(rootConfig: ModuleConfig, slotPath: string[], moduleKeyFragment: string): ChildSlot {
  const slot = requireSlotByPath(rootConfig, slotPath);
  if (!slot.app.key.includes(moduleKeyFragment)) {
    throw new Error(`Slot ${slotPath.join(" / ")} is not a ${moduleKeyFragment} module.`);
  }
  return slot;
}

async function executeTool(args: {
  toolCall: ResponsesApiFunctionCall;
  config: ModuleConfig;
  projectId: string;
  configBucket: string;
  configPath: string;
  userEmail?: string;
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
    userEmail,
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

    case "get_appspace_context": {
      const snapshot = await buildAppspaceContextSnapshot({
        config,
        projectId,
        configBucket,
        configPath,
        getS3Client,
        getDdbClient,
        assetsTable,
        loadedResources,
        registryEntries,
      });
      return {
        output: JSON.stringify(snapshot, null, 2),
        toolMessage: "Loaded the browser appspace context snapshot.",
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

    case "export_project_asset_to_workspace": {
      if (!bridge) throw new Error("Local agent bridge is not configured.");
      if (!assetsTable) throw new Error("Project asset table is not configured.");
      const parsed = parseToolArgs<{ assetId?: string; path?: string; workspacePath: string }>(toolCall.arguments);
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

      const version = getCurrentAssetVersion(selected);
      const s3 = await getS3Client(version.bucket);
      const object = await s3.send(new GetObjectCommand({
        Bucket: version.bucket,
        Key: version.key,
      }));
      const bytes = await object.Body!.transformToByteArray();
      const content = arrayBufferToBase64(bytes);
      const result = await callBridge<unknown>(bridge, "write_workspace_file", {
        path: parsed.workspacePath,
        content,
        encoding: "base64",
        mode: "overwrite",
      });

      return {
        output: JSON.stringify({
          status: "ok",
          assetId: selected.assetId,
          label: selected.label,
          source: { bucket: version.bucket, key: version.key, mimeType: version.mimeType },
          workspacePath: parsed.workspacePath,
          bridgeResult: result,
        }, null, 2),
        toolMessage: `Exported project asset ${selected.label} to ${parsed.workspacePath}.`,
      };
    }

    case "create_markdown_file_set": {
      const parsed = parseToolArgs<{
        label: string;
        entryPath: string;
        files: MarkdownFileInput[];
      }>(toolCall.arguments);
      if (!assetsTable) throw new Error("Project asset table is not configured.");
      const created = await createMarkdownFileSetAsset({
        getS3Client,
        getDdbClient,
        assetsTable,
        projectId,
        bucket: configBucket,
        label: parsed.label,
        entryPath: parsed.entryPath,
        files: parsed.files,
        moduleInstanceId: config.id,
      });

      return {
        output: JSON.stringify({ status: "ok", ...created }, null, 2),
        toolMessage: `Created markdown file set ${parsed.label}.`,
      };
    }

    case "create_markdown_slot_from_content": {
      const parsed = parseToolArgs<{
        parentSlotPath?: string[];
        slotId: string;
        title: string;
        entryPath: string;
        files: MarkdownFileInput[];
      }>(toolCall.arguments);
      if (!assetsTable) throw new Error("Project asset table is not configured.");
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const entry = findModuleEntry(registryEntries, "modules/markdown-viewer");
      if (!entry) throw new Error("Published module not found: modules/markdown-viewer");
      const created = await createMarkdownFileSetAsset({
        getS3Client,
        getDdbClient,
        assetsTable,
        projectId,
        bucket: configBucket,
        label: parsed.title,
        entryPath: parsed.entryPath,
        files: parsed.files,
        moduleInstanceId: parsed.slotId,
      });
      const parentPath = parsed.parentSlotPath ?? [];
      const nextSlot: ChildSlot = {
        slotId: parsed.slotId,
        app: { bucket: entry.bundleBucket, key: entry.bundlePath },
        meta: {
          tabName: parsed.title,
          title: parsed.title,
          prefix: created.prefix,
          rootKey: created.rootKey,
          bucket: created.bucket,
          assetId: created.assetId,
          versionId: created.versionId,
          manifestKey: created.manifestKey,
        },
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
          slotPath: [...parentPath, parsed.slotId],
          moduleKey: nextSlot.app.key,
          assetId: created.assetId,
          versionId: created.versionId,
          rootKey: created.rootKey,
        }, null, 2),
        toolMessage: `Created markdown slot ${[...parentPath, parsed.slotId].join(" / ")} with new content.`,
        mutatedWorkspace: true,
      };
    }

    case "create_document_viewer_slot": {
      const parsed = parseToolArgs<{
        parentSlotPath?: string[];
        slotId: string;
        title: string;
        assetId?: string;
        workspacePath?: string;
        filename?: string;
        label?: string;
      }>(toolCall.arguments);
      if (!assetsTable) throw new Error("Project asset table is not configured.");
      if (!parsed.assetId && !parsed.workspacePath) {
        throw new Error("Provide either assetId or workspacePath.");
      }
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const entry = findModuleEntry(registryEntries, "modules/document-viewer");
      if (!entry) throw new Error("Published module not found: modules/document-viewer");

      let docMeta: { key: string; filename: string; bucket?: string; assetId?: string; versionId?: string };
      if (parsed.assetId) {
        const ddb = await getDdbClient();
        const assets = await listAssets({ ddb, tableName: assetsTable, projectId });
        const asset = assets.find((item) => item.assetId === parsed.assetId);
        if (!asset) throw new Error(`Project asset not found: ${parsed.assetId}`);
        const version = getCurrentAssetVersion(asset);
        docMeta = {
          key: version.key,
          filename: asset.label || basename(version.key),
          bucket: version.bucket,
          assetId: asset.assetId,
          versionId: version.versionId,
        };
      } else {
        if (!bridge) throw new Error("Local agent bridge is not configured.");
        const workspaceFile = await callBridge<{ content: string }>(bridge, "read_workspace_file", {
          path: parsed.workspacePath,
          encoding: "base64",
        });
        const bytes = Uint8Array.from(atob(workspaceFile.content), (ch) => ch.charCodeAt(0));
        const filename = parsed.filename ?? basename(parsed.workspacePath!);
        const created = await createProjectAssetFromBytes({
          getS3Client,
          getDdbClient,
          assetsTable,
          projectId,
          bucket: configBucket,
          label: parsed.label ?? filename,
          filename,
          bytes,
          mimeType: guessMimeType(filename, "application/pdf"),
          meta: {
            kind: "file",
            path: filename,
            sourceWorkspacePath: parsed.workspacePath,
            moduleInstanceId: parsed.slotId,
            moduleType: "module-document-viewer",
          },
        });
        docMeta = {
          key: created.key,
          filename,
          bucket: created.bucket,
          assetId: created.assetId,
          versionId: created.versionId,
        };
      }

      const parentPath = parsed.parentSlotPath ?? [];
      const nextSlot: ChildSlot = {
        slotId: parsed.slotId,
        app: { bucket: entry.bundleBucket, key: entry.bundlePath },
        meta: {
          title: parsed.title,
          doc: docMeta,
        },
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
          slotPath: [...parentPath, parsed.slotId],
          doc: docMeta,
        }, null, 2),
        toolMessage: `Created document viewer slot ${[...parentPath, parsed.slotId].join(" / ")}.`,
        mutatedWorkspace: true,
      };
    }

    case "create_task_tracker_slot": {
      const parsed = parseToolArgs<{
        parentSlotPath?: string[];
        slotId: string;
        title: string;
        tasks?: Array<Partial<TaskRecord> & { title: string }>;
      }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const entry = findModuleEntry(registryEntries, "modules/task-tracker");
      if (!entry) throw new Error("Published module not found: modules/task-tracker");
      const parentPath = parsed.parentSlotPath ?? [];
      const nextSlot: ChildSlot = {
        slotId: parsed.slotId,
        app: { bucket: entry.bundleBucket, key: entry.bundlePath },
        meta: { title: parsed.title },
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
      const slotConfig: ModuleConfig = { id: parsed.slotId, app: nextSlot.app, meta: nextSlot.meta };
      const { storage, store } = await loadTaskTrackerStore(getS3Client, slotConfig, configBucket, configPath, projectId);
      const created = (parsed.tasks ?? []).map((task) => defaultTaskRecord(userEmail, {
        title: task.title,
        description: task.description ?? "",
        notes: task.notes ?? "",
        status: task.status ?? "open",
        priority: task.priority ?? "normal",
        assignee: task.assignee,
        tags: task.tags ?? [],
        repeatable: task.repeatable ?? false,
      }));
      if (created.length) {
        await saveTaskTrackerStore(getS3Client, storage, { ...store, tasks: [...created, ...store.tasks] });
      }
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: [...parentPath, parsed.slotId],
          createdTaskIds: created.map((task) => task.id),
        }, null, 2),
        toolMessage: `Created task tracker slot ${[...parentPath, parsed.slotId].join(" / ")}${created.length ? ` with ${created.length} initial task${created.length === 1 ? "" : "s"}` : ""}.`,
        mutatedWorkspace: true,
      };
    }

    case "create_documentation_slot": {
      const parsed = parseToolArgs<{
        parentSlotPath?: string[];
        slotId: string;
        title: string;
        pages?: Array<{ title: string; content?: string; action?: LinkAction; afterDocTitle?: string }>;
      }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const entry = findModuleEntry(registryEntries, "modules/documentation-viewer");
      if (!entry) throw new Error("Published module not found: modules/documentation-viewer");
      const parentPath = parsed.parentSlotPath ?? [];
      const nextSlot: ChildSlot = {
        slotId: parsed.slotId,
        app: { bucket: entry.bundleBucket, key: entry.bundlePath },
        meta: { title: parsed.title },
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
      const slotConfig: ModuleConfig = { id: parsed.slotId, app: { bucket: configBucket, key: entry.bundlePath }, meta: { title: parsed.title } };
      const { storage, manifest, contents } = await loadDocumentationSlotState(getS3Client, slotConfig);
      let workingManifest = manifest;
      let workingContents = {
        ...contents,
        [manifest.rootDocId]: contents[manifest.rootDocId] ?? `# ${parsed.title}\n\n`,
      };
      const createdDocIds: string[] = [];
      const titleMap = new Map<string, string>([[workingManifest.docs[workingManifest.rootDocId].title, workingManifest.rootDocId]]);
      for (const page of parsed.pages ?? []) {
        const currentDocId = page.afterDocTitle ? titleMap.get(page.afterDocTitle) ?? workingManifest.rootDocId : workingManifest.rootDocId;
        const created = createLinkedPage(workingManifest, workingContents, currentDocId, page.title, page.action ?? "child");
        workingManifest = created.manifest;
        workingContents = {
          ...created.contents,
          [created.newDocId]: page.content ?? created.contents[created.newDocId] ?? `# ${page.title}\n\n`,
        };
        createdDocIds.push(created.newDocId);
        titleMap.set(page.title, created.newDocId);
      }
      await persistDocumentationSlotState({
        getS3Client,
        storage,
        previousManifest: manifest,
        nextManifest: workingManifest,
        contents: workingContents,
      });
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: [...parentPath, parsed.slotId],
          rootDocId: workingManifest.rootDocId,
          createdDocIds,
          manifestKey: storage.manifestKey,
          pagesPrefix: storage.pagesPrefix,
        }, null, 2),
        toolMessage: `Created documentation slot ${[...parentPath, parsed.slotId].join(" / ")}${createdDocIds.length ? ` with ${createdDocIds.length} starter page${createdDocIds.length === 1 ? "" : "s"}` : ""}.`,
        mutatedWorkspace: true,
      };
    }

    case "create_work_manager_slot": {
      const parsed = parseToolArgs<{
        parentSlotPath?: string[];
        slotId: string;
        title: string;
        items?: WorkItemInput[];
      }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const entry = findModuleEntry(registryEntries, "modules/work-manager") ?? findModuleEntry(registryEntries, "module-work-manager");
      if (!entry) throw new Error("Published module not found: module-work-manager");
      const parentPath = parsed.parentSlotPath ?? [];
      const nextSlot: ChildSlot = {
        slotId: parsed.slotId,
        app: { bucket: entry.bundleBucket, key: entry.bundlePath },
        meta: {
          title: parsed.title,
          tabName: parsed.title,
        },
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

      const slotConfig: ModuleConfig = { id: parsed.slotId, app: nextSlot.app, meta: nextSlot.meta };
      const { storage } = await loadWorkManagerStore(getS3Client, slotConfig, configBucket, configPath, projectId);
      const prepared = prepareWorkInputs(parsed.items ?? []);
      const titleToId = buildWorkTitleMap([], prepared);
      const items = prepared.map((input) => normalizeWorkItem({ input, userEmail, titleToId }));
      await saveWorkManagerStore(getS3Client, storage, { version: 1, projectId, items });
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: [...parentPath, parsed.slotId],
          moduleKey: nextSlot.app.key,
          workStoreKey: storage.storeKey,
          createdItemIds: items.map((item) => item.id),
        }, null, 2),
        toolMessage: `Created work-manager slot ${[...parentPath, parsed.slotId].join(" / ")} with ${items.length} item${items.length === 1 ? "" : "s"}.`,
        mutatedWorkspace: true,
      };
    }

    case "list_organizer_items": {
      const parsed = parseToolArgs<{
        query?: string;
        kind?: OrganizerItemKind;
        status?: OrganizerItemStatus;
        timingState?: OrganizerTimingState;
        includeArchived?: boolean;
        limit?: number;
      }>(toolCall.arguments);
      const { store } = await loadOrganizerStore(getS3Client, configBucket, configPath, projectId, config.id);
      const limit = Math.max(1, Math.min(200, parsed.limit ?? 50));
      const items = store.items
        .filter((item) => (parsed.includeArchived ? true : item.status !== "archived"))
        .filter((item) => (parsed.kind ? item.kind === parsed.kind : true))
        .filter((item) => (parsed.status ? item.status === parsed.status : true))
        .filter((item) => matchesOrganizerTimingState(item, parsed.timingState))
        .filter((item) => matchesQuery(buildOrganizerQueryText(item), parsed.query ?? ""))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit);
      return {
        output: JSON.stringify({
          count: items.length,
          totalVisible: store.items.filter((item) => item.status !== "archived").length,
          items,
        }, null, 2),
        toolMessage: `Listed ${items.length} organizer item${items.length === 1 ? "" : "s"}.`,
      };
    }

    case "batch_update_organizer_items": {
      const parsed = parseToolArgs<{ itemIds: string[]; patch: Partial<OrganizerItem> }>(toolCall.arguments);
      if (!parsed.itemIds?.length) {
        throw new Error("At least one organizer item id is required.");
      }
      const itemIds = new Set(parsed.itemIds.map((id) => id.trim()).filter(Boolean));
      if (!itemIds.size) {
        throw new Error("At least one valid organizer item id is required.");
      }
      const { storage, store } = await loadOrganizerStore(getS3Client, configBucket, configPath, projectId, config.id);
      const missing = [...itemIds].filter((id) => !store.items.some((item) => item.id === id));
      if (missing.length) {
        throw new Error(`Organizer items not found: ${missing.join(", ")}`);
      }
      const updatedItems: OrganizerItem[] = [];
      const nextStore: OrganizerStore = {
        ...store,
        items: store.items.map((item) => {
          if (!itemIds.has(item.id)) return item;
          const updated = normalizeOrganizerItem({ input: parsed.patch, existing: item, userEmail });
          updatedItems.push(updated);
          return updated;
        }),
      };
      await saveOrganizerStore(getS3Client, storage, nextStore);
      return {
        output: JSON.stringify({ ok: true, updatedCount: updatedItems.length, items: updatedItems }, null, 2),
        toolMessage: `Updated ${updatedItems.length} organizer item${updatedItems.length === 1 ? "" : "s"}.`,
      };
    }

    case "mark_organizer_items_complete": {
      const parsed = parseToolArgs<{ itemIds: string[] }>(toolCall.arguments);
      if (!parsed.itemIds?.length) {
        throw new Error("At least one organizer item id is required.");
      }
      const itemIds = new Set(parsed.itemIds.map((id) => id.trim()).filter(Boolean));
      if (!itemIds.size) {
        throw new Error("At least one valid organizer item id is required.");
      }
      const { storage, store } = await loadOrganizerStore(getS3Client, configBucket, configPath, projectId, config.id);
      const missing = [...itemIds].filter((id) => !store.items.some((item) => item.id === id));
      if (missing.length) {
        throw new Error(`Organizer items not found: ${missing.join(", ")}`);
      }
      const completedItems: OrganizerItem[] = [];
      const nextStore: OrganizerStore = {
        ...store,
        items: store.items.map((item) => {
          if (!itemIds.has(item.id)) return item;
          const updated = normalizeOrganizerItem({
            input: { status: "done" },
            existing: item,
            userEmail,
          });
          completedItems.push(updated);
          return updated;
        }),
      };
      await saveOrganizerStore(getS3Client, storage, nextStore);
      return {
        output: JSON.stringify({ ok: true, updatedCount: completedItems.length, items: completedItems }, null, 2),
        toolMessage: `Marked ${completedItems.length} organizer item${completedItems.length === 1 ? "" : "s"} complete.`,
      };
    }

    case "create_organizer_items": {
      const parsed = parseToolArgs<{ items: OrganizerItemInput[] }>(toolCall.arguments);
      if (!parsed.items?.length) {
        throw new Error("At least one organizer item is required.");
      }
      const { storage, store } = await loadOrganizerStore(getS3Client, configBucket, configPath, projectId, config.id);
      const created = parsed.items.map((input) => normalizeOrganizerItem({ input, userEmail }));
      const nextStore: OrganizerStore = {
        ...store,
        items: [...created, ...store.items],
      };
      await saveOrganizerStore(getS3Client, storage, nextStore);
      return {
        output: JSON.stringify({ ok: true, created }, null, 2),
        toolMessage: `Created ${created.length} organizer item${created.length === 1 ? "" : "s"}.`,
      };
    }

    case "update_organizer_item": {
      const parsed = parseToolArgs<{ itemId: string; patch: Partial<OrganizerItem> }>(toolCall.arguments);
      const { storage, store } = await loadOrganizerStore(getS3Client, configBucket, configPath, projectId, config.id);
      const existing = store.items.find((item) => item.id === parsed.itemId);
      if (!existing) {
        throw new Error(`Organizer item not found: ${parsed.itemId}`);
      }
      const updated = normalizeOrganizerItem({ input: parsed.patch, existing, userEmail });
      const nextStore: OrganizerStore = {
        ...store,
        items: store.items.map((item) => item.id === parsed.itemId ? updated : item),
      };
      await saveOrganizerStore(getS3Client, storage, nextStore);
      return {
        output: JSON.stringify({ ok: true, item: updated }, null, 2),
        toolMessage: `Updated organizer item ${updated.title}.`,
      };
    }

    case "delete_organizer_item": {
      const parsed = parseToolArgs<{ itemId: string }>(toolCall.arguments);
      const { storage, store } = await loadOrganizerStore(getS3Client, configBucket, configPath, projectId, config.id);
      const existing = store.items.find((item) => item.id === parsed.itemId);
      if (!existing) {
        throw new Error(`Organizer item not found: ${parsed.itemId}`);
      }
      const nextStore: OrganizerStore = {
        ...store,
        items: store.items.filter((item) => item.id !== parsed.itemId),
      };
      await saveOrganizerStore(getS3Client, storage, nextStore);
      return {
        output: JSON.stringify({ ok: true, deletedId: parsed.itemId }, null, 2),
        toolMessage: `Deleted organizer item ${existing.title}.`,
      };
    }

    case "list_work_manager_items": {
      const parsed = parseToolArgs<{ slotPath: string[]; query?: string }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-work-manager");
      const { storage, store } = await loadWorkManagerStore(getS3Client, {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      }, configBucket, configPath, projectId);
      const itemsById = new Map(store.items.map((item) => [item.id, item]));
      const items = store.items
        .map((item) => ({
          ...item,
          dependencyTitles: item.dependencies.map((depId) => itemsById.get(depId)?.title ?? depId),
        }))
        .filter((item) => matchesQuery(JSON.stringify(item), parsed.query ?? ""));
      return {
        output: JSON.stringify({
          slotPath: parsed.slotPath,
          bucket: storage.bucket,
          storeKey: storage.storeKey,
          count: items.length,
          totalCount: store.items.length,
          items,
        }, null, 2),
        toolMessage: `Listed ${items.length} work-manager item${items.length === 1 ? "" : "s"}.`,
      };
    }

    case "create_work_manager_items": {
      const parsed = parseToolArgs<{ slotPath: string[]; items: WorkItemInput[] }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-work-manager");
      const { storage, store } = await loadWorkManagerStore(getS3Client, {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      }, configBucket, configPath, projectId);
      const prepared = prepareWorkInputs(parsed.items);
      const titleToId = buildWorkTitleMap(store.items, prepared);
      const created = prepared.map((input) => normalizeWorkItem({ input, userEmail, titleToId }));
      const nextStore: WorkStore = { ...store, items: [...created, ...store.items] };
      await saveWorkManagerStore(getS3Client, storage, nextStore);
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          createdItemIds: created.map((item) => item.id),
          itemCount: nextStore.items.length,
        }, null, 2),
        toolMessage: `Created ${created.length} work item${created.length === 1 ? "" : "s"} in ${parsed.slotPath.join(" / ")}.`,
      };
    }

    case "update_work_manager_item": {
      const parsed = parseToolArgs<{ slotPath: string[]; itemId: string; patch: Partial<WorkItemInput> }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-work-manager");
      const { storage, store } = await loadWorkManagerStore(getS3Client, {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      }, configBucket, configPath, projectId);
      const existing = store.items.find((item) => item.id === parsed.itemId);
      if (!existing) throw new Error(`Work item not found: ${parsed.itemId}`);
      const input = { ...parsed.patch, id: existing.id, title: parsed.patch.title ?? existing.title } as WorkItemInput;
      const titleToId = buildWorkTitleMap(store.items, [input]);
      const updated = normalizeWorkItem({ input, existing, userEmail, titleToId });
      const nextStore: WorkStore = {
        ...store,
        items: store.items.map((item) => item.id === parsed.itemId ? updated : item),
      };
      await saveWorkManagerStore(getS3Client, storage, nextStore);
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          item: updated,
        }, null, 2),
        toolMessage: `Updated work item ${parsed.itemId}.`,
      };
    }

    case "delete_work_manager_item": {
      const parsed = parseToolArgs<{ slotPath: string[]; itemId: string; deleteAttachments?: boolean }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-work-manager");
      const { storage, store } = await loadWorkManagerStore(getS3Client, {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      }, configBucket, configPath, projectId);
      const existing = store.items.find((item) => item.id === parsed.itemId);
      if (!existing) throw new Error(`Work item not found: ${parsed.itemId}`);
      if (parsed.deleteAttachments) {
        const s3 = await getS3Client(storage.bucket);
        await Promise.all(existing.attachments.map((attachment) =>
          s3.send(new DeleteObjectCommand({ Bucket: attachment.bucket, Key: attachment.key })).catch(() => undefined)
        ));
      }
      const nextStore: WorkStore = {
        ...store,
        items: store.items
          .filter((item) => item.id !== parsed.itemId)
          .map((item) => ({ ...item, dependencies: item.dependencies.filter((depId) => depId !== parsed.itemId) })),
      };
      await saveWorkManagerStore(getS3Client, storage, nextStore);
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          itemId: parsed.itemId,
          itemCount: nextStore.items.length,
        }, null, 2),
        toolMessage: `Deleted work item ${parsed.itemId}.`,
      };
    }

    case "attach_project_asset_to_work_item": {
      const parsed = parseToolArgs<{ slotPath: string[]; itemId: string; assetId: string }>(toolCall.arguments);
      if (!assetsTable) throw new Error("Project asset table is not configured.");
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-work-manager");
      const { storage, store } = await loadWorkManagerStore(getS3Client, {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      }, configBucket, configPath, projectId);
      const existing = store.items.find((item) => item.id === parsed.itemId);
      if (!existing) throw new Error(`Work item not found: ${parsed.itemId}`);
      const ddb = await getDdbClient();
      const assets = await listAssets({ ddb, tableName: assetsTable, projectId });
      const asset = assets.find((item) => item.assetId === parsed.assetId);
      if (!asset) throw new Error(`Project asset not found: ${parsed.assetId}`);
      const version = getCurrentAssetVersion(asset);
      const attachment: WorkAttachment = {
        id: makeAttachmentId(),
        name: asset.label || basename(version.key),
        bucket: version.bucket,
        key: version.key,
        size: version.sizeBytes ?? 0,
        contentType: version.mimeType,
        uploadedAt: nowIso(),
        uploadedBy: userEmail,
      };
      const nextStore: WorkStore = {
        ...store,
        items: store.items.map((item) => (
          item.id === parsed.itemId
            ? { ...item, attachments: [...item.attachments, attachment], updatedAt: nowIso() }
            : item
        )),
      };
      await saveWorkManagerStore(getS3Client, storage, nextStore);
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          itemId: parsed.itemId,
          attachment,
        }, null, 2),
        toolMessage: `Attached asset ${parsed.assetId} to work item ${parsed.itemId}.`,
      };
    }

    case "replace_work_manager_items": {
      const parsed = parseToolArgs<{ slotPath: string[]; replaceExisting?: boolean; items: WorkItemInput[] }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-work-manager");
      const { storage, store } = await loadWorkManagerStore(getS3Client, {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      }, configBucket, configPath, projectId);
      const baseItems = parsed.replaceExisting ? [] : store.items;
      const prepared = parsed.items.map((input) => {
        const existing = input.id
          ? baseItems.find((item) => item.id === input.id)
          : baseItems.find((item) => item.title.trim().toLowerCase() === input.title.trim().toLowerCase());
        return { ...input, id: input.id ?? existing?.id ?? makeWorkId() };
      });
      const titleToId = buildWorkTitleMap(baseItems, prepared);
      const updatedById = new Map<string, WorkItem>();
      for (const input of prepared) {
        const existing = baseItems.find((item) => item.id === input.id);
        updatedById.set(input.id!, normalizeWorkItem({ input, existing, userEmail, titleToId }));
      }
      const nextItems = parsed.replaceExisting
        ? prepared.map((input) => updatedById.get(input.id!)!)
        : [
            ...prepared.map((input) => updatedById.get(input.id!)!),
            ...baseItems.filter((item) => !updatedById.has(item.id)),
          ];
      const nextStore: WorkStore = { ...store, items: nextItems };
      await saveWorkManagerStore(getS3Client, storage, nextStore);
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          replaceExisting: Boolean(parsed.replaceExisting),
          itemCount: nextStore.items.length,
          upsertedItemIds: prepared.map((item) => item.id),
        }, null, 2),
        toolMessage: `${parsed.replaceExisting ? "Replaced" : "Upserted"} ${prepared.length} work item${prepared.length === 1 ? "" : "s"} in ${parsed.slotPath.join(" / ")}.`,
      };
    }

    case "read_markdown_slot": {
      const parsed = parseToolArgs<{ slotPath: string[]; maxCharsPerFile?: number }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-markdown-viewer");
      const state = await readMarkdownSlotState({
        getS3Client,
        slot,
        configBucket,
        maxCharsPerFile: parsed.maxCharsPerFile,
      });
      return {
        output: JSON.stringify({
          slotPath: parsed.slotPath,
          ...state,
        }, null, 2),
        toolMessage: `Read markdown slot ${parsed.slotPath.join(" / ")}.`,
      };
    }

    case "replace_markdown_slot_content": {
      const parsed = parseToolArgs<{
        slotPath: string[];
        title?: string;
        entryPath: string;
        files: MarkdownFileInput[];
      }>(toolCall.arguments);
      if (!assetsTable) throw new Error("Project asset table is not configured.");
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-markdown-viewer");
      const title = parsed.title?.trim()
        || (typeof slot.meta?.["title"] === "string" ? slot.meta["title"] as string : "")
        || (typeof slot.meta?.["tabName"] === "string" ? slot.meta["tabName"] as string : "")
        || slot.slotId;
      const created = await createMarkdownFileSetAsset({
        getS3Client,
        getDdbClient,
        assetsTable,
        projectId,
        bucket: configBucket,
        label: title,
        entryPath: parsed.entryPath,
        files: parsed.files,
        moduleInstanceId: slot.slotId,
      });
      const nextMeta = {
        ...(slot.meta ?? {}),
        title,
        tabName: title,
        prefix: created.prefix,
        rootKey: created.rootKey,
        bucket: created.bucket,
        assetId: created.assetId,
        versionId: created.versionId,
        manifestKey: created.manifestKey,
      };
      const updatedRoot: ModuleConfig = {
        ...context.rootConfig,
        children: upsertSlotAtPath({
          children: context.rootConfig.children,
          parentSlotPath: parsed.slotPath.slice(0, -1),
          slot: {
            ...slot,
            meta: nextMeta,
          },
        }),
      };
      await writeRootConfig({ getS3Client, configBucket, configPath, rootConfig: updatedRoot });
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          assetId: created.assetId,
          versionId: created.versionId,
          rootKey: created.rootKey,
        }, null, 2),
        toolMessage: `Replaced markdown content for ${parsed.slotPath.join(" / ")}.`,
        mutatedWorkspace: true,
      };
    }

    case "create_links_slot": {
      const parsed = parseToolArgs<{
        parentSlotPath?: string[];
        slotId: string;
        title: string;
        links: Array<{ text: string; url: string }>;
      }>(toolCall.arguments);
      const links = parsed.links
        .map((link) => ({
          text: link.text.trim(),
          url: normalizeExternalUrl(link.url),
        }))
        .filter((link) => link.text && link.url);
      if (!links.length) throw new Error("At least one valid link is required.");
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const entry = findModuleEntry(registryEntries, "modules/links");
      if (!entry) throw new Error("Published module not found: modules/links");
      const parentPath = parsed.parentSlotPath ?? [];
      const nextSlot: ChildSlot = {
        slotId: parsed.slotId,
        app: { bucket: entry.bundleBucket, key: entry.bundlePath },
        meta: {
          title: parsed.title,
          links,
        },
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
          slotPath: [...parentPath, parsed.slotId],
          links,
        }, null, 2),
        toolMessage: `Created links slot ${[...parentPath, parsed.slotId].join(" / ")} with ${links.length} link${links.length === 1 ? "" : "s"}.`,
        mutatedWorkspace: true,
      };
    }

    case "set_links_slot_items": {
      const parsed = parseToolArgs<{
        slotPath: string[];
        links: Array<{ text: string; url: string }>;
      }>(toolCall.arguments);
      const links = parsed.links
        .map((link) => ({
          text: link.text.trim(),
          url: normalizeExternalUrl(link.url),
        }))
        .filter((link) => link.text && link.url);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-links");
      const updatedRoot: ModuleConfig = {
        ...context.rootConfig,
        children: upsertSlotAtPath({
          children: context.rootConfig.children,
          parentSlotPath: parsed.slotPath.slice(0, -1),
          slot: {
            ...slot,
            meta: {
              ...(slot.meta ?? {}),
              links,
            },
          },
        }),
      };
      await writeRootConfig({ getS3Client, configBucket, configPath, rootConfig: updatedRoot });
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          links,
        }, null, 2),
        toolMessage: `Updated ${links.length} link${links.length === 1 ? "" : "s"} in ${parsed.slotPath.join(" / ")}.`,
        mutatedWorkspace: true,
      };
    }

    case "create_webview_slot": {
      const parsed = parseToolArgs<{
        parentSlotPath?: string[];
        slotId: string;
        title: string;
        url: string;
      }>(toolCall.arguments);
      const url = normalizeExternalUrl(parsed.url);
      if (!url) throw new Error("A valid URL is required.");
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const entry = findModuleEntry(registryEntries, "modules/webview");
      if (!entry) throw new Error("Published module not found: modules/webview");
      const parentPath = parsed.parentSlotPath ?? [];
      const nextSlot: ChildSlot = {
        slotId: parsed.slotId,
        app: { bucket: entry.bundleBucket, key: entry.bundlePath },
        meta: {
          title: parsed.title,
          url,
        },
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
          slotPath: [...parentPath, parsed.slotId],
          url,
        }, null, 2),
        toolMessage: `Created webview slot ${[...parentPath, parsed.slotId].join(" / ")}.`,
        mutatedWorkspace: true,
      };
    }

    case "set_webview_url": {
      const parsed = parseToolArgs<{ slotPath: string[]; url: string }>(toolCall.arguments);
      const url = normalizeExternalUrl(parsed.url);
      if (!url) throw new Error("A valid URL is required.");
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-webview");
      const updatedRoot: ModuleConfig = {
        ...context.rootConfig,
        children: upsertSlotAtPath({
          children: context.rootConfig.children,
          parentSlotPath: parsed.slotPath.slice(0, -1),
          slot: {
            ...slot,
            meta: {
              ...(slot.meta ?? {}),
              url,
            },
          },
        }),
      };
      await writeRootConfig({ getS3Client, configBucket, configPath, rootConfig: updatedRoot });
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          url,
        }, null, 2),
        toolMessage: `Updated webview URL for ${parsed.slotPath.join(" / ")}.`,
        mutatedWorkspace: true,
      };
    }

    case "replace_document_viewer_asset": {
      const parsed = parseToolArgs<{
        slotPath: string[];
        assetId?: string;
        workspacePath?: string;
        filename?: string;
        label?: string;
      }>(toolCall.arguments);
      if (!assetsTable) throw new Error("Project asset table is not configured.");
      if (!parsed.assetId && !parsed.workspacePath) {
        throw new Error("Provide either assetId or workspacePath.");
      }
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-document-viewer");

      let docMeta: { key: string; filename: string; bucket?: string; assetId?: string; versionId?: string };
      if (parsed.assetId) {
        const ddb = await getDdbClient();
        const assets = await listAssets({ ddb, tableName: assetsTable, projectId });
        const asset = assets.find((item) => item.assetId === parsed.assetId);
        if (!asset) throw new Error(`Project asset not found: ${parsed.assetId}`);
        const version = getCurrentAssetVersion(asset);
        docMeta = {
          key: version.key,
          filename: asset.label || basename(version.key),
          bucket: version.bucket,
          assetId: asset.assetId,
          versionId: version.versionId,
        };
      } else {
        if (!bridge) throw new Error("Local agent bridge is not configured.");
        const workspaceFile = await callBridge<{ content: string }>(bridge, "read_workspace_file", {
          path: parsed.workspacePath,
          encoding: "base64",
        });
        const bytes = Uint8Array.from(atob(workspaceFile.content), (ch) => ch.charCodeAt(0));
        const filename = parsed.filename ?? basename(parsed.workspacePath!);
        const created = await createProjectAssetFromBytes({
          getS3Client,
          getDdbClient,
          assetsTable,
          projectId,
          bucket: configBucket,
          label: parsed.label ?? filename,
          filename,
          bytes,
          mimeType: guessMimeType(filename, "application/pdf"),
          meta: {
            kind: "file",
            path: filename,
            sourceWorkspacePath: parsed.workspacePath,
            moduleInstanceId: slot.slotId,
            moduleType: "module-document-viewer",
          },
        });
        docMeta = {
          key: created.key,
          filename,
          bucket: created.bucket,
          assetId: created.assetId,
          versionId: created.versionId,
        };
      }

      const updatedRoot: ModuleConfig = {
        ...context.rootConfig,
        children: upsertSlotAtPath({
          children: context.rootConfig.children,
          parentSlotPath: parsed.slotPath.slice(0, -1),
          slot: {
            ...slot,
            meta: {
              ...(slot.meta ?? {}),
              doc: docMeta,
            },
          },
        }),
      };
      await writeRootConfig({ getS3Client, configBucket, configPath, rootConfig: updatedRoot });
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          doc: docMeta,
        }, null, 2),
        toolMessage: `Replaced document for ${parsed.slotPath.join(" / ")}.`,
        mutatedWorkspace: true,
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

    case "focus_slot": {
      const parsed = parseToolArgs<{ slotPath: string[]; bucket?: string; configPath?: string }>(toolCall.arguments);
      if ((parsed.bucket && !parsed.configPath) || (!parsed.bucket && parsed.configPath)) {
        throw new Error("bucket and configPath must be provided together when navigating to another project.");
      }
      try {
        window.sessionStorage.setItem("auth-shell:pending-slot-focus", parsed.slotPath.join("/"));
      } catch {
        // ignore storage issues and rely on immediate event delivery
      }
      if (parsed.bucket && parsed.configPath) {
        const url = new URL(window.location.href);
        url.searchParams.set("bucket", parsed.bucket);
        url.searchParams.set("config", parsed.configPath);
        history.pushState(null, "", url.toString());
        window.dispatchEvent(new Event("shell:navigate"));
      }
      window.dispatchEvent(new CustomEvent("shell:focus-slot", { detail: { slotPath: parsed.slotPath } }));
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          navigatedToProject: Boolean(parsed.bucket && parsed.configPath),
        }, null, 2),
        toolMessage: `Focused slot ${parsed.slotPath.join(" / ")}.`,
      };
    }

    case "list_task_tracker_tasks": {
      const parsed = parseToolArgs<{ slotPath: string[] }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-task-tracker");
      const { storage, store } = await loadTaskTrackerStore(getS3Client, {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      }, configBucket, configPath, projectId);
      return {
        output: JSON.stringify({
          slotPath: parsed.slotPath,
          bucket: storage.bucket,
          tasksKey: storage.tasksKey,
          count: store.tasks.length,
          tasks: store.tasks,
        }, null, 2),
        toolMessage: `Listed ${store.tasks.length} task-tracker tasks.`,
      };
    }

    case "create_task_tracker_tasks": {
      const parsed = parseToolArgs<{
        slotPath: string[];
        tasks: Array<Partial<TaskRecord> & { title: string }>;
      }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-task-tracker");
      const { storage, store } = await loadTaskTrackerStore(getS3Client, {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      }, configBucket, configPath, projectId);
      const created = parsed.tasks.map((task) => defaultTaskRecord(userEmail, {
        title: task.title,
        description: task.description ?? "",
        notes: task.notes ?? "",
        status: task.status ?? "open",
        priority: task.priority ?? "normal",
        assignee: task.assignee,
        tags: task.tags ?? [],
        repeatable: task.repeatable ?? false,
      }));
      const nextStore: TaskStore = { ...store, tasks: [...created, ...store.tasks] };
      await saveTaskTrackerStore(getS3Client, storage, nextStore);
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          createdTaskIds: created.map((task) => task.id),
          taskCount: nextStore.tasks.length,
        }, null, 2),
        toolMessage: `Created ${created.length} task${created.length === 1 ? "" : "s"} in ${parsed.slotPath.join(" / ")}.`,
      };
    }

    case "update_task_tracker_task": {
      const parsed = parseToolArgs<{
        slotPath: string[];
        taskId: string;
        patch: Partial<TaskRecord>;
      }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-task-tracker");
      const { storage, store } = await loadTaskTrackerStore(getS3Client, {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      }, configBucket, configPath, projectId);
      const existing = store.tasks.find((task) => task.id === parsed.taskId);
      if (!existing) throw new Error(`Task not found: ${parsed.taskId}`);
      const nextStore: TaskStore = {
        ...store,
        tasks: store.tasks.map((task) => (
          task.id === parsed.taskId
            ? { ...task, ...parsed.patch, updatedAt: nowIso() }
            : task
        )),
      };
      await saveTaskTrackerStore(getS3Client, storage, nextStore);
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          taskId: parsed.taskId,
        }, null, 2),
        toolMessage: `Updated task ${parsed.taskId}.`,
      };
    }

    case "delete_task_tracker_task": {
      const parsed = parseToolArgs<{ slotPath: string[]; taskId: string }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-task-tracker");
      const { storage, store } = await loadTaskTrackerStore(getS3Client, {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      }, configBucket, configPath, projectId);
      const existing = store.tasks.find((task) => task.id === parsed.taskId);
      if (!existing) throw new Error(`Task not found: ${parsed.taskId}`);
      const s3 = await getS3Client(storage.bucket);
      await Promise.all(existing.attachments.map((attachment) =>
        deleteObjectIfExists(s3, attachment.bucket, attachment.key)
      ));
      const nextStore: TaskStore = {
        ...store,
        tasks: store.tasks.filter((task) => task.id !== parsed.taskId),
      };
      await saveTaskTrackerStore(getS3Client, storage, nextStore);
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          taskId: parsed.taskId,
        }, null, 2),
        toolMessage: `Deleted task ${parsed.taskId}.`,
      };
    }

    case "attach_project_asset_to_task": {
      const parsed = parseToolArgs<{ slotPath: string[]; taskId: string; assetId: string }>(toolCall.arguments);
      if (!assetsTable) throw new Error("Project asset table is not configured.");
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-task-tracker");
      const { storage, store } = await loadTaskTrackerStore(getS3Client, {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      }, configBucket, configPath, projectId);
      const existing = store.tasks.find((task) => task.id === parsed.taskId);
      if (!existing) throw new Error(`Task not found: ${parsed.taskId}`);
      const ddb = await getDdbClient();
      const assets = await listAssets({ ddb, tableName: assetsTable, projectId });
      const asset = assets.find((item) => item.assetId === parsed.assetId);
      if (!asset) throw new Error(`Project asset not found: ${parsed.assetId}`);
      const version = getCurrentAssetVersion(asset);
      const attachment: TaskAttachment = {
        id: makeAttachmentId(),
        name: asset.label || basename(version.key),
        bucket: version.bucket,
        key: version.key,
        size: version.sizeBytes ?? 0,
        contentType: version.mimeType,
        uploadedAt: nowIso(),
        uploadedBy: userEmail,
      };
      const nextStore: TaskStore = {
        ...store,
        tasks: store.tasks.map((task) => (
          task.id === parsed.taskId
            ? { ...task, attachments: [...task.attachments, attachment], updatedAt: nowIso() }
            : task
        )),
      };
      await saveTaskTrackerStore(getS3Client, storage, nextStore);
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          taskId: parsed.taskId,
          attachment,
        }, null, 2),
        toolMessage: `Attached asset ${parsed.assetId} to task ${parsed.taskId}.`,
      };
    }

    case "read_documentation_tree": {
      const parsed = parseToolArgs<{ slotPath: string[]; includeContent?: boolean; maxCharsPerDoc?: number }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-documentation-viewer");
      const slotConfig: ModuleConfig = {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      };
      const { storage, manifest, contents } = await loadDocumentationSlotState(getS3Client, slotConfig);
      const maxCharsPerDoc = Math.max(200, Math.min(parsed.maxCharsPerDoc ?? 12000, 50000));
      const docs = Object.values(manifest.docs).map((doc) => ({
        id: doc.id,
        title: doc.title,
        kind: doc.kind ?? "page",
        parentId: doc.parentId,
        children: doc.children,
        slug: doc.slug,
        relativePath: doc.relativePath,
        content: parsed.includeContent ? (contents[doc.id] ?? "").slice(0, maxCharsPerDoc) : undefined,
        contentPreview: (contents[doc.id] ?? "").slice(0, 600),
      }));
      return {
        output: JSON.stringify({
          slotPath: parsed.slotPath,
          storage,
          rootDocId: manifest.rootDocId,
          docs,
        }, null, 2),
        toolMessage: `Read documentation tree for ${parsed.slotPath.join(" / ")}.`,
      };
    }

    case "search_documentation_content": {
      const parsed = parseToolArgs<{ slotPath: string[]; query: string; limit?: number; maxSnippetChars?: number }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-documentation-viewer");
      const slotConfig: ModuleConfig = {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      };
      const { storage, manifest, contents } = await loadDocumentationSlotState(getS3Client, slotConfig);
      const query = parsed.query.trim().toLowerCase();
      const limit = Math.max(1, Math.min(parsed.limit ?? 20, 100));
      const maxSnippetChars = Math.max(80, Math.min(parsed.maxSnippetChars ?? 500, 4000));
      if (!query) {
        throw new Error("query is required.");
      }
      const terms = query.split(/\s+/).filter(Boolean);
      const matches = Object.values(manifest.docs)
        .map((doc) => {
          const content = contents[doc.id] ?? "";
          const haystack = `${doc.title}\n${content}`.toLowerCase();
          let score = haystack.includes(query) ? 50 : 0;
          for (const term of terms) {
            if (haystack.includes(term)) score += 10;
          }
          const firstHit = terms
            .map((term) => haystack.indexOf(term))
            .filter((idx) => idx >= 0)
            .sort((a, b) => a - b)[0] ?? (haystack.indexOf(query) >= 0 ? haystack.indexOf(query) : -1);
          let snippet = "";
          if (firstHit >= 0) {
            const start = Math.max(0, firstHit - Math.floor(maxSnippetChars / 3));
            const end = Math.min(content.length, start + maxSnippetChars);
            snippet = content.slice(start, end);
          } else {
            snippet = content.slice(0, maxSnippetChars);
          }
          return {
            id: doc.id,
            title: doc.title,
            kind: doc.kind ?? "page",
            parentId: doc.parentId,
            relativePath: doc.relativePath,
            score,
            snippet,
          };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
        .slice(0, limit);
      return {
        output: JSON.stringify({
          slotPath: parsed.slotPath,
          storage,
          query: parsed.query,
          count: matches.length,
          matches,
        }, null, 2),
        toolMessage: `Searched documentation content for "${parsed.query}" in ${parsed.slotPath.join(" / ")}.`,
      };
    }

    case "read_documentation_pages": {
      const parsed = parseToolArgs<{ slotPath: string[]; docIds: string[]; maxCharsPerDoc?: number }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-documentation-viewer");
      const slotConfig: ModuleConfig = {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      };
      const { storage, manifest, contents } = await loadDocumentationSlotState(getS3Client, slotConfig);
      const maxCharsPerDoc = Math.max(200, Math.min(parsed.maxCharsPerDoc ?? 12000, 50000));
      const docs = parsed.docIds.map((docId) => {
        const doc = manifest.docs[docId];
        if (!doc) {
          throw new Error(`Documentation page not found: ${docId}`);
        }
        const content = contents[docId] ?? "";
        return {
          id: doc.id,
          title: doc.title,
          kind: doc.kind ?? "page",
          parentId: doc.parentId,
          children: doc.children,
          slug: doc.slug,
          relativePath: doc.relativePath,
          content: content.slice(0, maxCharsPerDoc),
          truncated: content.length > maxCharsPerDoc,
        };
      });
      return {
        output: JSON.stringify({
          slotPath: parsed.slotPath,
          storage,
          docs,
        }, null, 2),
        toolMessage: `Read ${docs.length} documentation page${docs.length === 1 ? "" : "s"} from ${parsed.slotPath.join(" / ")}.`,
      };
    }

    case "create_documentation_page": {
      const parsed = parseToolArgs<{
        slotPath: string[];
        currentDocId: string;
        title: string;
        action: LinkAction;
        content?: string;
      }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-documentation-viewer");
      const slotConfig: ModuleConfig = {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      };
      const { storage, manifest, contents } = await loadDocumentationSlotState(getS3Client, slotConfig);
      if (!manifest.docs[parsed.currentDocId]) {
        throw new Error(`Documentation page not found: ${parsed.currentDocId}`);
      }
      const created = createLinkedPage(manifest, contents, parsed.currentDocId, parsed.title, parsed.action);
      const nextContents = {
        ...created.contents,
        [created.newDocId]: parsed.content ?? created.contents[created.newDocId] ?? `# ${parsed.title}\n\n`,
      };
      await persistDocumentationSlotState({
        getS3Client,
        storage,
        previousManifest: manifest,
        nextManifest: created.manifest,
        contents: nextContents,
      });
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          docId: created.newDocId,
          relativePath: created.manifest.docs[created.newDocId]?.relativePath,
        }, null, 2),
        toolMessage: `Created documentation page ${parsed.title}.`,
      };
    }

    case "update_documentation_page": {
      const parsed = parseToolArgs<{ slotPath: string[]; docId: string; content: string }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-documentation-viewer");
      const slotConfig: ModuleConfig = {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      };
      const { storage, manifest } = await loadDocumentationSlotState(getS3Client, slotConfig);
      if (!manifest.docs[parsed.docId]) {
        throw new Error(`Documentation page not found: ${parsed.docId}`);
      }
      if ((manifest.docs[parsed.docId].kind ?? "page") === "section" || !manifest.docs[parsed.docId].relativePath) {
        throw new Error(`Documentation section cannot be edited as a markdown page: ${parsed.docId}`);
      }
      const s3 = await getS3Client(storage.bucket);
      await writeTextObject(s3, storage.bucket, getDocKey(storage, manifest.docs[parsed.docId].relativePath), parsed.content, "text/markdown");
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          docId: parsed.docId,
        }, null, 2),
        toolMessage: `Updated documentation page ${parsed.docId}.`,
      };
    }

    case "rename_documentation_page": {
      const parsed = parseToolArgs<{ slotPath: string[]; docId: string; title: string }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-documentation-viewer");
      const slotConfig: ModuleConfig = {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      };
      const { storage, manifest, contents } = await loadDocumentationSlotState(getS3Client, slotConfig);
      if (!manifest.docs[parsed.docId]) {
        throw new Error(`Documentation page not found: ${parsed.docId}`);
      }
      const nextManifest = renameDoc(manifest, parsed.docId, parsed.title);
      await persistDocumentationSlotState({
        getS3Client,
        storage,
        previousManifest: manifest,
        nextManifest,
        contents,
      });
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          docId: parsed.docId,
          title: parsed.title,
        }, null, 2),
        toolMessage: `Renamed documentation page ${parsed.docId}.`,
      };
    }

    case "move_documentation_page": {
      const parsed = parseToolArgs<{ slotPath: string[]; docId: string; direction: MoveDirection }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-documentation-viewer");
      const slotConfig: ModuleConfig = {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      };
      const { storage, manifest, contents } = await loadDocumentationSlotState(getS3Client, slotConfig);
      if (!manifest.docs[parsed.docId]) {
        throw new Error(`Documentation page not found: ${parsed.docId}`);
      }
      const nextManifest = moveDoc(manifest, parsed.docId, parsed.direction);
      await persistDocumentationSlotState({
        getS3Client,
        storage,
        previousManifest: manifest,
        nextManifest,
        contents,
      });
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          docId: parsed.docId,
          direction: parsed.direction,
        }, null, 2),
        toolMessage: `Moved documentation page ${parsed.docId} ${parsed.direction}.`,
      };
    }

    case "delete_documentation_page": {
      const parsed = parseToolArgs<{ slotPath: string[]; docId: string }>(toolCall.arguments);
      const context = await loadWorkspaceContext(getS3Client, configBucket, configPath, projectId);
      const slot = requireModuleAtPath(context.rootConfig, parsed.slotPath, "module-documentation-viewer");
      const slotConfig: ModuleConfig = {
        id: slot.slotId,
        app: slot.app,
        meta: slot.meta,
        resources: slot.resources,
        children: slot.children,
      };
      const { storage, manifest, contents } = await loadDocumentationSlotState(getS3Client, slotConfig);
      if (!manifest.docs[parsed.docId]) {
        throw new Error(`Documentation page not found: ${parsed.docId}`);
      }
      const removed = removeDoc(manifest, contents, parsed.docId);
      await persistDocumentationSlotState({
        getS3Client,
        storage,
        previousManifest: manifest,
        nextManifest: removed.manifest,
        contents: removed.contents,
      });
      return {
        output: JSON.stringify({
          status: "ok",
          slotPath: parsed.slotPath,
          docId: parsed.docId,
          nextSelectedId: removed.nextSelectedId,
        }, null, 2),
        toolMessage: `Deleted documentation page ${parsed.docId}.`,
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
  const bridgeEnabledKey = useMemo(() => buildBridgeEnabledKey(projectId, config.id), [projectId, config.id]);
  const bridgeAppspaceSessionId = useMemo(() => `appspace:${projectId}:${config.id}`, [projectId, config.id]);

  const meta = (config.meta as ChatMeta | undefined) ?? {};
  const title = meta.title?.trim() || DEFAULT_TITLE;
  const model = meta.model?.trim() || DEFAULT_MODEL;
  const systemPrompt = meta.systemPrompt?.trim() || DEFAULT_PROMPT;
  const bridgeDefaults = useMemo(() => readBridgeDefaults(), []);
  const installBaseUrl = useMemo(() => getInstallBaseUrl(bridgeDefaults), [bridgeDefaults]);

  const [apiKey, setApiKey] = useState("");
  const [draftApiKey, setDraftApiKey] = useState("");
  const [bridgeUrl, setBridgeUrl] = useState("");
  const [bridgeToken, setBridgeToken] = useState("");
  const [localRuntimeEnabled, setLocalRuntimeEnabled] = useState(false);
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealth | null>(null);
  const [bridgeCheckLoading, setBridgeCheckLoading] = useState(false);
  const [bridgeWorkspaceRoot, setBridgeWorkspaceRoot] = useState("");
  const [draftBridgeUrl, setDraftBridgeUrl] = useState("");
  const [draftBridgeToken, setDraftBridgeToken] = useState("");
  const [bridgeBrowserOpen, setBridgeBrowserOpen] = useState(false);
  const [bridgeBrowserPath, setBridgeBrowserPath] = useState("");
  const [bridgeBrowserEntries, setBridgeBrowserEntries] = useState<BridgeListResult["files"]>([]);
  const [bridgeBrowserLoading, setBridgeBrowserLoading] = useState(false);
  const [bridgeBrowserError, setBridgeBrowserError] = useState<string | undefined>();
  const [newFolderName, setNewFolderName] = useState("");
  const [composer, setComposer] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [organizerStore, setOrganizerStore] = useState<OrganizerStore>({ version: 1, projectId, items: [] });
  const [organizerOpen, setOrganizerOpen] = useState(false);
  const [organizerLoading, setOrganizerLoading] = useState(false);
  const [organizerError, setOrganizerError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
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
  const runAbortRef = useRef<AbortController | null>(null);

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
    const storedUrl = safeReadLocalStorage(bridgeUrlKey);
    const storedToken = safeReadLocalStorage(bridgeTokenKey);
    const storedWorkspaceRoot = safeReadLocalStorage(bridgeWorkspaceRootKey) || "";
    const storedEnabled = safeReadLocalStorage(bridgeEnabledKey) === "true";
    const resolvedUrl = bridgeDefaults.url || storedUrl || "";
    const resolvedToken = bridgeDefaults.token || storedToken || "";
    setBridgeUrl(storedUrl);
    setBridgeUrl(resolvedUrl);
    setBridgeToken(resolvedToken);
    setLocalRuntimeEnabled(storedEnabled);
    setBridgeHealth(null);
    setBridgeWorkspaceRoot(storedWorkspaceRoot);
    setDraftBridgeUrl(resolvedUrl);
    setDraftBridgeToken(resolvedToken);
    if (bridgeDefaults.url) {
      safeWriteLocalStorage(bridgeUrlKey, bridgeDefaults.url);
    }
    if (bridgeDefaults.token) {
      safeWriteLocalStorage(bridgeTokenKey, bridgeDefaults.token);
    }
  }, [bridgeDefaults, bridgeEnabledKey, bridgeTokenKey, bridgeUrlKey, bridgeWorkspaceRootKey]);

  async function refreshOrganizerStore() {
    setOrganizerLoading(true);
    setOrganizerError(undefined);
    try {
      const { store } = await loadOrganizerStore(getS3Client, configBucket, configPath, projectId, config.id);
      setOrganizerStore(store);
    } catch (error) {
      setOrganizerError((error as Error).message);
    } finally {
      setOrganizerLoading(false);
    }
  }

  useEffect(() => {
    void refreshOrganizerStore();
  }, [config.id, configBucket, configPath, getS3Client, projectId]);

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
  const activeBridge = localRuntimeEnabled && bridgeUrl.trim() && bridgeToken.trim()
    ? { url: bridgeUrl.trim(), token: bridgeToken.trim() }
    : null;
  const bridgeLabel = localRuntimeEnabled
    ? bridgeUrl
      ? `${bridgeUrl} · ${maskBridgeToken(bridgeToken)}`
      : "Enabled, not configured"
    : "Disabled";
  const canSend = !!apiKey.trim() && !!composer.trim() && !busy;
  const canSaveSettings = !!metaDraft.title.trim() && !!metaDraft.model.trim() && !!metaDraft.systemPrompt.trim() && !busy;
  const continuationPending = Boolean(pendingContinuation);
  const organizerVisibleItems = organizerStore.items.filter((item) => item.status !== "archived");
  const organizerSummary = summarizeOrganizerStore(organizerStore);
  const organizerRecentItems = organizerVisibleItems
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);

  async function syncBridgeAppspaceContext(bridge: BridgeConfig | null = activeBridge) {
    if (!bridge) return;
    const snapshot = await buildAppspaceContextSnapshot({
      config,
      projectId,
      configBucket,
      configPath,
      getS3Client,
      getDdbClient,
      assetsTable,
      loadedResources: resources,
      registryEntries,
      bridgeWorkspaceRoot,
    });
    await callBridge(bridge, "sync_appspace_context", {
      sessionId: bridgeAppspaceSessionId,
      context: snapshot,
    });
  }

  async function executeBrowserWorkspaceOperation(
    operation: string,
    params: Record<string, unknown>,
    bridge: BridgeConfig | null = activeBridge,
  ): Promise<ToolExecutionResult> {
    return executeTool({
      toolCall: {
        type: "function_call",
        call_id: `bridge_${Date.now()}`,
        name: operation,
        arguments: JSON.stringify(params),
      },
          config,
          projectId,
          configBucket,
          configPath,
          userEmail: user?.email?.toLowerCase(),
          getS3Client,
      getDdbClient,
      assetsTable,
      loadedResources: resources,
      registryEntries,
      bridge,
    });
  }

  async function processQueuedBridgeAppspaceOperations(bridge: BridgeConfig | null = activeBridge) {
    if (!bridge) return;
    const queued = await callBridge<BridgeAppspaceOperationsResult>(bridge, "list_appspace_operations", {
      sessionId: bridgeAppspaceSessionId,
      status: "queued",
      limit: 25,
    });
    let mutatedWorkspace = false;
    for (const operation of queued.operations) {
      try {
        const result = await executeBrowserWorkspaceOperation(operation.operation, operation.args ?? {}, bridge);
        mutatedWorkspace = mutatedWorkspace || Boolean(result.mutatedWorkspace);
        await callBridge(bridge, "complete_appspace_operation", {
          sessionId: bridgeAppspaceSessionId,
          operationId: operation.id,
          status: "completed",
          result: {
            output: result.output,
            toolMessage: result.toolMessage,
            mutatedWorkspace: result.mutatedWorkspace,
          },
        });
      } catch (error) {
        await callBridge(bridge, "complete_appspace_operation", {
          sessionId: bridgeAppspaceSessionId,
          operationId: operation.id,
          status: "failed",
          error: (error as Error).message,
        });
      }
    }
    if (mutatedWorkspace) {
      await syncBridgeAppspaceContext(bridge);
      window.dispatchEvent(new Event("shell:navigate"));
    }
  }

  useEffect(() => {
    const bridge = activeBridge;
    if (!bridge) return;
    let cancelled = false;

    async function tick() {
      if (cancelled || busy) return;
      try {
        await syncBridgeAppspaceContext(bridge);
        await processQueuedBridgeAppspaceOperations(bridge);
      } catch (error) {
        console.debug("[chat-codex] bridge appspace sync failed", {
          message: (error as Error).message,
        });
      }
    }

    void tick();
    const intervalId = window.setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    activeBridge?.url,
    activeBridge?.token,
    bridgeAppspaceSessionId,
    bridgeWorkspaceRoot,
    busy,
    config,
    configBucket,
    configPath,
    projectId,
    assetsTable,
    resources,
    registryEntries,
  ]);

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
    if (!localRuntimeEnabled) {
      setConnectionError("Enable the local runtime before saving or checking a pairing token.");
      return;
    }
    const normalizedUrl = draftBridgeUrl.trim().replace(/\/$/, "");
    const normalizedToken = draftBridgeToken.trim();
    if (!normalizedUrl || !normalizedToken) {
      setConnectionError("Bridge URL and bridge token are both required.");
      return;
    }

    try {
      const bridge = { url: normalizedUrl, token: normalizedToken };
      const status = await getBridgeStatus(bridge);
      safeWriteLocalStorage(bridgeUrlKey, normalizedUrl);
      safeWriteLocalStorage(bridgeTokenKey, normalizedToken);
      safeWriteLocalStorage(bridgeWorkspaceRootKey, status.workspaceRoot ?? "");
      setBridgeUrl(normalizedUrl);
      setBridgeToken(normalizedToken);
      setBridgeWorkspaceRoot(status.workspaceRoot ?? "");
      setConnectionError(undefined);
    } catch (error) {
      setConnectionError((error as Error).message);
    }
  }

  function handleForgetBridge() {
    safeWriteLocalStorage(bridgeUrlKey, "");
    safeWriteLocalStorage(bridgeTokenKey, "");
    safeWriteLocalStorage(bridgeWorkspaceRootKey, "");
    safeWriteLocalStorage(bridgeEnabledKey, "");
    setBridgeUrl("");
    setBridgeToken("");
    setLocalRuntimeEnabled(false);
    setBridgeHealth(null);
    setBridgeWorkspaceRoot("");
    setDraftBridgeUrl("");
    setDraftBridgeToken("");
  }

  async function checkLocalRuntime(urlOverride?: string) {
    const normalizedUrl = (urlOverride ?? (draftBridgeUrl.trim() || bridgeUrl.trim() || "http://127.0.0.1:4317")).replace(/\/$/, "");
    setBridgeCheckLoading(true);
    setConnectionError(undefined);
    try {
      const health = await getBridgeHealth(normalizedUrl);
      setBridgeHealth(health);
      setDraftBridgeUrl(normalizedUrl);
      if (!bridgeUrl) {
        setBridgeUrl(normalizedUrl);
        safeWriteLocalStorage(bridgeUrlKey, normalizedUrl);
      }
    } catch (error) {
      setBridgeHealth(null);
      setConnectionError(
        `Local runtime was not found at ${normalizedUrl}. Install it, start it, or update the URL. ${(error as Error).message}`
      );
    } finally {
      setBridgeCheckLoading(false);
    }
  }

  function handleLocalRuntimeEnabledChange(enabled: boolean) {
    setLocalRuntimeEnabled(enabled);
    safeWriteLocalStorage(bridgeEnabledKey, enabled ? "true" : "");
    if (!enabled) {
      setBridgeBrowserOpen(false);
      return;
    }
    void checkLocalRuntime();
  }

  async function loadBridgeDirectory(path: string) {
    if (!localRuntimeEnabled) {
      setBridgeBrowserError("Enable the local runtime before browsing local folders.");
      return;
    }
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
    if (!localRuntimeEnabled) {
      setConnectionError("Check Enable local runtime before choosing a workspace root.");
      return;
    }
    const bridge = draftBridgeUrl.trim() && draftBridgeToken.trim()
      ? { url: draftBridgeUrl.trim().replace(/\/$/, ""), token: draftBridgeToken.trim() }
      : bridgeUrl.trim() && bridgeToken.trim()
        ? { url: bridgeUrl.trim(), token: bridgeToken.trim() }
        : null;

    if (!bridge) {
      setConnectionError("Save the bridge URL and token before choosing a workspace root.");
      return;
    }

    setBridgeBrowserOpen(true);
    setNewFolderName("");
    setBridgeBrowserError(undefined);
    try {
      const status = await getBridgeStatus(bridge);
      const startPath = bridgeWorkspaceRoot || status.workspaceRoot || status.browseStartPath || ".";
      await loadBridgeDirectory(startPath);
    } catch (error) {
      setBridgeBrowserError((error as Error).message);
    }
  }

  async function handleSelectBridgeWorkspaceRoot(path: string) {
    if (!localRuntimeEnabled) {
      setConnectionError("Enable the local runtime before changing the workspace root.");
      return;
    }
    const bridge = draftBridgeUrl.trim() && draftBridgeToken.trim()
      ? { url: draftBridgeUrl.trim().replace(/\/$/, ""), token: draftBridgeToken.trim() }
      : bridgeUrl.trim() && bridgeToken.trim()
        ? { url: bridgeUrl.trim(), token: bridgeToken.trim() }
        : null;

    if (!bridge) {
      setConnectionError("Save the bridge URL and token before changing the workspace root.");
      return;
    }

    const status = await callBridge<BridgeStatus>(bridge, "set_workspace_root", { path });
    safeWriteLocalStorage(bridgeWorkspaceRootKey, status.workspaceRoot ?? "");
    setBridgeWorkspaceRoot(status.workspaceRoot ?? "");
    setConnectionError(undefined);
    setBridgeBrowserOpen(false);
  }

  async function handleCreateBridgeFolder() {
    if (!localRuntimeEnabled) {
      setBridgeBrowserError("Enable the local runtime before creating local folders.");
      return;
    }
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
        parentPath: bridgeBrowserPath || bridgeWorkspaceRoot || ".",
        name,
      });
      setNewFolderName("");
      await loadBridgeDirectory(bridgeBrowserPath || bridgeWorkspaceRoot || ".");
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
    signal: AbortSignal;
    onProgress: (event: AgentProgressEvent) => void;
  }): Promise<AgentRunResult> {
    let inputItems = args.initialInputItems;
    let assistantText = "";
    let lastToolMessages: string[] = [];
    let shouldNavigate = false;

    for (let i = 0; i < TOOL_ITERATION_LIMIT; i++) {
      if (args.signal.aborted) {
        throw new DOMException("The agent run was stopped.", "AbortError");
      }
      const compacted = compactInputItems(inputItems);
      const instructions = compacted.truncatedSummary
        ? [...args.contextBits, compacted.truncatedSummary].join(" ")
        : args.contextBits.join(" ");
      if (compacted.truncatedSummary) {
        args.onProgress({
          kind: "status",
          text: "Older browser context was compacted for this step.",
        });
      }
      args.onProgress({
        kind: "status",
        text: `Working step ${i + 1} of up to ${TOOL_ITERATION_LIMIT}...`,
      });
      let response: ResponsesApiResponse;
      try {
        response = await createOpenAiResponse({
          apiKey: apiKey.trim(),
          input: compacted.inputItems,
          model,
          instructions,
          tools: TOOL_DEFINITIONS,
          signal: args.signal,
        });
      } catch (error) {
        if (isFunctionCallOutputMismatchError(error)) {
          const message =
            "The agent hit an OpenAI tool-history mismatch while continuing a multi-step run. " +
            "A tool output no longer matched a preserved tool call in the browser context. " +
            "I compacted context more safely for future steps, but this run stopped before the model could recover.";
          args.onProgress({
            kind: "tool_result",
            name: "tool_loop",
            text: message,
          });
          return {
            assistantText: `${message} Original error: ${(error as Error).message}`,
            lastToolMessages: [message],
            pending: null,
            shouldNavigate,
          };
        }
        if (isReasoningItemMismatchError(error)) {
          const message =
            "The agent hit an OpenAI reasoning-history mismatch while continuing a multi-step run. " +
            "A preserved function call no longer had its required reasoning item in browser context. " +
            "I updated compaction to keep entire tool-response blocks together, but this run stopped before the model could recover.";
          args.onProgress({
            kind: "tool_result",
            name: "tool_loop",
            text: message,
          });
          return {
            assistantText: `${message} Original error: ${(error as Error).message}`,
            lastToolMessages: [message],
            pending: null,
            shouldNavigate,
          };
        }
        throw error;
      }

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
        if (args.signal.aborted) {
          throw new DOMException("The agent run was stopped.", "AbortError");
        }
        console.debug("[chat-codex] tool call", {
          name: call.name,
          arguments: call.arguments,
        });
        args.onProgress({
          kind: "tool_call",
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
            userEmail: user?.email?.toLowerCase(),
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
          args.onProgress({
            kind: "tool_result",
            name: call.name,
            text: result.toolMessage,
          });
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

    const pendingCompacted = compactInputItems(inputItems);
    return {
      assistantText:
        `I reached the current tool-work limit of ${TOOL_ITERATION_LIMIT} steps. ` +
        "I still have my current working context and can keep going from here if you want.",
      lastToolMessages,
      pending: {
        inputItems: pendingCompacted.inputItems,
        contextBits: pendingCompacted.truncatedSummary
          ? [...args.contextBits, pendingCompacted.truncatedSummary]
          : args.contextBits,
        lastToolMessages,
      },
      shouldNavigate,
    };
  }

  async function submitUserPrompt(input: string) {
    if (!apiKey.trim() || !input) return;

    const userMessage = createMessage("user", input);
    const history = [...messages, userMessage];
    setMessages(history);
    setComposer("");
    setBusy(true);
    setStopRequested(false);
    setPendingContinuation(null);
    persistChatSessionNow(chatSessionKey, {
      messages: history,
      composer: "",
      pendingContinuation: null,
    });
    setConnectionError(undefined);

    try {
      const controller = new AbortController();
      runAbortRef.current = controller;
      const bridge = activeBridge;
      await syncBridgeAppspaceContext(bridge);
      await processQueuedBridgeAppspaceOperations(bridge);
      const contextBits: string[] = [
        systemPrompt,
        "You are running inside a browser-based project workspace shell.",
        "Prefer calling tools before making assumptions about project structure or available files/modules.",
        "The browser agent and local runtime share the same appspace operation names. When the local runtime is enabled, it can read the synced appspace context from the bridge and queue appspace operations for the browser to execute.",
        "When the user asks about information 'in here' or app documentation, start with project assets and registered resources before the local bridge workspace unless they explicitly ask for local files.",
        `Current project ID: ${projectId}.`,
        `Current module ID: ${config.id}.`,
        assetsTable ? `Project asset table is available as ${assetsTable}.` : "Project asset table is not configured.",
        `Loaded resource count: ${resources.size}.`,
        `Published module count: ${registryEntries.length}.`,
        bridge
          ? `Local runtime is enabled with workspace root ${bridgeWorkspaceRoot || "unknown"}.`
          : "Local runtime is disabled for this project/module. Do not use local filesystem, shell, Python, or PDF bridge tools unless the user enables it in settings.",
        organizerSummary,
        "Organizer memory is available through list_organizer_items, create_organizer_items, update_organizer_item, delete_organizer_item, batch_update_organizer_items, and mark_organizer_items_complete. Use it to maintain durable context when that will help the user.",
        user?.email ? `Signed-in user: ${user.email}.` : undefined,
      ].filter((value): value is string => Boolean(value));

      const session = await runAgentSession({
        initialInputItems: toInputItems(history),
        contextBits,
        bridge,
        signal: controller.signal,
        onProgress: (event) => {
          const text =
            event.kind === "status"
              ? event.text
              : event.kind === "tool_call"
                ? `Calling ${event.name}\n\n\`\`\`json\n${event.arguments || "{}"}\n\`\`\``
                : event.text;
          setMessages((current) => [...current, createMessage("tool", text)]);
        },
      });
      setPendingContinuation(session.pending);
      setMessages((current) => {
        const nextMessages = [...current, createMessage("assistant", session.assistantText || "The model returned no text output.")];
        persistChatSessionNow(chatSessionKey, {
          messages: nextMessages,
          composer: "",
          pendingContinuation: session.pending,
        });
        return nextMessages;
      });
      if (session.shouldNavigate) {
        window.dispatchEvent(new Event("shell:navigate"));
      }
      await refreshOrganizerStore();
    } catch (error) {
      console.debug("[chat-codex] tool loop error", {
        message: (error as Error).message,
      });
      setMessages((current) => {
        const nextMessages = [
          ...current,
          createMessage(isAbortError(error) ? "tool" : "error", isAbortError(error) ? "Agent run stopped." : (error as Error).message),
        ];
        persistChatSessionNow(chatSessionKey, {
          messages: nextMessages,
          composer: "",
          pendingContinuation: null,
        });
        return nextMessages;
      });
    } finally {
      runAbortRef.current = null;
      setBusy(false);
      setStopRequested(false);
    }
  }

  async function handleSend() {
    await submitUserPrompt(composer.trim());
  }

  async function handleOrganizerSweep() {
    const today = new Date().toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    await submitUserPrompt(
      [
        `Run an organizer sweep for ${today}.`,
        "Review the organizer memory first.",
        "Then check relevant work-manager tasks or schedules if they seem connected.",
        "Tell me what needs attention now, what looks stale, and what I am likely to forget.",
        "Update organizer items when that would improve continuity.",
        "Finish with a short action list.",
      ].join(" "),
    );
  }

  async function handleContinueWorking() {
    const pending = pendingContinuation;
    if (!apiKey.trim() || !pending || busy) return;

    setBusy(true);
    setStopRequested(false);
    setPendingContinuation(null);
    setConnectionError(undefined);

    try {
      const controller = new AbortController();
      runAbortRef.current = controller;
      const bridge = activeBridge;
      await syncBridgeAppspaceContext(bridge);
      await processQueuedBridgeAppspaceOperations(bridge);
      const session = await runAgentSession({
        initialInputItems: pending.inputItems,
        contextBits: pending.contextBits,
        bridge,
        signal: controller.signal,
        onProgress: (event) => {
          const text =
            event.kind === "status"
              ? event.text
              : event.kind === "tool_call"
                ? `Calling ${event.name}\n\n\`\`\`json\n${event.arguments || "{}"}\n\`\`\``
                : event.text;
          setMessages((current) => [...current, createMessage("tool", text)]);
        },
      });
      setPendingContinuation(session.pending);
      setMessages((current) => {
        const nextMessages = [...current, createMessage("assistant", session.assistantText || "The model returned no text output.")];
        persistChatSessionNow(chatSessionKey, {
          messages: nextMessages,
          composer,
          pendingContinuation: session.pending,
        });
        return nextMessages;
      });
      if (session.shouldNavigate) {
        window.dispatchEvent(new Event("shell:navigate"));
      }
      await refreshOrganizerStore();
    } catch (error) {
      console.debug("[chat-codex] continuation error", {
        message: (error as Error).message,
      });
      setMessages((current) => {
        const nextMessages = [
          ...current,
          createMessage(isAbortError(error) ? "tool" : "error", isAbortError(error) ? "Agent run stopped." : (error as Error).message),
        ];
        persistChatSessionNow(chatSessionKey, {
          messages: nextMessages,
          composer,
          pendingContinuation: null,
        });
        return nextMessages;
      });
    } finally {
      runAbortRef.current = null;
      setBusy(false);
      setStopRequested(false);
    }
  }

  function handleStopRun() {
    if (!runAbortRef.current) return;
    setStopRequested(true);
    runAbortRef.current.abort();
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
        <button onClick={() => setOrganizerOpen((value) => !value)} style={ghostButtonStyle}>
          {organizerOpen ? "Hide Organizer" : "Organizer"}
        </button>
        <button onClick={() => setSettingsOpen((value) => !value)} style={ghostButtonStyle}>
          {settingsOpen ? "Close" : "Settings"}
        </button>
      </div>

      {organizerOpen && (
        <div style={{ padding: "0.9rem", borderBottom: `1px solid ${C.border}`, background: "#0b1a2d", display: "grid", gap: "0.8rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "start", flexWrap: "wrap" }}>
            <div style={{ minWidth: 0, flex: "1 1 360px" }}>
              <div style={{ fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.08em", color: C.muted, marginBottom: "0.35rem" }}>
                Organizer Memory
              </div>
              <div style={{ fontSize: "0.84rem", lineHeight: 1.55, color: C.text }}>
                {organizerSummary}
              </div>
              {organizerError && <div style={{ marginTop: "0.45rem", fontSize: "0.74rem", color: C.danger }}>{organizerError}</div>}
            </div>
            <div style={{ display: "flex", gap: "0.55rem", flexWrap: "wrap" }}>
              <button onClick={() => void refreshOrganizerStore()} style={ghostButtonStyle} disabled={organizerLoading || busy}>
                {organizerLoading ? "Refreshing..." : "Refresh"}
              </button>
              <button onClick={() => void handleOrganizerSweep()} style={primaryButtonStyle} disabled={!apiKey.trim() || busy}>
                Run Organizer Sweep
              </button>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "0.6rem" }}>
            {[
              ["Visible", String(organizerVisibleItems.length)],
              ["Open", String(organizerVisibleItems.filter((item) => item.status === "open").length)],
              ["Active", String(organizerVisibleItems.filter((item) => item.status === "active").length)],
              ["Waiting On", String(organizerVisibleItems.filter((item) => item.kind === "waiting-on" && item.status !== "done").length)],
            ].map(([label, value]) => (
              <div key={label} style={{ padding: "0.75rem 0.8rem", border: `1px solid ${C.border}`, borderRadius: 12, background: "#071321" }}>
                <div style={{ fontSize: "0.72rem", color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
                <div style={{ marginTop: "0.25rem", fontSize: "1.1rem", fontWeight: 700 }}>{value}</div>
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gap: "0.5rem" }}>
            <div style={{ fontSize: "0.74rem", color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Recent Items
            </div>
            {organizerRecentItems.length === 0 ? (
              <div style={{ padding: "0.8rem 0.9rem", border: `1px solid ${C.border}`, borderRadius: 12, background: "#071321", fontSize: "0.8rem", color: C.muted }}>
                No organizer items yet. Ask Codex to remember notes, follow-ups, reminders, or waiting-on items and it can store them here.
              </div>
            ) : (
              organizerRecentItems.map((item) => (
                <div key={item.id} style={{ display: "grid", gap: "0.2rem", padding: "0.8rem 0.9rem", border: `1px solid ${C.border}`, borderRadius: 12, background: "#071321" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
                    <div style={{ fontSize: "0.84rem", fontWeight: 600 }}>{item.title}</div>
                    <div style={{ fontSize: "0.72rem", color: C.muted }}>{item.kind} · {item.status}</div>
                  </div>
                  {item.details ? (
                    <div style={{ fontSize: "0.78rem", lineHeight: 1.5, color: C.muted }}>
                      {item.details}
                    </div>
                  ) : null}
                  <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", fontSize: "0.72rem", color: C.muted }}>
                    {item.dueAt ? <span>Due {formatOrganizerDate(item.dueAt)}</span> : null}
                    {item.followUpAt ? <span>Follow up {formatOrganizerDate(item.followUpAt)}</span> : null}
                    {item.tags.length ? <span>Tags: {item.tags.join(", ")}</span> : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

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

          <div style={{ display: "grid", gap: "0.45rem" }}>
            <label style={labelStyle}>Local runtime</label>
            <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", fontSize: "0.82rem", lineHeight: 1.45, color: C.text }}>
              <input
                type="checkbox"
                checked={localRuntimeEnabled}
                onChange={(event) => handleLocalRuntimeEnabledChange(event.currentTarget.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                Enable local runtime for this project. This allows the agent to use local files, commands, Python tools, and future native Codex runtime features after pairing.
              </span>
            </label>
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
              <button
                onClick={() => void checkLocalRuntime()}
                style={ghostButtonStyle}
                disabled={!localRuntimeEnabled || bridgeCheckLoading}
              >
                {bridgeCheckLoading ? "Checking..." : "Check Runtime"}
              </button>
              <button onClick={handleSaveBridge} style={primaryButtonStyle}>
                Save Pairing Token
              </button>
              {(bridgeUrl || bridgeToken) && (
                <button onClick={handleForgetBridge} style={dangerButtonStyle}>
                  Forget Runtime
                </button>
              )}
            </div>
            <div style={{ fontSize: "0.72rem", color: C.muted }}>
              Disabled means no local runtime calls are made, even if the service is installed or a token is saved.
            </div>
            {bridgeHealth ? (
              <div style={{ fontSize: "0.72rem", color: C.muted }}>
                Runtime found: {bridgeHealth.name ?? "local runtime"} · protocol {bridgeHealth.protocolVersion ?? "unknown"} · capabilities {(bridgeHealth.capabilities ?? []).join(", ") || "none reported"}
              </div>
            ) : (
              <div style={{ display: "grid", gap: "0.35rem", padding: "0.65rem 0.75rem", border: `1px solid ${C.border}`, borderRadius: 10, background: "#071321" }}>
                <div style={{ fontSize: "0.76rem", color: C.muted }}>
                  If the runtime is not installed, download it for your platform, run the installer, then return here and check again.
                </div>
                <div style={{ display: "flex", gap: "0.55rem", flexWrap: "wrap" }}>
                  <a href={installHref(installBaseUrl, "windows")} style={linkButtonStyle}>Windows</a>
                  <a href={installHref(installBaseUrl, "macos")} style={linkButtonStyle}>macOS</a>
                  <a href={installHref(installBaseUrl, "linux")} style={linkButtonStyle}>Linux</a>
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: "0.55rem", flexWrap: "wrap", alignItems: "center" }}>
              <button onClick={() => void openBridgeBrowser()} style={primaryButtonStyle} disabled={!localRuntimeEnabled}>
                Set Workspace Root
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

      <div ref={scrollRef} style={{ minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "1rem", display: "grid", gap: "0.8rem", alignContent: messages.length ? "start" : "center" }}>
        {messages.length === 0 ? (
          <div style={{ maxWidth: 720, margin: "0 auto", padding: "1.2rem 1.25rem", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16 }}>
            <div style={{ fontSize: "0.95rem", fontWeight: 700, marginBottom: "0.45rem" }}>Workspace-side Codex test module</div>
            <div style={{ fontSize: "0.82rem", lineHeight: 1.6, color: C.muted }}>
              This version can inspect the workspace, browse assets and resources, manage organizer memory, list published modules, add or update slots, and use a local bridge for files, commands, and PDF analysis.
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} style={{ display: "flex", justifyContent: message.role === "user" ? "flex-end" : "flex-start", minWidth: 0, width: "100%" }}>
              <div style={bubbleStyle(message.role)}>
                <div style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.08em", color: C.muted, marginBottom: "0.3rem" }}>
                  {message.role === "user" ? "You" : message.role === "assistant" ? "Codex" : message.role === "tool" ? "Tool" : "Error"}
                </div>
                <MessageBody role={message.role} text={message.text} />
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
            placeholder="Ask Codex to inspect the workspace, remember a follow-up, sweep your open items, or make a concrete module/config change..."
            rows={3}
            style={{ ...inputStyle, resize: "none", minHeight: 84 }}
          />
          {busy ? (
            <button onClick={handleStopRun} style={stopButtonStyle(stopRequested)}>
              {stopRequested ? "Stopping..." : "Stop"}
            </button>
          ) : (
            <button disabled={!canSend} onClick={handleSend} style={sendButtonStyle(canSend)}>
              Send
            </button>
          )}
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
                onClick={() => void loadBridgeDirectory(parentPath(bridgeBrowserPath || bridgeWorkspaceRoot || "."))}
                style={ghostButtonStyle}
                disabled={bridgeBrowserLoading}
              >
                Up
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
                            onClick={() => void handleSelectBridgeWorkspaceRoot(nextPath)}
                            style={primaryButtonStyle}
                            disabled={bridgeBrowserLoading}
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
              Selecting a folder sets it as the workspace root and closes this window.
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

const linkButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: `1px solid ${C.border}`,
  borderRadius: 999,
  background: "transparent",
  color: C.accent,
  fontWeight: 700,
  fontSize: "0.76rem",
  padding: "0.45rem 0.8rem",
  textDecoration: "none",
};

function bubbleStyle(role: ChatMessage["role"]): CSSProperties {
  return {
    maxWidth: "min(760px, 90%)",
    minWidth: 0,
    width: "fit-content",
    padding: "0.9rem 1rem",
    borderRadius: 16,
    border: `1px solid ${C.border}`,
    overflow: "hidden",
    overflowWrap: "anywhere",
    wordBreak: "break-word",
    background:
      role === "user" ? C.userBubble :
      role === "assistant" ? C.assistantBubble :
      role === "tool" ? C.toolBubble :
      C.errorBubble,
  };
}

function ChatMarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const trimmed = src?.trim();
  const [failed, setFailed] = useState(false);

  if (!trimmed) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return (
      <span
        style={{
          display: "block",
          margin: "0.6rem 0",
          padding: "0.65rem 0.8rem",
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          color: C.muted,
          background: "#071321",
          fontSize: "0.8rem",
        }}
      >
        External image{alt ? `: ${alt}` : ""}.{" "}
        <a href={trimmed} target="_blank" rel="noopener noreferrer" style={{ color: C.accent, textDecoration: "underline" }}>
          Open image
        </a>
      </span>
    );
  }

  if (failed) {
    return (
      <span
        style={{
          display: "block",
          margin: "0.6rem 0",
          padding: "0.65rem 0.8rem",
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          color: C.muted,
          background: "#071321",
          fontSize: "0.8rem",
        }}
      >
        Image unavailable{alt ? `: ${alt}` : "."}
      </span>
    );
  }

  return (
    <img
      src={trimmed}
      alt={alt ?? ""}
      onError={() => setFailed(true)}
      style={{ display: "block", maxWidth: "100%", height: "auto", borderRadius: 10, margin: "0.6rem 0" }}
    />
  );
}

function MessageBody({ role, text }: { role: ChatMessage["role"]; text: string }) {
  if (role === "user" || role === "error") {
    return <div style={{ fontSize: "0.86rem", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{text}</div>;
  }

  return (
    <div style={{ fontSize: "0.86rem", lineHeight: 1.6, minWidth: 0, maxWidth: "100%", overflowX: "hidden" }} className="chat-codex-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: C.accent, textDecoration: "underline" }}>
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code style={{ background: "#071321", border: `1px solid ${C.border}`, borderRadius: 6, padding: "0.12rem 0.35rem", fontSize: "0.82em", overflowWrap: "anywhere", wordBreak: "break-word" }}>
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre style={{ margin: "0.75rem 0", padding: "0.8rem 0.9rem", maxWidth: "100%", overflowX: "auto", background: "#071321", border: `1px solid ${C.border}`, borderRadius: 10, boxSizing: "border-box" }}>
              {children}
            </pre>
          ),
          img: ({ src, alt }) => <ChatMarkdownImage src={src} alt={alt} />,
          ul: ({ children }) => <ul style={{ margin: "0.5rem 0", paddingLeft: "1.2rem" }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: "0.5rem 0", paddingLeft: "1.2rem" }}>{children}</ol>,
          p: ({ children }) => <p style={{ margin: "0.45rem 0", overflowWrap: "anywhere", wordBreak: "break-word" }}>{children}</p>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
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

function stopButtonStyle(stopping: boolean): CSSProperties {
  return {
    alignSelf: "stretch",
    minWidth: 110,
    border: "none",
    borderRadius: 14,
    background: stopping ? "#4b5563" : "#7f1d1d",
    color: "#fee2e2",
    fontWeight: 700,
    fontSize: "0.84rem",
    padding: "0.8rem 1rem",
    cursor: "pointer",
  };
}
