import React, { useState, useCallback, useRef, useEffect } from "react";
import type { ModuleProps, ChildSlot, ModuleRegistryEntry } from "module-core";
import {
  useEditMode,
  useAwsS3Client,
  useUpdateSlotChildren,
  useParentUiTargetId,
  useRegisterUiTarget,
  useIsTargetHighlighted,
  useLinkAuthoring,
  useLinkAuthoringStep,
  ModulePicker,
  SlotContainer,
} from "module-core";
import { PutObjectCommand } from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTabName(slot: ChildSlot): string {
  return (slot.meta as { tabName?: string } | undefined)?.tabName ?? slot.slotId;
}

function getLayoutTargetId(parentTargetId: string | undefined, configId: string): string {
  return `${parentTargetId ?? "root"}:layout:${configId}`;
}

function getTabTargetId(layoutTargetId: string, slotId: string): string {
  return `${layoutTargetId}:tab:${slotId}`;
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const C = {
  bg:        "#080f1c",
  bgBar:     "#0d1a2e",
  border:    "#1a2a42",
  text:      "#e5e7eb",
  muted:     "#6b7280",
  accent:    "#3b82f6",
  tabActive: "#0f1f35",
};

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export default function LayoutTabsTop({ config }: ModuleProps) {
  const { editMode }       = useEditMode();
  const getS3Client        = useAwsS3Client();
  const getS3ClientRef     = useRef(getS3Client);
  const updateSlotChildren = useUpdateSlotChildren(); // null when this is the root layout
  const parentTargetId     = useParentUiTargetId();
  const isRootLayout       = !updateSlotChildren;
  getS3ClientRef.current   = getS3Client;
  const layoutTargetId     = getLayoutTargetId(parentTargetId, config.id);

  const [slots, setSlots] = useState<ChildSlot[]>(config.children ?? []);
  useEffect(() => { setSlots(config.children ?? []); }, [config]);

  const [activeId,   setActiveId]   = useState<string | undefined>(() => (config.children ?? [])[0]?.slotId);
  const [everActive, setEverActive] = useState<Set<string>>(() => {
    const first = (config.children ?? [])[0]?.slotId;
    return new Set(first ? [first] : []);
  });
  const [showPicker, setShowPicker] = useState(false);
  const [addError,   setAddError]   = useState<string | undefined>();
  const [isAdding,   setIsAdding]   = useState(false);

  // Inline rename state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft,     setDraft]     = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const writeConfig = useCallback(async (updated: ChildSlot[]) => {
    if (updateSlotChildren) {
      // Child layout — write through the parent SlotContext
      await updateSlotChildren(updated);
    } else {
      // Root layout — write directly to the URL-specified config
      const params = new URLSearchParams(window.location.search);
      const configBucket = params.get("bucket");
      const configPath   = params.get("config");
      if (!configBucket || !configPath) throw new Error("Missing ?bucket= or ?config= URL params");
      const s3 = await getS3ClientRef.current(configBucket);
      await s3.send(new PutObjectCommand({
        Bucket: configBucket,
        Key: configPath,
        Body: JSON.stringify({ ...config, children: updated }, null, 2),
        ContentType: "application/json",
        CacheControl: "no-store",
      }));
    }
  }, [updateSlotChildren, config]);

  const handleSlotUpdated = useCallback((updated: ChildSlot) => {
    setSlots((prev) => prev.map((s) => s.slotId === updated.slotId ? updated : s));
  }, []);

  const handleModuleSelected = useCallback(async (entry: ModuleRegistryEntry) => {
    if (isAdding) return;
    setShowPicker(false);
    setAddError(undefined);
    setIsAdding(true);

    const newSlot: ChildSlot = {
      slotId: `tab-${Date.now().toString(36)}`,
      app: { bucket: entry.bundleBucket, key: entry.bundlePath },
      meta: { tabName: entry.displayName ?? entry.moduleName },
    };

    const updated = [...slots, newSlot];
    try {
      await writeConfig(updated);
    } catch (err: unknown) {
      setAddError(`Failed to save: ${(err as Error).message}`);
      setIsAdding(false);
      return;
    }
    setSlots(updated);
    setActiveId(newSlot.slotId);
    setEverActive((prev) => new Set([...prev, newSlot.slotId]));
    setIsAdding(false);
  }, [isAdding, slots, writeConfig]);

  const handleRemoveSlot = useCallback(async (slotId: string) => {
    const updated = slots.filter((s) => s.slotId !== slotId);
    setSlots(updated);
    if (activeId === slotId) setActiveId(updated[0]?.slotId);
    try { await writeConfig(updated); } catch { /* non-fatal */ }
  }, [slots, activeId, writeConfig]);

  const commitRename = useCallback(async (slotId: string) => {
    setEditingId(null);
    const trimmed = draft.trim();
    if (!trimmed) return;
    const updated = slots.map((s) =>
      s.slotId !== slotId ? s : { ...s, meta: { ...(s.meta ?? {}), tabName: trimmed } }
    );
    setSlots(updated);
    try { await writeConfig(updated); } catch { /* non-fatal */ }
  }, [slots, draft, writeConfig]);

  const liveConfig = { ...config, children: slots };

  useRegisterUiTarget({
    id: layoutTargetId,
    kind: "layout",
    parentId: parentTargetId,
    label: config.id,
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: isRootLayout ? "100vh" : "100%",
        background: C.bg,
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >

      {/* ── Tab bar ── */}
      <div style={{ display: "flex", alignItems: "stretch", background: C.bgBar, borderBottom: `1px solid ${C.border}`, height: 38, flexShrink: 0, overflowX: "auto" }}>

        {slots.map((slot) => {
          const tabTargetId = getTabTargetId(layoutTargetId, slot.slotId);
          const isActive = slot.slotId === activeId;
          return (
            <TabChip
              key={slot.slotId}
              slot={slot}
              targetId={tabTargetId}
              editMode={editMode}
              isActive={isActive}
              isEditing={editingId === slot.slotId}
              renameInputRef={renameInputRef}
              draft={draft}
              setDraft={setDraft}
              onActivate={() => {
                if (editingId !== slot.slotId) {
                  setActiveId(slot.slotId);
                  setEverActive((prev) => new Set([...prev, slot.slotId]));
                }
              }}
              onStartRename={() => {
                setEditingId(slot.slotId);
                setDraft(getTabName(slot));
                setTimeout(() => renameInputRef.current?.select(), 30);
              }}
              onCommitRename={() => commitRename(slot.slotId)}
              onCancelRename={() => setEditingId(null)}
              onRemove={() => handleRemoveSlot(slot.slotId)}
            />
          );
        })}

        {editMode && (
          <button
            onClick={() => !isAdding && setShowPicker(true)}
            disabled={isAdding}
            title="Add tab"
            style={{ padding: "0 0.75rem", background: "transparent", border: "none", borderRight: `1px solid ${C.border}`, color: isAdding ? "#374151" : C.muted, cursor: isAdding ? "default" : "pointer", fontSize: "1rem", flexShrink: 0 }}
          >
            {isAdding ? "…" : "+"}
          </button>
        )}
      </div>

      {addError && (
        <p style={{ margin: "0.25rem 0.75rem", fontSize: "0.75rem", color: "#fca5a5" }}>{addError}</p>
      )}

      {/* ── Content pane — all slots mounted, only active visible ── */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {slots.length === 0 ? (
          <EmptyState editMode={editMode} onAdd={() => setShowPicker(true)} />
        ) : (
          slots.filter((slot) => everActive.has(slot.slotId)).map((slot) => (
            <div
              key={slot.slotId}
              style={{
                position: "absolute", inset: 0,
                visibility: slot.slotId === activeId ? undefined : "hidden",
                pointerEvents: slot.slotId === activeId ? "auto" : "none",
              }}
            >
              <SlotContainer
                slot={slot}
                parentConfig={liveConfig}
                targetParentId={getTabTargetId(layoutTargetId, slot.slotId)}
                onSlotUpdated={handleSlotUpdated}
                onSlotRemoved={() => handleRemoveSlot(slot.slotId)}
              />
            </div>
          ))
        )}
      </div>

      {showPicker && (
        <ModulePicker
          onSelect={handleModuleSelected}
          onCancel={() => setShowPicker(false)}
          headerOverride={{ title: "Add a tab", subtitle: "Choose the module for this tab" }}
        />
      )}
    </div>
  );
}

function TabChip({
  slot,
  targetId,
  editMode,
  isActive,
  isEditing,
  renameInputRef,
  draft,
  setDraft,
  onActivate,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onRemove,
}: {
  slot: ChildSlot;
  targetId: string;
  editMode: boolean;
  isActive: boolean;
  isEditing: boolean;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  draft: string;
  setDraft: (value: string) => void;
  onActivate: () => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onRemove: () => void;
}) {
  const isHighlighted = useIsTargetHighlighted(targetId);
  const { completeLink } = useLinkAuthoring();
  const linkStep = useLinkAuthoringStep();
  const isSelectingTarget = linkStep === "select-target";
  const isBusy = linkStep === "saving";

  useRegisterUiTarget({
    id: targetId,
    kind: "tab",
    parentId: targetId.split(":tab:")[0],
    label: getTabName(slot),
    reveal: () => {
      onActivate();
    },
  });

  return (
    <div
      onClick={() => {
        if (isSelectingTarget) {
          void completeLink(targetId);
          return;
        }
        if (!isBusy) {
          onActivate();
        }
      }}
      style={{
        display: "flex", alignItems: "center", gap: "0.4rem",
        padding: "0 0.75rem", flexShrink: 0, minWidth: 0, maxWidth: 200,
        background: isActive ? C.tabActive : "transparent",
        borderRight: `1px solid ${C.border}`,
        borderBottom: isActive ? `2px solid ${C.accent}` : "2px solid transparent",
        cursor: "pointer", userSelect: "none",
        boxShadow: isSelectingTarget
          ? "inset 0 0 0 1px rgba(253, 224, 71, 0.9), 0 0 0 1px rgba(234, 179, 8, 0.4)"
          : isHighlighted ? "inset 0 0 0 1px rgba(147, 197, 253, 0.9), 0 0 0 1px rgba(59, 130, 246, 0.45)" : undefined,
      }}
    >
      {isEditing ? (
        <input
          ref={renameInputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={onCommitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter")  { e.preventDefault(); onCommitRename(); }
            if (e.key === "Escape") onCancelRename();
          }}
          onClick={(e) => e.stopPropagation()}
          autoFocus
          style={{ width: 100, background: "#0a1525", border: `1px solid ${C.accent}`, borderRadius: 3, color: C.text, fontSize: "0.78rem", padding: "2px 5px", outline: "none", fontFamily: "inherit" }}
        />
      ) : (
        <span
          onDoubleClick={(e) => {
            if (!editMode) return;
            e.stopPropagation();
            onStartRename();
          }}
          title={isSelectingTarget ? "Click to link to this tab" : editMode ? "Double-click to rename" : getTabName(slot)}
          style={{ fontSize: "0.8rem", color: isSelectingTarget ? "#fde68a" : isActive ? C.text : isHighlighted ? "#bfdbfe" : C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}
        >
          {getTabName(slot)}
        </span>
      )}

      {editMode && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="Remove tab"
          style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: "0.65rem", padding: "1px 3px", borderRadius: 3, flexShrink: 0, lineHeight: 1 }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

function EmptyState({ editMode, onAdd }: { editMode: boolean; onAdd: () => void }) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "0.75rem", color: C.muted, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      {editMode ? (
        <>
          <p style={{ margin: 0, fontSize: "0.9rem" }}>No tabs yet.</p>
          <button
            onClick={onAdd}
            style={{ padding: "0.4rem 1rem", borderRadius: 6, border: `1px dashed ${C.border}`, background: "transparent", color: C.accent, cursor: "pointer", fontSize: "0.875rem" }}
          >
            + Add a tab
          </button>
        </>
      ) : (
        <p style={{ margin: 0, fontSize: "0.875rem" }}>No content configured.</p>
      )}
    </div>
  );
}
