import React, { useEffect, useState, useCallback } from "react";
import type { ModuleProps, ModuleRegistryEntry } from "module-core";
import { useEditMode, useAwsS3Client, ModulePicker } from "module-core";
import { PutObjectCommand } from "@aws-sdk/client-s3";

/**
 * app-empty — the blank-project starting point.
 *
 * Loaded when a new project is created (its config.json points here).
 * Automatically activates edit mode and shows a full-screen + button.
 * When the user picks a module from the registry, this module rewrites
 * the project's root config.json to point at the chosen module,
 * then fires shell:navigate so the shell reloads without a full page refresh.
 */
export default function AppEmpty({ config }: ModuleProps) {
  const { setEditMode } = useEditMode();
  const getS3Client = useAwsS3Client();
  const [showPicker, setShowPicker] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Auto-enter edit mode as soon as this module mounts
  useEffect(() => {
    setEditMode(true);
  }, [setEditMode]);

  const handleSelect = useCallback(async (entry: ModuleRegistryEntry) => {
    setError(undefined);

    // Determine where to write the new config — read from the live URL
    const params = new URLSearchParams(window.location.search);
    const configBucket = params.get("bucket");
    const configPath = params.get("config");

    if (!configBucket || !configPath) {
      setError("Cannot determine config location from URL. Missing ?bucket= or ?config= params.");
      return;
    }

    const newConfig = {
      id: config.id,
      app: {
        bucket: entry.bundleBucket,
        key: entry.bundlePath,
      },
      meta: {},
      resources: [],
      children: [],
    };

    try {
      const s3 = await getS3Client(configBucket);
      await s3.send(new PutObjectCommand({
        Bucket: configBucket,
        Key: configPath,
        Body: JSON.stringify(newConfig, null, 2),
        ContentType: "application/json",
      }));
    } catch (err: unknown) {
      setError(`Failed to save config: ${(err as Error).message}`);
      return;
    }

    // Tell the shell to re-read the URL and load the new module in place
    window.dispatchEvent(new Event("shell:navigate"));
  }, [config.id, getS3Client]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        background: "#080f1c",
        color: "#e5e7eb",
        fontFamily: "system-ui, -apple-system, sans-serif",
        gap: "1.5rem",
      }}
    >
      <p style={{ margin: 0, fontSize: "0.9rem", color: "#4b5563", letterSpacing: "0.03em" }}>
        New project — choose a module to get started
      </p>

      <button
        onClick={() => setShowPicker(true)}
        style={{
          width: 80,
          height: 80,
          borderRadius: "50%",
          border: "2px dashed #1e3a5f",
          background: "transparent",
          color: "#3b82f6",
          fontSize: "2.5rem",
          lineHeight: 1,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "border-color 0.15s, background 0.15s",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.borderColor = "#3b82f6";
          (e.currentTarget as HTMLButtonElement).style.background = "#0f1f35";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.borderColor = "#1e3a5f";
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
        }}
        title="Add a module"
        aria-label="Add a module"
      >
        +
      </button>

      {error && (
        <p style={{ margin: 0, fontSize: "0.825rem", color: "#fca5a5", maxWidth: "28rem", textAlign: "center" }}>
          {error}
        </p>
      )}

      {showPicker && (
        <ModulePicker
          onSelect={async (entry) => {
            setShowPicker(false);
            await handleSelect(entry);
          }}
          onCancel={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
