import type React from "react";
import type { S3Client } from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// Core schema types — the central contract between the shell and every module.
// Every config.json stored in S3 must conform to ModuleConfig.
// ---------------------------------------------------------------------------

export type Resource = {
  id: string;           // unique within the project; convention: "{moduleId}/{name}"
  label: string;        // shown in the resource picker dialog
  type: "s3-object" | "s3-prefix" | "dynamodb" | "api" | "other";
  bucket?: string;      // S3 bucket (s3-object, s3-prefix)
  key?: string;         // exact S3 key (s3-object) or prefix (s3-prefix)
  table?: string;       // DynamoDB table name
  region?: string;      // AWS region override (defaults to shell region)
  endpoint?: string;    // API endpoint URL
  mimeType?: string;    // hint for consumers (e.g. "text/csv", "image/png")
  meta?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Project assets — stable project-scoped data objects backed by S3.
// ---------------------------------------------------------------------------

export type AssetVersionRef = {
  versionId: string;
  bucket: string;
  key: string;

  mimeType?: string;
  sizeBytes?: number;
  etag?: string;
  sha256?: string;

  createdAt: string;
  createdBy?: string;
};

export type AssetRecord = {
  projectId: string;
  sk: `asset#${string}`;

  assetId: string;
  label: string;

  /** Current version is always versions[0]. */
  versions: AssetVersionRef[];

  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;

  meta?: Record<string, unknown>;
};

export type ChildSlot = {
  slotId: string;           // logical name for this slot; semantics defined by the parent module
  app: {
    bucket: string;         // S3 bucket containing the bundle
    key: string;            // S3 key for the JS bundle
    exportName?: string;    // named export; defaults to "default"
  };
  meta?: Record<string, unknown>;   // slot-specific config; meaning defined entirely by the parent module
  resources?: Resource[];           // resources declared by this slot
  children?: ChildSlot[];           // recursive; this slot's own child slots
};

export type ModuleConfig = {
  id: string;
  app: {
    bucket: string;
    key: string;
    exportName?: string;  // named export to use; defaults to "default"
  };
  meta?: Record<string, unknown>;   // module-specific static settings (tabs, theme, etc.)
  resources?: Resource[];           // datasets this module declares
  children?: ChildSlot[];           // named child slots
  theme?: {
    cssKey?: string;     // S3 key for a project-level stylesheet
    cssBucket?: string;  // S3 bucket for the stylesheet (defaults to app bucket)
  };
};

// ---------------------------------------------------------------------------
// Module bundle — what a compiled module JS file must export
// ---------------------------------------------------------------------------

export type ModuleProps = {
  config: ModuleConfig;
  // Everything else (credentials, resources, edit mode) comes from React context hooks.
};

export type ExportContext = {
  config: ModuleConfig;
  s3Client: S3Client;
  projectPrefix: string;  // write exported data under: projectPrefix + config.id + "/export/"
};

export type ModuleBundle = {
  default: React.ComponentType<ModuleProps>;
  onExport?: (ctx: ExportContext) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Agent skills — live, mount-time self-description for the built-in agent (see agent-chat).
// A module that wants the agent to operate on it well registers one of these (useRegisterAgentSkills)
// while mounted. Unlike ModuleRegistryEntry below, this is never persisted — it only exists in
// browser memory for as long as the module instance is on the page, keyed by ModuleConfig.id.
//
// Deliberately two-tier: `description` on the skill itself is the only thing shown to the model
// by default (via the agent's list_agent_skills tool) so a chat with many modules mounted doesn't
// balloon the prompt. `prompt` and `tools` only reach the model once it calls use_skill for that
// specific skill — see agent-chat's runAgentSession for how the active tool set grows from there.
// ---------------------------------------------------------------------------

export type AgentSkillToolDefinition = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
};

export type AgentSkill = {
  id: string;              // unique within this module instance, e.g. "generate-report"
  description: string;     // one-liner; the only part shown before the skill is selected
  prompt: string;          // full instructions, revealed once use_skill(instanceId, id) is called
  tools: AgentSkillToolDefinition[];  // tool defs unlocked alongside the prompt
};

export type AgentModuleSkills = {
  instanceId: string;      // ModuleConfig.id of the mounted instance offering these skills
  moduleName: string;      // published module name, e.g. "module-test-manager"
  displayName: string;
  description: string;     // one-liner about the module instance overall
  skills: AgentSkill[];
};

// ---------------------------------------------------------------------------
// Module registry — describes a published module available in the picker.
// Matches the DynamoDB module-registry table's "latest" pointer records.
// ---------------------------------------------------------------------------

export type ModuleCategory = "layout" | "app" | "component";

export type ModulePickerGroup =
  | "Documentation"
  | "Navigation"
  | "Productivity"
  | "Tools"
  | "Other";

export type ModuleRegistryEntry = {
  moduleName: string;
  displayName?: string;
  description?: string;
  category?: ModuleCategory;
  pickerGroup?: ModulePickerGroup;
  pickerHidden?: boolean;
  bundleBucket: string;
  bundlePath: string;
  ownerId?: string;
  latestVersion?: string;
  updatedAt?: string;
};

// ---------------------------------------------------------------------------
// Auth types — defined here so module-core hooks can reference them without
// depending on the shell app's internal state store.
// ---------------------------------------------------------------------------

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
};

export type UserProfile = {
  email?: string;
  name?: string;
  picture?: string;
};
