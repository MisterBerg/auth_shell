// src/remote/loadRemoteAppFromS3.ts
import React from "react";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getAwsClients } from "../aws/awsClients";
import type { RemoteAppConfig } from "./remoteTypes";

export function createRemoteReactAppLoader(config: RemoteAppConfig) {
  return async () => {
    const { getS3Client } = getAwsClients();
    const s3 = await getS3Client();

    const resp = await s3.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: config.key,
      })
    );

    const jsCode = await resp.Body!.transformToString("utf-8");

    const blob = new Blob([jsCode], { type: "text/javascript" });
    const blobUrl = URL.createObjectURL(blob);

    try {
      const module: any = await import(
        /* webpackIgnore: true */ blobUrl
      );

      const exportName = config.exportName ?? "default";
      const AppComponent = module[exportName];

      if (!AppComponent) {
        throw new Error(
          `Remote module does not export "${exportName}". Available keys: ${Object.keys(
            module
          ).join(", ")}`
        );
      }

      return { default: AppComponent as React.ComponentType<any> };
    } finally {
      // You *may* revoke later if you want, but only after you're done using it.
      // URL.revokeObjectURL(blobUrl);
    }
  };
}
