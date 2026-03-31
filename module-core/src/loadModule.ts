import type React from "react";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { ModuleConfig, ModuleProps, Resource } from "./types.ts";

export type LoadedModule = {
  config: ModuleConfig;
  Component: React.ComponentType<ModuleProps>;
  onExport?: (ctx: import("./types.ts").ExportContext) => Promise<void>;
};

/**
 * Two-step module loader:
 * 1. Fetch and parse the config.json from S3
 * 2. Fetch the JS bundle declared in config.app, dynamic-import it as a blob URL,
 *    extract the component export, and return everything together.
 *
 * Resource registration is lazy — called here as soon as the config is parsed,
 * before the bundle is fetched, so resources are available to the registry
 * as early as possible.
 */
export async function loadModule(
  configBucket: string,
  configPath: string,
  s3: S3Client,
  onResourcesLoaded?: (resources: Resource[]) => void
): Promise<LoadedModule> {
  // Step 1: fetch config
  const configResp = await s3.send(
    new GetObjectCommand({ Bucket: configBucket, Key: configPath })
  );
  const configJson = await configResp.Body!.transformToString("utf-8");
  const config: ModuleConfig = JSON.parse(configJson) as ModuleConfig;

  // Register resources lazily, before bundle load
  if (config.resources?.length && onResourcesLoaded) {
    onResourcesLoaded(config.resources);
  }

  // Step 2: fetch bundle
  const bundleResp = await s3.send(
    new GetObjectCommand({ Bucket: config.app.bucket, Key: config.app.key })
  );
  const jsCode = await bundleResp.Body!.transformToString("utf-8");
  const blob = new Blob([jsCode], { type: "text/javascript" });
  const blobUrl = URL.createObjectURL(blob);

  let rawModule: Record<string, unknown>;
  try {
    rawModule = await import(/* webpackIgnore: true */ blobUrl) as Record<string, unknown>;
  } finally {
    // Revoke after import resolves. The browser retains the parsed module
    // internally; revoking the URL doesn't unload it.
    URL.revokeObjectURL(blobUrl);
  }

  const exportName = config.app.exportName ?? "default";
  const Component = rawModule[exportName] as React.ComponentType<ModuleProps> | undefined;

  if (!Component) {
    throw new Error(
      `Module "${config.id}" does not export "${exportName}". ` +
      `Available exports: ${Object.keys(rawModule).join(", ")}`
    );
  }

  const onExport = rawModule["onExport"] as LoadedModule["onExport"] | undefined;

  return { config, Component, onExport };
}
