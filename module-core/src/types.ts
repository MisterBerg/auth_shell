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
// Module registry — describes a published module available in the picker.
// Matches the DynamoDB module-registry table's "latest" pointer records.
// ---------------------------------------------------------------------------

export type ModuleCategory = "layout" | "app" | "component";

export type ModuleRegistryEntry = {
  moduleName: string;
  displayName?: string;
  description?: string;
  category?: ModuleCategory;
  bundleBucket: string;
  bundlePath: string;
  ownerId?: string;
  latestVersion?: string;
  updatedAt?: string;
};

// ---------------------------------------------------------------------------
// Auth types — defined here so module-core hooks can reference them without
// depending on auth-shell's Zustand store.
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
