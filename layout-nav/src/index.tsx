import React, { useState, useCallback } from "react";
import type { ModuleProps, ChildSlot, ModuleRegistryEntry } from "module-core";
import { useEditMode, useAwsS3Client, ModulePicker, SlotContainer } from "module-core";
import { PutObjectCommand } from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// Types — layout-nav's own schema for interpreting its children array.
// The framework doesn't know or care about these; this is purely the module's
// own convention for its config.
// ---------------------------------------------------------------------------

type NavDisplay =
  | { type: "text"; text: string }
  | { type: "image"; src: string };

// A child slot is a nav item if it has no meta.position.
// The top-bar-right slot is identified by meta.position === "top-bar-right".
function isTopBarSlot(slot: ChildSlot): boolean {
  return (slot.meta as { position?: string } | undefined)?.position === "top-bar-right";
}

function getNavDisplay(slot: ChildSlot): NavDisplay {
  const raw = (slot.meta as { navDisplay?: NavDisplay } | undefined)?.navDisplay;
  return raw ?? { type: "text", text: slot.slotId };
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const BG_SHELL = "#080f1c";
const BG_SIDEBAR = "#0b1525";
const BG_TOPBAR = "#0d1a2e";
const BORDER = "#1a2a42";
const TEXT_PRIMARY = "#e5e7eb";
const TEXT_MUTED = "#6b7280";
const ACCENT = "#3b82f6";

// ---------------------------------------------------------------------------
// layout-nav root component
// ---------------------------------------------------------------------------

export default function LayoutNav({ config }: ModuleProps) {
  const { editMode } = useEditMode();
  const getS3Client = useAwsS3Client();

  const children = config.children ?? [];
  const topBarSlot = children.find(isTopBarSlot);
  const navSlots = children.filter((s) => !isTopBarSlot(s));

  const [selectedSlotId, setSelectedSlotId] = useState<string | undefined>(
    navSlots[0]?.slotId
  );
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [addError, setAddError] = useState<string | undefined>();

  const selectedSlot = navSlots.find((s) => s.slotId === selectedSlotId);

  // Persist config changes back to S3 at the URL's config location
  const saveConfig = useCallback(async (updatedChildren: ChildSlot[]) => {
    const params = new URLSearchParams(window.location.search);
    const configBucket = params.get("bucket");
    const configPath = params.get("config");
    if (!configBucket || !configPath) {
      throw new Error("Missing ?bucket= or ?config= URL params");
    }
    const updated = { ...config, children: updatedChildren };
    const s3 = await getS3Client(configBucket);
    await s3.send(new PutObjectCommand({
      Bucket: configBucket,
      Key: configPath,
      Body: JSON.stringify(updated, null, 2),
      ContentType: "application/json",
    }));
  }, [config, getS3Client]);

  // Add a new nav item from the module picker
  const handleAddNavItem = useCallback(async (entry: ModuleRegistryEntry) => {
    setShowAddPicker(false);
    setAddError(undefined);

    const newSlot: ChildSlot = {
      slotId: `nav-${Date.now().toString(36)}`,
      app: { bucket: entry.bundleBucket, key: entry.bundlePath },
      meta: {
        navDisplay: { type: "text", text: entry.displayName ?? entry.moduleName },
      },
    };

    const updatedChildren = [...children, newSlot];
    try {
      await saveConfig(updatedChildren);
    } catch (err: unknown) {
      setAddError(`Failed to save: ${(err as Error).message}`);
      return;
    }
    // Reload so the shell re-fetches the updated config
    window.dispatchEvent(new Event("shell:navigate"));
  }, [children, saveConfig]);

  // Remove a nav item
  const handleRemoveNavItem = useCallback(async (slotId: string) => {
    const updatedChildren = children.filter((c) => c.slotId !== slotId);
    try {
      await saveConfig(updatedChildren);
    } catch {
      // Non-fatal for now — shell:navigate will reload fresh config
    }
    if (selectedSlotId === slotId) {
      setSelectedSlotId(updatedChildren.find((c) => !isTopBarSlot(c))?.slotId);
    }
    window.dispatchEvent(new Event("shell:navigate"));
  }, [children, saveConfig, selectedSlotId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: BG_SHELL, color: TEXT_PRIMARY, fontFamily: "system-ui, -apple-system, sans-serif" }}>

      {/* Top bar */}
      <div style={{
        height: 52,
        flexShrink: 0,
        background: BG_TOPBAR,
        borderBottom: `1px solid ${BORDER}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        padding: "0 0.75rem",
      }}>
        {topBarSlot && (
          <SlotContainer
            slot={topBarSlot}
            parentConfig={config}
            fallback={<div style={{ width: 36, height: 36 }} />}
          />
        )}
      </div>

      {/* Body: sidebar + content */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>

        {/* Left sidebar */}
        <div style={{
          width: 220,
          flexShrink: 0,
          background: BG_SIDEBAR,
          borderRight: `1px solid ${BORDER}`,
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
        }}>
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
              />
            ))}

            {editMode && (
              <button
                onClick={() => setShowAddPicker(true)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  padding: "0.45rem 0.75rem",
                  marginTop: "0.25rem",
                  borderRadius: 6,
                  border: `1px dashed ${BORDER}`,
                  background: "transparent",
                  color: TEXT_MUTED,
                  cursor: "pointer",
                  fontSize: "0.8rem",
                  width: "100%",
                  textAlign: "left",
                }}
              >
                + Add section
              </button>
            )}
          </div>

          {addError && (
            <p style={{ margin: "0.5rem", fontSize: "0.75rem", color: "#fca5a5" }}>{addError}</p>
          )}
        </div>

        {/* Content pane */}
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          {selectedSlot ? (
            <SlotContainer
              key={selectedSlot.slotId}
              slot={selectedSlot}
              parentConfig={config}
            />
          ) : (
            <EmptyContent editMode={editMode} onAdd={() => setShowAddPicker(true)} />
          )}
        </div>
      </div>

      {showAddPicker && (
        <ModulePicker
          onSelect={handleAddNavItem}
          onCancel={() => setShowAddPicker(false)}
          headerOverride={{
            title: "Add a section",
            subtitle: "Choose the module that will fill this navigation slot",
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nav item
// ---------------------------------------------------------------------------

function NavItem({
  slot,
  display,
  selected,
  editMode,
  onSelect,
  onRemove,
}: {
  slot: ChildSlot;
  display: NavDisplay;
  selected: boolean;
  editMode: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={{ position: "relative", display: "flex", alignItems: "center" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        onClick={onSelect}
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          gap: "0.6rem",
          padding: "0.45rem 0.75rem",
          borderRadius: 6,
          border: "none",
          background: selected ? "#1a3a5c" : hovered ? "#111e30" : "transparent",
          color: selected ? "#93c5fd" : TEXT_PRIMARY,
          cursor: "pointer",
          fontSize: "0.875rem",
          textAlign: "left",
          width: "100%",
          fontWeight: selected ? 500 : 400,
          transition: "background 0.1s",
        }}
      >
        {display.type === "image" ? (
          <img
            src={display.src}
            alt=""
            style={{ width: 20, height: 20, borderRadius: 3, objectFit: "cover", flexShrink: 0 }}
          />
        ) : (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: selected ? ACCENT : TEXT_MUTED,
              flexShrink: 0,
            }}
          />
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {display.type === "text" ? display.text : slot.slotId}
        </span>
      </button>

      {editMode && hovered && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="Remove section"
          style={{
            position: "absolute",
            right: 4,
            background: "none",
            border: "none",
            color: "#ef4444",
            cursor: "pointer",
            fontSize: "0.75rem",
            padding: "2px 4px",
            borderRadius: 3,
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty content pane
// ---------------------------------------------------------------------------

function EmptyContent({ editMode, onAdd }: { editMode: boolean; onAdd: () => void }) {
  return (
    <div style={{
      height: "100%",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: "1rem",
      color: TEXT_MUTED,
    }}>
      {editMode ? (
        <>
          <p style={{ margin: 0, fontSize: "0.9rem" }}>No sections yet</p>
          <button
            onClick={onAdd}
            style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              border: `2px dashed ${BORDER}`,
              background: "transparent",
              color: ACCENT,
              fontSize: "2rem",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            +
          </button>
        </>
      ) : (
        <p style={{ margin: 0, fontSize: "0.9rem" }}>Select a section from the sidebar</p>
      )}
    </div>
  );
}
