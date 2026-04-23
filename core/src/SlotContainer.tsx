import React, { useMemo, useState, useCallback, useRef, useContext } from "react";
import type { ChildSlot, ModuleConfig } from "./types.ts";
import { useAuthContext, useEditMode, useLinkAuthoring, useLinkAuthoringStep, useParentUiTargetId, useRegisterResources, useRegisterUiTarget } from "./hooks.ts";
import { loadBundle } from "./loadModule.ts";
import { ModulePicker } from "./ModulePicker.tsx";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import type { ModuleRegistryEntry } from "./types.ts";
import { SlotContext } from "./SlotContext.tsx";

type SlotContainerProps = {
  slot: ChildSlot;
  parentConfig: ModuleConfig;
  targetParentId?: string;
  onSlotUpdated?: (updatedSlot: ChildSlot) => void;
  onSlotRemoved?: () => void;
  fallback?: React.ReactNode;
};

export function SlotContainer({ slot, parentConfig, targetParentId, onSlotUpdated, onSlotRemoved, fallback }: SlotContainerProps) {
  const { getS3Client } = useAuthContext();
  const registerResources = useRegisterResources();
  const { editMode } = useEditMode();
  const { completeLink } = useLinkAuthoring();
  const linkStep = useLinkAuthoringStep();
  const parentSlotCtx = useContext(SlotContext); // non-null when this SlotContainer is itself nested
  const parentTargetId = useParentUiTargetId();
  const effectiveParentTargetId = targetParentId ?? parentTargetId;
  const [showPicker, setShowPicker] = useState(false);
  const [swapError, setSwapError] = useState<string | undefined>();

  const slotTargetId = `${effectiveParentTargetId ?? `module:${parentConfig.id}`}:slot:${slot.slotId}`;

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

  // Writes the updated parent config to S3, or propagates up through
  // parentSlotCtx if this SlotContainer is itself nested inside another one.
  const persistParentConfig = useCallback(async (
    updatedSlot: ChildSlot,
    updatedParentChildren: ChildSlot[],
  ) => {
    if (parentSlotCtx) {
      // Nested — propagate up: ask the grandparent to update its children
      // so the change bubbles all the way to the root S3 write.
      await parentSlotCtx.updateSlotChildren(updatedParentChildren);
    } else {
      // Root — write directly to the URL-specified config.json
      const params = new URLSearchParams(window.location.search);
      const configBucket = params.get("bucket");
      const configPath   = params.get("config");
      if (!configBucket || !configPath) throw new Error("Missing ?bucket= or ?config= URL params");
      const currentParent = parentConfigRef.current;
      const updatedConfig: ModuleConfig = { ...currentParent, children: updatedParentChildren };
      const s3 = await getS3Client(configBucket);
      await s3.send(new PutObjectCommand({
        Bucket: configBucket,
        Key: configPath,
        Body: JSON.stringify(updatedConfig, null, 2),
        ContentType: "application/json",
        CacheControl: "no-store",
      }));
    }
    onSlotUpdatedRef.current?.(updatedSlot);
  }, [getS3Client, parentSlotCtx]);

  const updateSlotMeta = useCallback(async (newMeta: Record<string, unknown>) => {
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
      : [...existingChildren, updatedSlot];
    await persistParentConfig(updatedSlot, updatedChildren);
  }, [persistParentConfig]);

  const updateSlotChildren = useCallback(async (newChildren: ChildSlot[]) => {
    const currentSlot   = slotRef.current;
    const currentParent = parentConfigRef.current;
    const updatedSlot: ChildSlot = { ...currentSlot, children: newChildren };
    const existingChildren = currentParent.children ?? [];
    const found = existingChildren.some((c) => c.slotId === currentSlot.slotId);
    const updatedChildren = found
      ? existingChildren.map((c) => c.slotId === currentSlot.slotId ? updatedSlot : c)
      : [...existingChildren, updatedSlot];
    await persistParentConfig(updatedSlot, updatedChildren);
  }, [persistParentConfig]);

  const handleSwap = async (entry: ModuleRegistryEntry) => {
    setShowPicker(false);
    setSwapError(undefined);

    const currentSlot   = slotRef.current;
    const currentParent = parentConfigRef.current;
    const updatedSlot: ChildSlot = {
      ...currentSlot,
      app: { bucket: entry.bundleBucket, key: entry.bundlePath },
    };

    const existingChildren = currentParent.children ?? [];
    const updatedChildren = existingChildren.map((c) =>
      c.slotId === currentSlot.slotId ? updatedSlot : c
    );

    try {
      await persistParentConfig(updatedSlot, updatedChildren);
    } catch (err: unknown) {
      setSwapError(`Failed to save: ${(err as Error).message}`);
      return;
    }

    // Bundle key changed — shell:navigate reloads the new bundle
    window.dispatchEvent(new Event("shell:navigate"));
  };

  const content = (
    <React.Suspense fallback={fallback ?? <SlotFallback slotId={slot.slotId} />}>
      <LazyModule />
    </React.Suspense>
  );

  const slotContextValue = { slotId: slot.slotId, updateSlotMeta, updateSlotChildren };
  useRegisterUiTarget({
    id: slotTargetId,
    kind: "module",
    parentId: effectiveParentTargetId,
    label: slot.slotId,
  });

  if (editMode) {
    const isSelectingTarget = linkStep === "select-target";
    const isBusy = linkStep === "saving";
    return (
      <SlotContext value={{ ...slotContextValue, targetId: slotTargetId }}>
        <div
          onClickCapture={(event) => {
            if (!isSelectingTarget) return;
            event.preventDefault();
            event.stopPropagation();
            void completeLink(slotTargetId);
          }}
          style={{
            position: "relative",
            outline: isSelectingTarget ? "2px solid #facc15" : "1px dashed #3b82f6",
            boxShadow: isSelectingTarget ? "inset 0 0 0 1px rgba(250, 204, 21, 0.4)" : undefined,
            cursor: isSelectingTarget ? "copy" : undefined,
            height: "100%",
          }}
          title={isSelectingTarget ? `Click to link to ${slot.slotId}` : undefined}
        >
          {content}
          <div style={{ position: "absolute", top: 4, right: 4, display: "flex", gap: 4, zIndex: 10 }}>
            <button
              onClick={() => {
                if (isSelectingTarget) {
                  void completeLink(slotTargetId);
                  return;
                }
                if (!isBusy) {
                  setShowPicker(true);
                }
              }}
              style={{
                padding: "2px 8px",
                fontSize: "0.75rem",
                background: isSelectingTarget ? "#f59e0b" : "#3b82f6",
                color: isSelectingTarget ? "#111827" : "#fff",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                opacity: 0.85,
              }}
              title={isSelectingTarget ? `Link to ${slot.slotId}` : `Replace slot: ${slot.slotId}`}
            >
              {isSelectingTarget ? `Link ${slot.slotId}` : `✎ ${slot.slotId}`}
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
    <SlotContext value={{ ...slotContextValue, targetId: slotTargetId }}>
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
