import React, { useState, useCallback, useRef, useEffect } from "react";
import type { ModuleProps, ChildSlot, ModuleRegistryEntry } from "module-core";
import { useEditMode, useAwsS3Client, ModulePicker, SlotContainer } from "module-core";
import { PutObjectCommand } from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// Schema — layout-top-left's own convention for its children array.
//
// meta.position === "top-bar-main"  → left/flex area of the top bar
// meta.position === "top-bar-right" → right fixed area of the top bar (OAuth badge etc.)
// all others                        → nav items in the sidebar (order = array order)
//
// meta.navDisplay:
//   { type: "text", text: "My Section" }
//   { type: "image", src: "https://..." }
// ---------------------------------------------------------------------------

type NavDisplay =
  | { type: "text"; text: string }
  | { type: "image"; src: string };

type TopBarPosition = "top-bar-main" | "top-bar-right";

function getPosition(slot: ChildSlot): TopBarPosition | undefined {
  return (slot.meta as { position?: TopBarPosition } | undefined)?.position;
}

function isTopBarSlot(slot: ChildSlot): boolean {
  return getPosition(slot) !== undefined;
}

function getNavDisplay(slot: ChildSlot): NavDisplay {
  const raw = (slot.meta as { navDisplay?: NavDisplay } | undefined)?.navDisplay;
  return raw ?? { type: "text", text: slot.slotId };
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const BG_SHELL   = "#080f1c";
const BG_SIDEBAR = "#0b1525";
const BG_TOPBAR  = "#0d1a2e";
const BORDER     = "#1a2a42";
const TEXT_PRIMARY = "#e5e7eb";
const TEXT_MUTED   = "#6b7280";
const ACCENT       = "#3b82f6";

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

type PickerTarget =
  | { kind: "nav" }
  | { kind: "topbar"; position: TopBarPosition };

export default function LayoutTopLeft({ config }: ModuleProps) {
  const { editMode } = useEditMode();
  const getS3Client = useAwsS3Client();
  const getS3ClientRef = useRef(getS3Client);
  getS3ClientRef.current = getS3Client;

  const [children, setChildren] = useState<ChildSlot[]>(config.children ?? []);
  useEffect(() => { setChildren(config.children ?? []); }, [config]);

  const topBarMainSlot  = children.find((s) => getPosition(s) === "top-bar-main");
  const topBarRightSlot = children.find((s) => getPosition(s) === "top-bar-right");
  const navSlots = children.filter((s) => !isTopBarSlot(s));

  const [selectedSlotId, setSelectedSlotId] = useState<string | undefined>(
    () => (config.children ?? []).find((s) => !isTopBarSlot(s))?.slotId
  );
  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);
  const [addError, setAddError] = useState<string | undefined>();
  const [isAdding, setIsAdding] = useState(false);

  const selectedSlot = navSlots.find((s) => s.slotId === selectedSlotId);

  // Central slot-updated handler — syncs in-memory children when any
  // SlotContainer writes meta (e.g. webview URL) or swaps a bundle.
  const handleSlotUpdated = useCallback((updated: ChildSlot) => {
    setChildren((prev) => prev.map((c) => c.slotId === updated.slotId ? updated : c));
  }, []);

  const writeConfig = useCallback(async (updatedChildren: ChildSlot[]) => {
    const params = new URLSearchParams(window.location.search);
    const configBucket = params.get("bucket");
    const configPath   = params.get("config");
    if (!configBucket || !configPath) throw new Error("Missing ?bucket= or ?config= URL params");
    const s3 = await getS3ClientRef.current(configBucket);
    await s3.send(new PutObjectCommand({
      Bucket: configBucket,
      Key: configPath,
      Body: JSON.stringify({ ...config, children: updatedChildren }, null, 2),
      ContentType: "application/json",
      CacheControl: "no-store",
    }));
  }, [config]);

  const handleModuleSelected = useCallback(async (entry: ModuleRegistryEntry) => {
    if (!pickerTarget || isAdding) return;
    setPickerTarget(null);
    setAddError(undefined);
    setIsAdding(true);

    let newSlot: ChildSlot;
    if (pickerTarget.kind === "topbar") {
      newSlot = {
        slotId: `topbar-${pickerTarget.position}-${Date.now().toString(36)}`,
        app: { bucket: entry.bundleBucket, key: entry.bundlePath },
        meta: { position: pickerTarget.position },
      };
    } else {
      newSlot = {
        slotId: `nav-${Date.now().toString(36)}`,
        app: { bucket: entry.bundleBucket, key: entry.bundlePath },
        meta: { navDisplay: { type: "text", text: entry.displayName ?? entry.moduleName } },
      };
    }

    const updated = [...children, newSlot];
    console.log("[layout] handleModuleSelected", {
      pickerTarget,
      entry: { name: entry.moduleName, bucket: entry.bundleBucket, key: entry.bundlePath },
      newSlot,
      childrenBefore: children.map(c => ({ id: c.slotId, key: c.app?.key })),
      updatedChildren: updated.map(c => ({ id: c.slotId, key: c.app?.key })),
    });
    try {
      await writeConfig(updated);
    } catch (err: unknown) {
      setAddError(`Failed to save: ${(err as Error).message}`);
      setIsAdding(false);
      return;
    }

    console.log("[layout] write succeeded, updating local state", {
      newSlotId: newSlot.slotId,
      willAutoSelect: pickerTarget.kind === "nav",
    });
    setChildren(updated);
    if (pickerTarget.kind === "nav") {
      setSelectedSlotId(newSlot.slotId);
    }
    setIsAdding(false);
  }, [pickerTarget, isAdding, children, writeConfig]);

  const handleRemoveNavItem = useCallback(async (slotId: string) => {
    const updated = children.filter((c) => c.slotId !== slotId);
    setChildren(updated);
    if (selectedSlotId === slotId) {
      setSelectedSlotId(updated.find((c) => !isTopBarSlot(c))?.slotId);
    }
    try { await writeConfig(updated); } catch { /* non-fatal */ }
  }, [children, selectedSlotId, writeConfig]);

  const handleSlotRemoved = useCallback(async (slotId: string) => {
    const updated = children.filter((c) => c.slotId !== slotId);
    setChildren(updated);
    if (selectedSlotId === slotId) {
      setSelectedSlotId(updated.find((c) => !isTopBarSlot(c))?.slotId);
    }
    try { await writeConfig(updated); } catch { /* non-fatal */ }
  }, [children, selectedSlotId, writeConfig]);

  const handleRenameNavItem = useCallback(async (slotId: string, newText: string) => {
    const updated = children.map((c) =>
      c.slotId !== slotId ? c : {
        ...c,
        meta: { ...(c.meta ?? {}), navDisplay: { type: "text" as const, text: newText } },
      }
    );
    setChildren(updated);
    try { await writeConfig(updated); } catch { /* non-fatal */ }
  }, [children, writeConfig]);

  // Pass live children so SlotContainer always writes correct state
  const liveConfig = { ...config, children };

  const pickerHeader = pickerTarget?.kind === "topbar"
    ? pickerTarget.position === "top-bar-right"
      ? { title: "Add top-bar right module", subtitle: "Component shown on the right side of the top bar (OAuth badge, etc.)" }
      : { title: "Add top-bar module", subtitle: "Module shown in the main area of the top bar (navigation, title, etc.)" }
    : { title: "Add a section", subtitle: "Choose the module that will fill this navigation slot" };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: BG_SHELL, color: TEXT_PRIMARY, fontFamily: "system-ui, -apple-system, sans-serif" }}>

      {/* ── Top bar ── */}
      <div style={{ height: 52, flexShrink: 0, background: BG_TOPBAR, borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "stretch", gap: "0", overflow: "hidden" }}>

        {/* Main (left/flex) area */}
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          {topBarMainSlot ? (
            <SlotContainer
              slot={topBarMainSlot}
              parentConfig={liveConfig}
              onSlotUpdated={handleSlotUpdated}
              onSlotRemoved={() => handleSlotRemoved(topBarMainSlot.slotId)}
              fallback={<div />}
            />
          ) : (
            <TopBarPlaceholder
              label="top bar module"
              editMode={editMode}
              onClick={() => !isAdding && setPickerTarget({ kind: "topbar", position: "top-bar-main" })}
            />
          )}
        </div>

        {/* Divider */}
        <div style={{ width: 1, background: BORDER, flexShrink: 0 }} />

        {/* Right (fixed) area */}
        <div style={{ width: 200, flexShrink: 0, position: "relative" }}>
          {topBarRightSlot ? (
            <SlotContainer
              slot={topBarRightSlot}
              parentConfig={liveConfig}
              onSlotUpdated={handleSlotUpdated}
              onSlotRemoved={() => handleSlotRemoved(topBarRightSlot.slotId)}
              fallback={<div />}
            />
          ) : (
            <TopBarPlaceholder
              label="right component"
              editMode={editMode}
              onClick={() => !isAdding && setPickerTarget({ kind: "topbar", position: "top-bar-right" })}
            />
          )}
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>

        {/* Left sidebar */}
        <div style={{ width: 220, flexShrink: 0, background: BG_SIDEBAR, borderRight: `1px solid ${BORDER}`, display: "flex", flexDirection: "column", overflowY: "auto" }}>
          <div style={{ padding: "0.75rem 0.5rem", display: "flex", flexDirection: "column", gap: "2px" }}>
            {navSlots.map((slot) => (
              <NavItem
                key={slot.slotId}
                slot={slot}
                display={getNavDisplay(slot)}
                selected={slot.slotId === selectedSlotId}
                editMode={editMode}
                onSelect={() => setSelectedSlotId(slot.slotId)}
                onRemove={() => handleRemoveNavItem(slot.slotId)}
                onRename={(text) => handleRenameNavItem(slot.slotId, text)}
              />
            ))}

            {editMode && (
              <button
                onClick={() => !isAdding && setPickerTarget({ kind: "nav" })}
                disabled={isAdding}
                style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.45rem 0.75rem", marginTop: "0.25rem", borderRadius: 6, border: `1px dashed ${BORDER}`, background: "transparent", color: isAdding ? "#374151" : TEXT_MUTED, cursor: isAdding ? "default" : "pointer", fontSize: "0.8rem", width: "100%", textAlign: "left" }}
              >
                {isAdding ? "Saving…" : "+ Add section"}
              </button>
            )}
          </div>
          {addError && <p style={{ margin: "0 0.5rem 0.5rem", fontSize: "0.75rem", color: "#fca5a5" }}>{addError}</p>}
        </div>

        {/* Content pane — all nav slots are mounted; only the active one is visible.
            This keeps iframes alive across nav switches so they don't reload. */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative" }}>
          {navSlots.length === 0 ? (
            <EmptyContent editMode={editMode} onAdd={() => setPickerTarget({ kind: "nav" })} />
          ) : (
            navSlots.map((slot) => {
              console.log("[layout] rendering slot", { id: slot.slotId, key: slot.app?.key, selected: slot.slotId === selectedSlotId });
              return (
              <div
                key={slot.slotId}
                style={{
                  position: "absolute",
                  inset: 0,
                  visibility: slot.slotId === selectedSlotId ? "visible" : "hidden",
                  pointerEvents: slot.slotId === selectedSlotId ? "auto" : "none",
                }}
              >
                <SlotContainer
                  slot={slot}
                  parentConfig={liveConfig}
                  onSlotUpdated={handleSlotUpdated}
                  onSlotRemoved={() => handleSlotRemoved(slot.slotId)}
                />
              </div>
            );})
          )}
        </div>
      </div>

      {pickerTarget && (
        <ModulePicker
          onSelect={handleModuleSelected}
          onCancel={() => setPickerTarget(null)}
          headerOverride={pickerHeader}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top bar placeholder — shown when the slot is empty
// ---------------------------------------------------------------------------

function TopBarPlaceholder({ label, editMode, onClick }: { label: string; editMode: boolean; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);

  if (!editMode) {
    return <div style={{ height: "100%" }} />;
  }

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={`Add ${label}`}
      style={{
        width: "100%",
        height: "100%",
        background: hovered ? "rgba(59,130,246,0.08)" : "transparent",
        border: "none",
        borderBottom: `2px dashed ${hovered ? ACCENT : BORDER}`,
        color: hovered ? ACCENT : TEXT_MUTED,
        cursor: "pointer",
        fontSize: "0.75rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.4rem",
        transition: "background 0.1s, border-color 0.1s, color 0.1s",
        fontFamily: "inherit",
      }}
    >
      <span style={{ fontSize: "1rem", lineHeight: 1 }}>+</span>
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Nav item — inline label editing in edit mode
// ---------------------------------------------------------------------------

function NavItem({ slot, display, selected, editMode, onSelect, onRemove, onRename }: {
  slot: ChildSlot; display: NavDisplay; selected: boolean; editMode: boolean;
  onSelect: () => void; onRemove: () => void; onRename: (text: string) => void;
}) {
  const [hovered, setHovered]   = useState(false);
  const [editing, setEditing]   = useState(false);
  const [draft,   setDraft]     = useState(display.type === "text" ? display.text : slot.slotId);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(display.type === "text" ? display.text : slot.slotId);
  }, [display, slot.slotId, editing]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    const trimmed = draft.trim();
    const current = display.type === "text" ? display.text : slot.slotId;
    if (trimmed && trimmed !== current) onRename(trimmed);
    else setDraft(current);
  }, [draft, display, slot.slotId, onRename]);

  return (
    <div
      style={{ position: "relative", display: "flex", alignItems: "center" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        onClick={onSelect}
        style={{
          flex: 1, display: "flex", alignItems: "center", gap: "0.6rem",
          padding: "0.45rem 0.75rem", borderRadius: 6, border: "none",
          background: selected ? "#1a3a5c" : hovered ? "#111e30" : "transparent",
          color: selected ? "#93c5fd" : TEXT_PRIMARY,
          cursor: "pointer", fontSize: "0.875rem", textAlign: "left", width: "100%",
          fontWeight: selected ? 500 : 400, transition: "background 0.1s",
        }}
      >
        {display.type === "image" ? (
          <img src={display.src} alt="" style={{ width: 20, height: 20, borderRadius: 3, objectFit: "cover", flexShrink: 0 }} />
        ) : (
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: selected ? ACCENT : TEXT_MUTED, flexShrink: 0 }} />
        )}

        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
              if (e.key === "Escape") { setEditing(false); setDraft(display.type === "text" ? display.text : slot.slotId); }
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            style={{ flex: 1, background: "#0a1525", border: `1px solid ${ACCENT}`, borderRadius: 3, color: TEXT_PRIMARY, fontSize: "0.875rem", padding: "1px 4px", outline: "none", fontFamily: "inherit" }}
          />
        ) : (
          <span
            onClick={(e) => { if (!editMode) return; e.stopPropagation(); setEditing(true); setTimeout(() => inputRef.current?.select(), 0); }}
            title={editMode ? "Click to rename" : undefined}
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, cursor: editMode ? "text" : "inherit", borderBottom: editMode && hovered ? `1px dashed ${BORDER}` : "1px solid transparent" }}
          >
            {display.type === "text" ? display.text : slot.slotId}
          </span>
        )}
      </button>

      {editMode && hovered && !editing && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="Remove section"
          style={{ position: "absolute", right: 4, background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: "0.75rem", padding: "2px 4px", borderRadius: 3, lineHeight: 1 }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function EmptyContent({ editMode, onAdd }: { editMode: boolean; onAdd: () => void }) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1rem", color: TEXT_MUTED }}>
      {editMode ? (
        <>
          <p style={{ margin: 0, fontSize: "0.9rem" }}>No sections yet</p>
          <button onClick={onAdd} style={{ width: 64, height: 64, borderRadius: "50%", border: `2px dashed ${BORDER}`, background: "transparent", color: ACCENT, fontSize: "2rem", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            +
          </button>
        </>
      ) : (
        <p style={{ margin: 0, fontSize: "0.9rem" }}>Select a section from the sidebar</p>
      )}
    </div>
  );
}
