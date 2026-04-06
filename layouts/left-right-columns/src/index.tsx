import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChildSlot, ModuleProps, ModuleRegistryEntry } from "module-core";
import {
  ModulePicker,
  SlotContainer,
  useAwsS3Client,
  useEditMode,
  useUpdateSlotChildren,
  useUpdateSlotMeta,
} from "module-core";
import { PutObjectCommand } from "@aws-sdk/client-s3";

const C = {
  bg: "#080f1c",
  panel: "#0b1525",
  border: "#1a2a42",
  text: "#e5e7eb",
  muted: "#6b7280",
  accent: "#3b82f6",
};

type ColumnPosition = "left" | "right";

function getPosition(slot: ChildSlot): ColumnPosition | undefined {
  return (slot.meta as { position?: ColumnPosition } | undefined)?.position;
}

function clampWidth(value: number): number {
  return Math.max(20, Math.min(80, value));
}

export default function LayoutLeftRightColumns({ config }: ModuleProps) {
  const { editMode } = useEditMode();
  const getS3Client = useAwsS3Client();
  const updateSlotChildren = useUpdateSlotChildren();
  const updateSlotMeta = useUpdateSlotMeta();
  const isRootLayout = !updateSlotChildren;

  const getS3ClientRef = useRef(getS3Client);
  getS3ClientRef.current = getS3Client;

  const [children, setChildren] = useState<ChildSlot[]>(config.children ?? []);
  const [pickerTarget, setPickerTarget] = useState<ColumnPosition | null>(null);
  const [addError, setAddError] = useState<string | undefined>();
  const [isAdding, setIsAdding] = useState(false);
  const [leftWidthPct, setLeftWidthPct] = useState(
    clampWidth(Number((config.meta?.["leftWidthPct"] as number | undefined) ?? 50))
  );

  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setChildren(config.children ?? []);
  }, [config]);

  useEffect(() => {
    setLeftWidthPct(
      clampWidth(Number((config.meta?.["leftWidthPct"] as number | undefined) ?? 50))
    );
  }, [config.meta]);

  const leftSlot = useMemo(
    () => children.find((slot) => getPosition(slot) === "left"),
    [children]
  );
  const rightSlot = useMemo(
    () => children.find((slot) => getPosition(slot) === "right"),
    [children]
  );

  const liveConfig = useMemo(() => ({ ...config, children }), [config, children]);

  const writeWholeConfig = useCallback(
    async (nextChildren: ChildSlot[], nextMeta: Record<string, unknown>) => {
      const params = new URLSearchParams(window.location.search);
      const configBucket = params.get("bucket");
      const configPath = params.get("config");
      if (!configBucket || !configPath) {
        throw new Error("Missing ?bucket= or ?config= URL params");
      }
      const s3 = await getS3ClientRef.current(configBucket);
      await s3.send(
        new PutObjectCommand({
          Bucket: configBucket,
          Key: configPath,
          Body: JSON.stringify({ ...config, meta: nextMeta, children: nextChildren }, null, 2),
          ContentType: "application/json",
          CacheControl: "no-store",
        })
      );
    },
    [config]
  );

  const persistChildren = useCallback(
    async (nextChildren: ChildSlot[]) => {
      if (updateSlotChildren) {
        await updateSlotChildren(nextChildren);
        return;
      }
      await writeWholeConfig(nextChildren, (config.meta ?? {}) as Record<string, unknown>);
    },
    [config.meta, updateSlotChildren, writeWholeConfig]
  );

  const persistWidth = useCallback(
    async (nextWidth: number) => {
      const rounded = Math.round(clampWidth(nextWidth) * 10) / 10;
      const nextMeta = {
        ...((config.meta ?? {}) as Record<string, unknown>),
        leftWidthPct: rounded,
      };

      if (updateSlotMeta) {
        await updateSlotMeta({ leftWidthPct: rounded });
        return;
      }

      await writeWholeConfig(children, nextMeta);
    },
    [children, config.meta, updateSlotMeta, writeWholeConfig]
  );

  const handleSlotUpdated = useCallback((updated: ChildSlot) => {
    setChildren((prev) => prev.map((slot) => (slot.slotId === updated.slotId ? updated : slot)));
  }, []);

  const handleSlotRemoved = useCallback(
    async (position: ColumnPosition) => {
      const nextChildren = children.filter((slot) => getPosition(slot) !== position);
      setChildren(nextChildren);
      try {
        await persistChildren(nextChildren);
      } catch {
        // best effort
      }
    },
    [children, persistChildren]
  );

  const handleModuleSelected = useCallback(
    async (entry: ModuleRegistryEntry) => {
      if (!pickerTarget || isAdding) return;
      setPickerTarget(null);
      setAddError(undefined);
      setIsAdding(true);

      const newSlot: ChildSlot = {
        slotId: `${pickerTarget}-${Date.now().toString(36)}`,
        app: { bucket: entry.bundleBucket, key: entry.bundlePath },
        meta: { position: pickerTarget },
      };

      const nextChildren = [
        ...children.filter((slot) => getPosition(slot) !== pickerTarget),
        newSlot,
      ];

      try {
        await persistChildren(nextChildren);
        setChildren(nextChildren);
      } catch (error: unknown) {
        setAddError(`Failed to save: ${(error as Error).message}`);
      } finally {
        setIsAdding(false);
      }
    },
    [children, isAdding, persistChildren, pickerTarget]
  );

  useEffect(() => {
    if (!editMode) {
      dragStateRef.current = null;
      return;
    }

    const handleMove = (event: PointerEvent) => {
      const drag = dragStateRef.current;
      const shell = shellRef.current;
      if (!drag || !shell) return;
      const deltaPx = event.clientX - drag.startX;
      const totalWidth = shell.clientWidth || 1;
      const deltaPct = (deltaPx / totalWidth) * 100;
      setLeftWidthPct(clampWidth(drag.startWidth + deltaPct));
    };

    const handleUp = () => {
      const drag = dragStateRef.current;
      dragStateRef.current = null;
      if (!drag) return;
      void persistWidth(leftWidthPct).catch(() => {
        // best effort
      });
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [editMode, leftWidthPct, persistWidth]);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!editMode) return;
      dragStateRef.current = { startX: event.clientX, startWidth: leftWidthPct };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [editMode, leftWidthPct]
  );

  return (
    <div
      ref={shellRef}
      style={{
        display: "flex",
        height: isRootLayout ? "100vh" : "100%",
        minHeight: 0,
        background: C.bg,
        color: C.text,
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ width: `${leftWidthPct}%`, minWidth: 0, minHeight: 0, position: "relative" }}>
        {leftSlot ? (
          <SlotContainer
            slot={leftSlot}
            parentConfig={liveConfig}
            onSlotUpdated={handleSlotUpdated}
            onSlotRemoved={() => void handleSlotRemoved("left")}
          />
        ) : (
          <EmptyColumn
            label="left column"
            editMode={editMode}
            busy={isAdding}
            onAdd={() => setPickerTarget("left")}
          />
        )}
      </div>

      <div
        style={{
          width: editMode ? 12 : 1,
          flexShrink: 0,
          display: "flex",
          alignItems: "stretch",
          justifyContent: "center",
          background: editMode ? C.panel : C.border,
          borderLeft: `1px solid ${C.border}`,
          borderRight: `1px solid ${C.border}`,
        }}
      >
        {editMode && (
          <button
            onPointerDown={startResize}
            title="Resize columns"
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              background: "transparent",
              cursor: "col-resize",
              padding: 0,
              position: "relative",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                width: 4,
                height: 56,
                borderRadius: 999,
                background: C.accent,
                opacity: 0.7,
              }}
            />
          </button>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative" }}>
        {rightSlot ? (
          <SlotContainer
            slot={rightSlot}
            parentConfig={liveConfig}
            onSlotUpdated={handleSlotUpdated}
            onSlotRemoved={() => void handleSlotRemoved("right")}
          />
        ) : (
          <EmptyColumn
            label="right column"
            editMode={editMode}
            busy={isAdding}
            onAdd={() => setPickerTarget("right")}
          />
        )}
      </div>

      {addError && (
        <div
          style={{
            position: "absolute",
            left: 16,
            bottom: 16,
            background: "#2a1117",
            border: "1px solid #7f1d1d",
            color: "#fca5a5",
            borderRadius: 8,
            padding: "0.6rem 0.8rem",
            fontSize: "0.8rem",
          }}
        >
          {addError}
        </div>
      )}

      {pickerTarget && (
        <ModulePicker
          onSelect={handleModuleSelected}
          onCancel={() => setPickerTarget(null)}
          headerOverride={{
            title: `Add ${pickerTarget} column module`,
            subtitle: `Choose the module to place in the ${pickerTarget} column`,
          }}
        />
      )}
    </div>
  );
}

function EmptyColumn({
  label,
  editMode,
  busy,
  onAdd,
}: {
  label: string;
  editMode: boolean;
  busy: boolean;
  onAdd: () => void;
}) {
  if (!editMode) {
    return <div style={{ height: "100%", background: C.panel }} />;
  }

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.8rem",
        background: C.panel,
        color: C.muted,
      }}
    >
      <p style={{ margin: 0, fontSize: "0.9rem" }}>No module in the {label}</p>
      <button
        onClick={onAdd}
        disabled={busy}
        style={{
          padding: "0.45rem 0.9rem",
          borderRadius: 6,
          border: `1px dashed ${C.border}`,
          background: "transparent",
          color: busy ? "#374151" : C.accent,
          cursor: busy ? "default" : "pointer",
          fontSize: "0.85rem",
        }}
      >
        {busy ? "Saving..." : `+ Add ${label}`}
      </button>
    </div>
  );
}
