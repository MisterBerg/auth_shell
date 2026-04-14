import React from "react";
import { useEditMode } from "module-core";
import type { ModuleConfig } from "module-core";

type EditModeBarProps = {
  /** Reserved for future shell-level actions. */
  rootConfig: ModuleConfig | null;
};

/**
 * Floating shell-level edit mode controls. Rendered on top of every loaded
 * module (not on the sign-in screen). Only appears when a real module is
 * loaded from S3 (i.e. URL has ?bucket=&config= params).
 *
 * - "Edit Interface" enters edit mode
 * - "Done" exits edit mode
 *
 * All modules in the tree read editMode from EditModeContext — this is the
 * single place that writes it.
 */
export function EditModeBar({ rootConfig }: EditModeBarProps) {
  const { editMode, setEditMode } = useEditMode();
  void rootConfig;

  return (
    <>
      {/* Floating bar — bottom left, above everything */}
      <div
        style={{
          position: "fixed",
          bottom: 20,
          left: 20,
          zIndex: 1000,
          pointerEvents: "auto",
        }}
      >
        <button
          onClick={() => {
            setEditMode(!editMode);
          }}
          style={editMode ? doneButtonStyle : editButtonStyle}
          title={editMode ? "Exit interface editing" : "Edit the project interface"}
        >
          {editMode ? "Done" : "Edit Interface"}
        </button>
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

