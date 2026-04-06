import React, { useMemo, useState, useCallback, useRef } from "react";
import type { ChildSlot, ModuleConfig } from "./types.ts";
import { useAuthContext, useEditMode, useRegisterResources } from "./hooks.ts";
import { loadBundle } from "./loadModule.ts";
import { ModulePicker } from "./ModulePicker.tsx";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import type { ModuleRegistryEntry } from "./types.ts";
import { SlotContext } from "./SlotContext.tsx";

type SlotContainerProps = {
  slot: ChildSlot;
  parentConfig: ModuleConfig;
  onSlotUpdated?: (updatedSlot: ChildSlot) => void;
  onSlotRemoved?: () => void;
  fallback?: React.ReactNode;
};

export function SlotContainer({ slot, parentConfig, onSlotUpdated, onSlotRemoved, fallback }: SlotContainerProps) {
  const { getS3Client } = useAuthContext();
  const registerResources = useRegisterResources();
  const { editMode } = useEditMode();
  const [showPicker, setShowPicker] = useState(false);
  const [swapError, setSwapError] = useState<string | undefined>();

  const slotConfig: ModuleConfig = {
    id: slot.slotId,
    app: slot.app,
    meta: slot.meta,
    resources: slot.resources,
    children: slot.children,
  };

  // Refs so callbacks always read the latest props without needing to be
  // recreated. This prevents stale-closure writes when the parent hasn't
  // re-rendered yet (e.g. immediately after a new slot is added).
  const slotConfigRef      = useRef(slotConfig);
  const slotRef            = useRef(slot);
  const parentConfigRef    = useRef(parentConfig);
  const onSlotUpdatedRef   = useRef(onSlotUpdated);
  const onSlotRemovedRef   = useRef(onSlotRemoved);
  slotConfigRef.current    = slotConfig;
  slotRef.current          = slot;
  parentConfigRef.current  = parentConfig;
  onSlotUpdatedRef.current = onSlotUpdated;
  onSlotRemovedRef.current = onSlotRemoved;

  const LazyModule = useMemo(() => {
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
      const Bound = () => <Component config={slotConfigRef.current} />;
      Bound.displayName = `SlotModule[${slot.slotId}]`;
      return { default: Bound };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot.app.bucket, slot.app.key, slot.app.exportName]);

  // Writes updated slot meta to S3 and notifies the parent.
  // Uses refs so it always reads the latest slot/parentConfig even if the
  // parent hasn't re-rendered since the slot was first added.
  const updateSlotMeta = useCallback(async (newMeta: Record<string, unknown>) => {
    const params = new URLSearchParams(window.location.search);
    const configBucket = params.get("bucket");
    const configPath = params.get("config");
    if (!configBucket || !configPath) {
      throw new Error("Missing ?bucket= or ?config= URL params");
    }
    const currentSlot   = slotRef.current;
    const currentParent = parentConfigRef.current;
    const updatedSlot: ChildSlot = {
      ...currentSlot,
      meta: { ...(currentSlot.meta ?? {}), ...newMeta },
    };
    const existingChildren = currentParent.children ?? [];
    const found = existingChildren.some((c) => c.slotId === currentSlot.slotId);
    const updatedChildren = found
      ? existingChildren.map((c) => c.slotId === currentSlot.slotId ? updatedSlot : c)
      : [...existingChildren, updatedSlot]; // slot not yet in parent — append it
    const updatedConfig: ModuleConfig = { ...currentParent, children: updatedChildren };
    const s3 = await getS3Client(configBucket);
    await s3.send(new PutObjectCommand({
      Bucket: configBucket,
      Key: configPath,
      Body: JSON.stringify(updatedConfig, null, 2),
      ContentType: "application/json",
    }));
    onSlotUpdatedRef.current?.(updatedSlot);
  }, [getS3Client]); // stable — refs supply the live values

  const handleSwap = async (entry: ModuleRegistryEntry) => {
    setShowPicker(false);
    setSwapError(undefined);

    const currentSlot   = slotRef.current;
    const currentParent = parentConfigRef.current;
    const updatedSlot: ChildSlot = {
      ...currentSlot,
      app: { bucket: entry.bundleBucket, key: entry.bundlePath },
    };

    const params = new URLSearchParams(window.location.search);
    const configBucket = params.get("bucket");
    const configPath = params.get("config");
    if (!configBucket || !configPath) {
      setSwapError("Cannot write config: missing URL params");
      return;
    }

    const existingChildren = currentParent.children ?? [];
    const updatedChildren = existingChildren.map((c) =>
      c.slotId === currentSlot.slotId ? updatedSlot : c
    );
    const updatedParentConfig: ModuleConfig = { ...currentParent, children: updatedChildren };
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

    onSlotUpdatedRef.current?.(updatedSlot);
    // Bundle key changed — shell:navigate reloads the new bundle
    window.dispatchEvent(new Event("shell:navigate"));
  };

  const content = (
    <React.Suspense fallback={fallback ?? <SlotFallback slotId={slot.slotId} />}>
      <LazyModule />
    </React.Suspense>
  );

  const slotContextValue = { slotId: slot.slotId, updateSlotMeta };

  if (editMode) {
    return (
      <SlotContext value={slotContextValue}>
        <div style={{ position: "relative", outline: "1px dashed #3b82f6", height: "100%" }}>
          {content}
          <div style={{ position: "absolute", top: 4, right: 4, display: "flex", gap: 4, zIndex: 10 }}>
            <button
              onClick={() => setShowPicker(true)}
              style={{
                padding: "2px 8px",
                fontSize: "0.75rem",
                background: "#3b82f6",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                opacity: 0.85,
              }}
              title={`Replace slot: ${slot.slotId}`}
            >
              ✎ {slot.slotId}
            </button>
            {onSlotRemoved && (
              <button
                onClick={onSlotRemoved}
                style={{
                  padding: "2px 7px",
                  fontSize: "0.75rem",
                  background: "#7f1d1d",
                  color: "#fca5a5",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  opacity: 0.9,
                }}
                title="Remove module — returns slot to empty"
              >
                ✕
              </button>
            )}
          </div>
          {swapError && (
            <div style={{ position: "absolute", bottom: 4, left: 4, right: 4, fontSize: "0.75rem", color: "#fca5a5", background: "#0b1120", padding: "2px 6px", borderRadius: 4 }}>
              {swapError}
            </div>
          )}
          {showPicker && (
            <ModulePicker onSelect={handleSwap} onCancel={() => setShowPicker(false)} />
          )}
        </div>
      </SlotContext>
    );
  }

  return (
    <SlotContext value={slotContextValue}>
      {content}
    </SlotContext>
  );
}

function SlotFallback({ slotId }: { slotId: string }) {
  return (
    <div style={{ padding: "1rem", display: "flex", alignItems: "center", justifyContent: "center", color: "#6b7280", fontSize: "0.85rem" }}>
      Loading {slotId}…
    </div>
  );
}
