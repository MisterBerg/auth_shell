import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useModuleRegistry } from "./useModuleRegistry.ts";
import type { ModuleRegistryEntry, ModuleCategory } from "./types.ts";

type ModulePickerProps = {
  onSelect: (entry: ModuleRegistryEntry) => void;
  onCancel: () => void;
  headerOverride?: { title: string; subtitle: string };
  errorMessage?: string;
};

const CATEGORY_LABELS: Record<ModuleCategory | "unknown", string> = {
  layout: "Layouts",
  app: "Apps",
  component: "Components",
  unknown: "Other",
};

const CATEGORY_DESCRIPTIONS: Record<ModuleCategory | "unknown", string> = {
  layout: "Organizational frames with configurable child slots",
  app: "Self-contained full-frame applications",
  component: "Panels and widgets designed to live inside a layout",
  unknown: "Uncategorized modules",
};

/**
 * ModulePicker — a modal that queries the module registry and lets the user
 * choose a module, grouped by category. Used by app-empty (root slot picker)
 * and SlotContainer (child slot picker in edit mode).
 */
export function ModulePicker({ onSelect, onCancel, headerOverride, errorMessage }: ModulePickerProps) {
  const { entries, loading, error } = useModuleRegistry();

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  // Group entries by category
  const grouped = entries.reduce<Record<string, ModuleRegistryEntry[]>>((acc, entry) => {
    const cat = entry.category ?? "unknown";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(entry);
    return acc;
  }, {});

  const categoryOrder: (ModuleCategory | "unknown")[] = ["layout", "app", "component", "unknown"];
  const presentCategories = categoryOrder.filter((c) => grouped[c]?.length);

  return createPortal(
    // Backdrop
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
      }}
    >
      {/* Dialog */}
      <div
        style={{
          background: "#0f1929",
          border: "1px solid #1e2d40",
          borderRadius: "12px",
          width: "min(680px, 90vw)",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "1.25rem 1.5rem",
            borderBottom: "1px solid #1e2d40",
            flexShrink: 0,
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 600, color: "#e5e7eb" }}>
              {headerOverride?.title ?? "Choose a Module"}
            </h2>
            <p style={{ margin: "0.2rem 0 0", fontSize: "0.8rem", color: "#6b7280" }}>
              {headerOverride?.subtitle ?? "Select the module that will fill this slot"}
            </p>
          </div>
          <button
            onClick={onCancel}
            style={{
              background: "none",
              border: "none",
              color: "#6b7280",
              cursor: "pointer",
              fontSize: "1.1rem",
              padding: "0.2rem 0.4rem",
              borderRadius: "4px",
              lineHeight: 1,
            }}
          >
            &#x2715;
          </button>
        </div>

        {/* Body */}
        <div style={{ overflowY: "auto", padding: "1rem 1.5rem 1.5rem", flex: 1 }}>
          {loading && (
            <p style={{ color: "#6b7280", fontSize: "0.875rem", textAlign: "center", marginTop: "2rem" }}>
              Loading registry…
            </p>
          )}

          {error && (
            <p style={{ color: "#fca5a5", fontSize: "0.875rem", textAlign: "center", marginTop: "2rem" }}>
              Failed to load registry: {error}
            </p>
          )}

          {errorMessage && (
            <p style={{ color: "#fca5a5", fontSize: "0.875rem", textAlign: "center", marginTop: "0.5rem", marginBottom: 0 }}>
              {errorMessage}
            </p>
          )}

          {!loading && !error && entries.length === 0 && (
            <p style={{ color: "#6b7280", fontSize: "0.875rem", textAlign: "center", marginTop: "2rem" }}>
              No modules published yet.
            </p>
          )}

          {presentCategories.map((cat) => (
            <section key={cat} style={{ marginBottom: "1.5rem" }}>
              <div style={{ marginBottom: "0.5rem" }}>
                <h3 style={{ margin: 0, fontSize: "0.8rem", fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {CATEGORY_LABELS[cat]}
                </h3>
                <p style={{ margin: "0.1rem 0 0", fontSize: "0.75rem", color: "#4b5563" }}>
                  {CATEGORY_DESCRIPTIONS[cat]}
                </p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
                {grouped[cat].map((entry) => (
                  <ModuleCard key={entry.moduleName} entry={entry} onSelect={onSelect} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ModuleCard({ entry, onSelect }: { entry: ModuleRegistryEntry; onSelect: (e: ModuleRegistryEntry) => void }) {
  return (
    <button
      onClick={() => onSelect(entry)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "1rem",
        padding: "0.75rem 1rem",
        borderRadius: "8px",
        border: "1px solid #1e2d40",
        background: "#0a1525",
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
        transition: "border-color 0.1s, background 0.1s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = "#3b82f6";
        (e.currentTarget as HTMLButtonElement).style.background = "#0f1f35";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = "#1e2d40";
        (e.currentTarget as HTMLButtonElement).style.background = "#0a1525";
      }}
    >
      {/* Icon placeholder */}
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: "6px",
          background: "#1e2d40",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "1rem",
          color: "#374151",
        }}
      >
        &#9632;
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "0.875rem", fontWeight: 500, color: "#e5e7eb" }}>
          {entry.displayName ?? entry.moduleName}
        </div>
        {entry.description && (
          <div style={{ fontSize: "0.775rem", color: "#6b7280", marginTop: "0.15rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {entry.description}
          </div>
        )}
        <div style={{ fontSize: "0.7rem", color: "#374151", marginTop: "0.2rem", fontFamily: "monospace" }}>
          {entry.moduleName}
        </div>
      </div>

      <div style={{ color: "#374151", flexShrink: 0 }}>&#8250;</div>
    </button>
  );
}
