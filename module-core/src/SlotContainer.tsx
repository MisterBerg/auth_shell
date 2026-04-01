import React, { useMemo } from "react";
import type { ChildSlot } from "./types.ts";
import { useAuthContext, useEditMode, useRegisterResources } from "./hooks.ts";
import { loadModule } from "./loadModule.ts";

type SlotContainerProps = {
  slot: ChildSlot;
  /** Bucket of the parent module — used when slot.configBucket is not specified. */
  parentBucket: string;
  fallback?: React.ReactNode;
};

/**
 * SlotContainer is the recursive building block of the module tree.
 *
 * Every module that has child slots renders a <SlotContainer> for each one.
 * SlotContainer loads the child's config from S3, registers its resources,
 * loads its bundle, and renders it. In edit mode it wraps the child in an
 * overlay that will eventually open the module picker dialog.
 *
 * All modules use this component — the uniformity of SlotContainer is what
 * makes the recursive loading protocol self-similar at every level.
 */
export function SlotContainer({ slot, parentBucket, fallback }: SlotContainerProps) {
  const { getS3Client } = useAuthContext();
  const registerResources = useRegisterResources();
  const { editMode } = useEditMode();

  const bucket = slot.configBucket ?? parentBucket;

  const LazyModule = useMemo(() => {
    return React.lazy(async () => {
      const { config, Component } = await loadModule(
        bucket,
        slot.configPath,
        getS3Client,
        registerResources
      );
      // Wrap so we can bind the resolved config without the parent needing to know it.
      const Bound = () => <Component config={config} />;
      Bound.displayName = `SlotModule[${slot.slotName}]`;
      return { default: Bound };
    });
    // Intentionally only re-run when the slot address changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket, slot.configPath]);

  const content = (
    <React.Suspense fallback={fallback ?? <SlotFallback slotName={slot.slotName} />}>
      <LazyModule />
    </React.Suspense>
  );

  if (editMode) {
    return <EditableSlot slotName={slot.slotName}>{content}</EditableSlot>;
  }

  return content;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function SlotFallback({ slotName }: { slotName: string }) {
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
      Loading {slotName}…
    </div>
  );
}

function EditableSlot({
  slotName,
  children,
}: {
  slotName: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ position: "relative", outline: "1px dashed #3b82f6" }}>
      {children}
      {/* Edit overlay — clicking this will open the module picker dialog. */}
      <button
        onClick={() => {
          // TODO: open module picker dialog for this slot
          console.info(`[edit] slot "${slotName}" clicked`);
        }}
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
        title={`Configure slot: ${slotName}`}
      >
        ✎ {slotName}
      </button>
    </div>
  );
}
