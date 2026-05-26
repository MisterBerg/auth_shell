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
            reject(new Error("Module did not assign to window.RemoteModule"));
            return;
          }
          // `var RemoteModule` in a classic script is non-configurable on window
          // (cannot be deleted). The IIFE queue is serialised so the next load
          // safely overwrites the property.
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
 * Fetches a JS bundle from S3 and executes it as an IIFE, returning the
 * named component export.
 *
 * Used by SlotContainer to load a child slot directly from its inline app
 * config — no separate config.json fetch required.
 */
export async function loadBundle(
  bucket: string,
  key: string,
  getS3Client: (bucket?: string) => Promise<S3Client>,
  exportName: string = "default"
): Promise<React.ComponentType<ModuleProps>> {
  const jsCode = await withLoadContext(
    `bundle ${bucket}/${key}`,
    async () => {
      const localText = await readLocalObjectText(bucket, key);
      if (localText !== null) return localText;
      const s3 = await getS3Client(bucket);
      const resp = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseCacheControl: "no-store",
      }));
      return resp.Body!.transformToString("utf-8");
    }
  );
  const rawModule = await loadIife(jsCode);

  const Component = rawModule[exportName] as React.ComponentType<ModuleProps> | undefined;
  if (!Component) {
    throw new Error(
      `Bundle "${key}" does not export "${exportName}". ` +
      `Available exports: ${Object.keys(rawModule).join(", ")}`
    );
  }
  return Component;
}

/**
 * Two-step root module loader:
 * 1. Fetch and parse the config.json from S3
 * 2. Fetch the JS bundle declared in config.app, execute it, extract the component
 *
 * Used by AuthGate to load the root module from a URL-specified config.json.
 * Child slots use loadBundle directly since their config is inline in the parent.
 */
export async function loadModule(
  configBucket: string,
  configPath: string,
  getS3Client: (bucket?: string) => Promise<S3Client>,
  onResourcesLoaded?: (resources: Resource[]) => void
): Promise<LoadedModule> {
  // Step 1: fetch config
  const configResp = await withLoadContext(
    `root config ${configBucket}/${configPath}`,
    async () => {
      const localText = await readLocalObjectText(configBucket, configPath);
      if (localText !== null) return localText;
      const configS3 = await getS3Client(configBucket);
      const resp = await configS3.send(
        new GetObjectCommand({ Bucket: configBucket, Key: configPath, ResponseCacheControl: "no-store" })
      );
      return resp.Body!.transformToString("utf-8");
    }
  );
  const config: ModuleConfig = JSON.parse(configResp) as ModuleConfig;

  // Register resources lazily, before bundle load
  if (config.resources?.length && onResourcesLoaded) {
    onResourcesLoaded(config.resources);
  }

  // Step 2: fetch and run bundle
  const bundleResp = await withLoadContext(
    `root bundle ${config.id} ${config.app.bucket}/${config.app.key}`,
    async () => {
      const localText = await readLocalObjectText(config.app.bucket, config.app.key);
      if (localText !== null) return localText;
      const s3 = await getS3Client(config.app.bucket);
      const resp = await s3.send(
        new GetObjectCommand({
          Bucket: config.app.bucket,
          Key: config.app.key,
          ResponseCacheControl: "no-store",
        })
      );
      return resp.Body!.transformToString("utf-8");
    }
  );
  const rawModule = await loadIife(bundleResp);

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

async function withLoadContext<T>(context: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "Error";
    throw new Error(`Failed to load ${context}: ${name}: ${message}`);
  }
}

async function readLocalObjectText(bucket: string, key: string): Promise<string | null> {
  const local = (window as unknown as {
    __JeffspaceLocalS3?: { endpoint?: string; buckets?: string[] };
  }).__JeffspaceLocalS3;
  const endpoint = local?.endpoint?.replace(/\/$/, "");
  if (!endpoint || !local?.buckets?.includes(bucket)) return null;

  const url = `${endpoint}/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(`${url}?_=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unsigned local S3 GET failed for ${bucket}/${key}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}
