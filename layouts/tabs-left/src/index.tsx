import React, { useState, useCallback, useRef, useEffect } from "react";
import type { ModuleProps, ChildSlot, ModuleRegistryEntry } from "module-core";
import { useEditMode, useAwsS3Client, useUpdateSlotChildren, ModulePicker, SlotContainer } from "module-core";
import { PutObjectCommand } from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTabName(slot: ChildSlot): string {
  return (slot.meta as { tabName?: string } | undefined)?.tabName ?? slot.slotId;
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const C = {
  bg:        "#080f1c",
  bgSidebar: "#0b1525",
  border:    "#1a2a42",
  text:      "#e5e7eb",
  muted:     "#6b7280",
  accent:    "#3b82f6",
  tabActive: "#1a3a5c",
};

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export default function LayoutTabsLeft({ config }: ModuleProps) {
  const { editMode }       = useEditMode();
  const getS3Client        = useAwsS3Client();
  const getS3ClientRef     = useRef(getS3Client);
  const updateSlotChildren = useUpdateSlotChildren();
  getS3ClientRef.current   = getS3Client;

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

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft,     setDraft]     = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const writeConfig = useCallback(async (updated: ChildSlot[]) => {
    if (updateSlotChildren) {
      await updateSlotChildren(updated);
    } else {
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

  return (
    <div style={{ display: "flex", height: "100%", background: C.bg, fontFamily: "system-ui, -apple-system, sans-serif" }}>

      {/* ── Left tab list ── */}
      <div style={{ width: 200, flexShrink: 0, background: C.bgSidebar, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", overflowY: "auto" }}>
        <div style={{ padding: "0.5rem", display: "flex", flexDirection: "column", gap: 2 }}>
          {slots.map((slot) => {
            const isActive = slot.slotId === activeId;
            return (
              <div
                key={slot.slotId}
                onClick={() => { if (editingId !== slot.slotId) { setActiveId(slot.slotId); setEverActive((prev) => new Set([...prev, slot.slotId])); } }}
                style={{
                  display: "flex", alignItems: "center", gap: "0.4rem",
                  padding: "0.45rem 0.6rem", borderRadius: 6,
                  background: isActive ? C.tabActive : "transparent",
                  borderLeft: `2px solid ${isActive ? C.accent : "transparent"}`,
                  cursor: "pointer", userSelect: "none",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = "#111e30"; }}
                onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
              >
                {/* Dot indicator */}
                <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: isActive ? C.accent : C.muted }} />

                {editingId === slot.slotId ? (
                  <input
                    ref={renameInputRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitRename(slot.slotId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")  { e.preventDefault(); commitRename(slot.slotId); }
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                    style={{ flex: 1, minWidth: 0, background: "#0a1525", border: `1px solid ${C.accent}`, borderRadius: 3, color: C.text, fontSize: "0.8rem", padding: "1px 4px", outline: "none", fontFamily: "inherit" }}
                  />
                ) : (
                  <span
                    onDoubleClick={(e) => {
                      if (!editMode) return;
                      e.stopPropagation();
                      setEditingId(slot.slotId);
                      setDraft(getTabName(slot));
                      setTimeout(() => renameInputRef.current?.select(), 30);
                    }}
                    title={editMode ? "Double-click to rename" : getTabName(slot)}
                    style={{ flex: 1, minWidth: 0, fontSize: "0.875rem", color: isActive ? "#93c5fd" : C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: isActive ? 500 : 400 }}
                  >
                    {getTabName(slot)}
                  </span>
                )}

                {editMode && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRemoveSlot(slot.slotId); }}
                    title="Remove tab"
                    style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: "0.7rem", padding: "1px 3px", borderRadius: 3, flexShrink: 0, lineHeight: 1, opacity: 0.7 }}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.7")}
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}

          {editMode && (
            <button
              onClick={() => !isAdding && setShowPicker(true)}
              disabled={isAdding}
              style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.4rem 0.6rem", marginTop: "0.25rem", borderRadius: 6, border: `1px dashed ${C.border}`, background: "transparent", color: isAdding ? "#374151" : C.muted, cursor: isAdding ? "default" : "pointer", fontSize: "0.8rem", width: "100%", textAlign: "left" }}
            >
              {isAdding ? "Saving…" : "+ Add tab"}
            </button>
          )}
        </div>

        {addError && (
          <p style={{ margin: "0 0.5rem 0.5rem", fontSize: "0.75rem", color: "#fca5a5" }}>{addError}</p>
        )}
      </div>

      {/* ── Content pane — all slots mounted, only active visible ── */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative" }}>
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
