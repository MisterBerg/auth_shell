import React, { useMemo, useState } from "react";
import type { ChildSlot, ModuleConfig } from "./types.ts";
import { useAuthContext, useEditMode, useRegisterResources } from "./hooks.ts";
import { loadBundle } from "./loadModule.ts";
import { ModulePicker } from "./ModulePicker.tsx";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import type { ModuleRegistryEntry } from "./types.ts";

type SlotContainerProps = {
  slot: ChildSlot;
  /** The parent's ModuleConfig — needed to write back updated children on slot swap. */
  parentConfig: ModuleConfig;
  /** Called after a successful slot swap so the parent can update its in-memory config. */
  onSlotUpdated?: (updatedSlot: ChildSlot) => void;
  fallback?: React.ReactNode;
};

/**
 * SlotContainer is the recursive building block of the module tree.
 *
 * Every module that has child slots renders a <SlotContainer> for each one.
 * The child's full config is inline in the ChildSlot — no separate config.json
 * fetch is needed. SlotContainer loads the bundle directly, registers resources,
 * and renders the component. In edit mode it wraps the child in an overlay that
 * opens the module picker dialog for replacing the slot's module.
 */
export function SlotContainer({ slot, parentConfig, onSlotUpdated, fallback }: SlotContainerProps) {
  const { getS3Client } = useAuthContext();
  const registerResources = useRegisterResources();
  const { editMode } = useEditMode();
  const [showPicker, setShowPicker] = useState(false);
  const [swapError, setSwapError] = useState<string | undefined>();

  // Build a ModuleConfig from the inline ChildSlot so the component receives
  // a properly shaped config object.
  const slotConfig: ModuleConfig = {
    id: slot.slotId,
    app: slot.app,
    meta: slot.meta,
    resources: slot.resources,
    children: slot.children,
  };

  const LazyModule = useMemo(() => {
    // Register this slot's resources before the bundle loads
    if (slot.resources?.length) {
      registerResources(slot.resources);
    }

    return React.lazy(async () => {
      const Component = await loadBundle(
        slot.app.bucket,
        slot.app.key,
        getS3Client,
        slot.app.exportName ?? "default"
      );
      const Bound = () => <Component config={slotConfig} />;
      Bound.displayName = `SlotModule[${slot.slotId}]`;
      return { default: Bound };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot.app.bucket, slot.app.key, slot.app.exportName]);

  const handleSwap = async (entry: ModuleRegistryEntry) => {
    setShowPicker(false);
    setSwapError(undefined);

    const updatedSlot: ChildSlot = {
      ...slot,
      app: { bucket: entry.bundleBucket, key: entry.bundlePath },
    };

    // Write the parent's config.json back to S3 with the updated slot
    const params = new URLSearchParams(window.location.search);
    const configBucket = params.get("bucket");
    const configPath = params.get("config");

    if (!configBucket || !configPath) {
      setSwapError("Cannot write config: missing URL params");
      return;
    }

    const updatedChildren = (parentConfig.children ?? []).map((c) =>
      c.slotId === slot.slotId ? updatedSlot : c
    );
    const updatedParentConfig: ModuleConfig = { ...parentConfig, children: updatedChildren };

    try {
      const s3 = await getS3Client(configBucket);
      await s3.send(new PutObjectCommand({
        Bucket: configBucket,
        Key: configPath,
        Body: JSON.stringify(updatedParentConfig, null, 2),
        ContentType: "application/json",
      }));
    } catch (err: unknown) {
      setSwapError(`Failed to save: ${(err as Error).message}`);
      return;
    }

    onSlotUpdated?.(updatedSlot);
    window.dispatchEvent(new Event("shell:navigate"));
  };

  const content = (
    <React.Suspense fallback={fallback ?? <SlotFallback slotId={slot.slotId} />}>
      <LazyModule />
    </React.Suspense>
  );

  if (editMode) {
    return (
      <div style={{ position: "relative", outline: "1px dashed #3b82f6" }}>
        {content}
        <button
          onClick={() => setShowPicker(true)}
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            padding: "2px 8px",
            fontSize: "0.75rem",
            background: "#3b82f6",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            opacity: 0.85,
            zIndex: 10,
          }}
          title={`Replace slot: ${slot.slotId}`}
        >
          ✎ {slot.slotId}
        </button>
        {swapError && (
          <div style={{ position: "absolute", bottom: 4, left: 4, right: 4, fontSize: "0.75rem", color: "#fca5a5", background: "#0b1120", padding: "2px 6px", borderRadius: 4 }}>
            {swapError}
          </div>
        )}
        {showPicker && (
          <ModulePicker
            onSelect={handleSwap}
            onCancel={() => setShowPicker(false)}
          />
        )}
      </div>
    );
  }

  return content;
}

function SlotFallback({ slotId }: { slotId: string }) {
  return (
    <div
      style={{
        padding: "1rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#6b7280",
        fontSize: "0.85rem",
      }}
    >
      Loading {slotId}…
    </div>
  );
}
