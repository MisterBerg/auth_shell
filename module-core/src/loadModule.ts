import type React from "react";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { ModuleConfig, ModuleProps, Resource } from "./types.ts";

// Serialises IIFE loads so concurrent requests don't race on window.RemoteModule.
let iifeQueue: Promise<unknown> = Promise.resolve();

function loadIife(jsCode: string): Promise<Record<string, unknown>> {
  const next = iifeQueue.then(
    () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const blob = new Blob([jsCode], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);
        const script = document.createElement("script");
        script.src = url;
        script.onload = () => {
          URL.revokeObjectURL(url);
          script.remove();
          // Vite IIFE lib builds assign to window[name] where name = lib.name ("RemoteModule")
          const exports = (window as unknown as Record<string, unknown>)["RemoteModule"] as
            | Record<string, unknown>
            | undefined;
          if (!exports) {
            reject(new Error('Module did not assign to window.RemoteModule'));
            return;
          }
          // Clear immediately so the next load starts clean
          delete (window as unknown as Record<string, unknown>)["RemoteModule"];
          resolve(exports);
        };
        script.onerror = () => {
          URL.revokeObjectURL(url);
          script.remove();
          reject(new Error("Script load error — check the browser console for details"));
        };
        document.head.appendChild(script);
      })
  );
  // Keep the queue moving even if this load fails
  iifeQueue = next.catch(() => {});
  return next;
}

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
  getS3Client: (bucket?: string) => Promise<S3Client>,
  onResourcesLoaded?: (resources: Resource[]) => void
): Promise<LoadedModule> {
  // Step 1: fetch config — route to correct endpoint for this bucket
  const configS3 = await getS3Client(configBucket);
  const configResp = await configS3.send(
    new GetObjectCommand({ Bucket: configBucket, Key: configPath })
  );
  const configJson = await configResp.Body!.transformToString("utf-8");
  const config: ModuleConfig = JSON.parse(configJson) as ModuleConfig;

  // Register resources lazily, before bundle load
  if (config.resources?.length && onResourcesLoaded) {
    onResourcesLoaded(config.resources);
  }

  // Step 2: fetch bundle — route to correct endpoint for the bundle's bucket
  const bundleS3 = await getS3Client(config.app.bucket);
  const bundleResp = await bundleS3.send(
    new GetObjectCommand({ Bucket: config.app.bucket, Key: config.app.key })
  );
  const jsCode = await bundleResp.Body!.transformToString("utf-8");
  const rawModule = await loadIife(jsCode);

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
