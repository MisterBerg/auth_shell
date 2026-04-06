import React, { useState, useRef, useEffect } from "react";

type NewProjectDialogProps = {
  onConfirm: (displayName: string, description: string) => Promise<void>;
  onCancel: () => void;
};

export function NewProjectDialog({ onConfirm, onCancel }: NewProjectDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const nameRef = useRef<HTMLInputElement>(null);

  // Focus the name field when the dialog opens
  useEffect(() => { nameRef.current?.focus(); }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onConfirm(trimmed, description.trim());
    } catch (err: unknown) {
      setError((err as Error).message ?? "Failed to create project");
      setSubmitting(false);
    }
  };

  return (
    // Backdrop
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      {/* Dialog */}
      <form
        onSubmit={handleSubmit}
        style={{
          background: "#0f1929",
          border: "1px solid #1e2d40",
          borderRadius: "12px",
          padding: "1.75rem",
          width: "100%",
          maxWidth: "420px",
          display: "flex",
          flexDirection: "column",
          gap: "1.1rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600, color: "#e5e7eb" }}>
          New Project
        </h2>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <span style={{ fontSize: "0.8rem", color: "#9ca3af" }}>Project name *</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Hardware Eval"
            required
            disabled={submitting}
            style={{
              padding: "0.55rem 0.75rem",
              borderRadius: "6px",
              border: "1px solid #1e3a5f",
              background: "#0a1525",
              color: "#e5e7eb",
              fontSize: "0.9rem",
              outline: "none",
            }}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <span style={{ fontSize: "0.8rem", color: "#9ca3af" }}>Description <span style={{ color: "#4b5563" }}>(optional)</span></span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this project for?"
            rows={3}
            disabled={submitting}
            style={{
              padding: "0.55rem 0.75rem",
              borderRadius: "6px",
              border: "1px solid #1e3a5f",
              background: "#0a1525",
              color: "#e5e7eb",
              fontSize: "0.9rem",
              resize: "vertical",
              outline: "none",
              fontFamily: "inherit",
            }}
          />
        </label>

        {error && (
          <p style={{ margin: 0, fontSize: "0.825rem", color: "#fca5a5" }}>{error}</p>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "0.25rem" }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "6px",
              border: "1px solid #1e3a5f",
              background: "transparent",
              color: "#9ca3af",
              cursor: "pointer",
              fontSize: "0.875rem",
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            style={{
              padding: "0.5rem 1.1rem",
              borderRadius: "6px",
              border: "none",
              background: name.trim() && !submitting ? "#2563eb" : "#1e3a5f",
              color: name.trim() && !submitting ? "#fff" : "#4b5563",
              cursor: name.trim() && !submitting ? "pointer" : "default",
              fontSize: "0.875rem",
              fontWeight: 500,
            }}
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
