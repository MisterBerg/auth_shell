import React, { useState } from "react";
import { useEditMode, useAuthContext, ModulePicker } from "module-core";
import type { ModuleRegistryEntry, ModuleConfig } from "module-core";
import { PutObjectCommand } from "@aws-sdk/client-s3";

type EditModeBarProps = {
  /** The resolved config of the current root module. Needed for root replacement. */
  rootConfig: ModuleConfig | null;
};

/**
 * Floating shell-level edit mode controls. Rendered on top of every loaded
 * module (not on the sign-in screen). Only appears when a real module is
 * loaded from S3 (i.e. URL has ?bucket=&config= params).
 *
 * - "Edit" button enters edit mode
 * - In edit mode: "Done" exits, "Replace module" swaps the entire root module
 *
 * All modules in the tree read editMode from EditModeContext — this is the
 * single place that writes it.
 */
export function EditModeBar({ rootConfig }: EditModeBarProps) {
  const { editMode, setEditMode } = useEditMode();
  const { getS3Client } = useAuthContext();
  const [showReplacePicker, setShowReplacePicker] = useState(false);
  const [replaceError, setReplaceError] = useState<string | undefined>();
  const [replacing, setReplacing] = useState(false);

  const handleReplaceRoot = async (entry: ModuleRegistryEntry) => {
    if (!rootConfig) return;
    setShowReplacePicker(false);
    setReplaceError(undefined);
    setReplacing(true);

    const params = new URLSearchParams(window.location.search);
    const configBucket = params.get("bucket");
    const configPath = params.get("config");

    if (!configBucket || !configPath) {
      setReplaceError("Missing URL config params");
      setReplacing(false);
      return;
    }

    const newConfig: ModuleConfig = {
      ...rootConfig,
      app: { bucket: entry.bundleBucket, key: entry.bundlePath },
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
      setReplaceError(`Failed to save: ${(err as Error).message}`);
      setReplacing(false);
      return;
    }

    setEditMode(false);
    window.dispatchEvent(new Event("shell:navigate"));
  };

  return (
    <>
      {/* Floating bar — bottom right, above everything */}
      <div
        style={{
          position: "fixed",
          bottom: 20,
          right: 20,
          zIndex: 1000,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: "0.5rem",
          pointerEvents: "none", // let clicks pass through the gap between buttons
        }}
      >
        {replaceError && (
          <div style={{
            pointerEvents: "auto",
            background: "#1a0a0a",
            border: "1px solid #7f1d1d",
            borderRadius: 6,
            padding: "0.4rem 0.75rem",
            fontSize: "0.75rem",
            color: "#fca5a5",
            maxWidth: 260,
            textAlign: "right",
          }}>
            {replaceError}
          </div>
        )}

        <div style={{ display: "flex", gap: "0.5rem", pointerEvents: "auto" }}>
          {editMode && (
            <button
              onClick={() => { setShowReplacePicker(true); setReplaceError(undefined); }}
              disabled={replacing}
              style={secondaryBtnStyle}
              title="Replace the root module of this project"
            >
              Replace module
            </button>
          )}

          <button
            onClick={() => {
              setEditMode(!editMode);
              setReplaceError(undefined);
            }}
            style={editMode ? doneButtonStyle : editButtonStyle}
          >
            {editMode ? "Done" : "Edit"}
          </button>
        </div>
      </div>

      {/* Edit mode indicator — thin top border so you always know the mode */}
      {editMode && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: "#3b82f6",
          zIndex: 999,
          pointerEvents: "none",
        }} />
      )}

      {showReplacePicker && (
        <ModulePicker
          onSelect={handleReplaceRoot}
          onCancel={() => setShowReplacePicker(false)}
          headerOverride={{
            title: "Replace root module",
            subtitle: "The current layout and all its slots will be replaced",
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Button styles
// ---------------------------------------------------------------------------

const baseBtn: React.CSSProperties = {
  padding: "0.5rem 1rem",
  borderRadius: 8,
  border: "none",
  fontSize: "0.875rem",
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "system-ui, -apple-system, sans-serif",
  boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
};

const editButtonStyle: React.CSSProperties = {
  ...baseBtn,
  background: "rgba(15, 25, 41, 0.85)",
  color: "#9ca3af",
  border: "1px solid #1e2d40",
  backdropFilter: "blur(4px)",
};

const doneButtonStyle: React.CSSProperties = {
  ...baseBtn,
  background: "#2563eb",
  color: "#fff",
};

const secondaryBtnStyle: React.CSSProperties = {
  ...baseBtn,
  background: "rgba(15, 25, 41, 0.85)",
  color: "#93c5fd",
  border: "1px solid #1e3a5f",
  backdropFilter: "blur(4px)",
};
