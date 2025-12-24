// src/remote/urlConfig.ts
import type { RemoteAppConfig } from "./remoteTypes";

export function getRemoteAppConfigFromUrl(): RemoteAppConfig | null {
  const params = new URLSearchParams(window.location.search);

  const bucket = params.get("bucket");
  const key = params.get("key");
  const exportName = params.get("export") ?? "default";

  if (!bucket || !key) {
    return null;
  }

  // Optional: basic sanity check, purely to avoid obvious junk.
  // Real security comes from IAM/S3, not here.
  if (bucket.includes("..") || key.startsWith("s3://")) {
    return null;
  }

  return { bucket, key, exportName };
}
