import React, { useState, useEffect, useCallback, useRef } from "react";
import type { ModuleProps } from "module-core";
import { useEditMode, useUpdateSlotMeta } from "module-core";

/**
 * Web View — loads any URL in a full-frame iframe.
 *
 * config.meta.url  — the persisted URL (read on mount, saved via updateSlotMeta)
 *
 * Important limitation: many websites (Google, GitHub, etc.) set
 * X-Frame-Options or Content-Security-Policy headers that prevent them from
 * being loaded inside an iframe. This is a browser security enforcement and
 * cannot be bypassed client-side. The webview works with sites that explicitly
 * permit framing — typically internal tools, documentation sites, and apps
 * designed for embedding.
 */
export default function WebView({ config }: ModuleProps) {
  const { editMode } = useEditMode();
  const updateSlotMeta = useUpdateSlotMeta();

  const savedUrl = (config.meta?.url as string | undefined) ?? "";

  const [activeUrl, setActiveUrl] = useState(savedUrl);
  const [draftUrl, setDraftUrl] = useState(savedUrl);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  // Tracks whether the iframe fired its load event — used to show a hint
  // after a short delay if nothing appears. Note: X-Frame-Options blocks
  // do not reliably fire onerror, so we use a timeout heuristic.
  const [loadState, setLoadState] = useState<"idle" | "loading" | "loaded" | "timeout">("idle");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setActiveUrl(savedUrl);
    setDraftUrl(savedUrl);
  }, [savedUrl]);

  useEffect(() => {
    if (!editMode) {
      setDraftUrl(activeUrl);
      setSaveError(undefined);
    }
  }, [editMode, activeUrl]);

  // Start load tracking whenever activeUrl changes
  useEffect(() => {
    if (!activeUrl) { setLoadState("idle"); return; }
    setLoadState("loading");
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setLoadState((s) => s === "loading" ? "timeout" : s);
    }, 5000);
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, [activeUrl]);

  const handleIframeLoad = useCallback(() => {
    setLoadState("loaded");
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  const handleApply = useCallback(async () => {
    const trimmed = draftUrl.trim();
    if (!trimmed || trimmed === activeUrl) return;
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    setSaving(true);
    setSaveError(undefined);
    if (!updateSlotMeta) {
      setSaveError("Cannot save: not running inside a slot");
      setSaving(false);
      return;
    }
    try {
      await updateSlotMeta({ url });
      setActiveUrl(url);
      setDraftUrl(url);
    } catch (err: unknown) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draftUrl, activeUrl, updateSlotMeta]);

  const canApply = !saving && !!draftUrl.trim() && draftUrl.trim() !== activeUrl;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#080f1c" }}>

      {/* Edit mode URL bar */}
      {editMode && (
        <div style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.4rem",
          padding: "0.5rem 0.75rem",
          background: "#0d1a2e",
          borderBottom: "1px solid #1a2a42",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <input
              ref={inputRef}
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
              placeholder="https://example.com"
              disabled={saving}
              style={{
                flex: 1,
                background: "#0a1525",
                border: "1px solid #1e3a5f",
                borderRadius: 6,
                color: "#e5e7eb",
                fontSize: "0.875rem",
                padding: "0.35rem 0.6rem",
                outline: "none",
                fontFamily: "monospace",
              }}
            />
            <button
              onClick={handleApply}
              disabled={!canApply}
              style={{
                padding: "0.35rem 0.85rem",
                borderRadius: 6,
                border: "none",
                background: canApply ? "#2563eb" : "#1e3a5f",
                color: canApply ? "#fff" : "#4b5563",
                cursor: canApply ? "pointer" : "default",
                fontSize: "0.8rem",
                fontWeight: 500,
                flexShrink: 0,
              }}
            >
              {saving ? "Saving…" : "Apply"}
            </button>
          </div>
          <p style={{ margin: 0, fontSize: "0.7rem", color: "#4b5563", lineHeight: 1.4 }}>
            Note: many sites (Google, GitHub, etc.) block iframe embedding via browser security headers.
            This works best with internal tools and sites that permit framing.
            {saveError && <span style={{ color: "#fca5a5", marginLeft: "0.5rem" }}>{saveError}</span>}
          </p>
        </div>
      )}

      {/* Content area */}
      {activeUrl ? (
        <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
          <iframe
            key={activeUrl}
            src={activeUrl}
            onLoad={handleIframeLoad}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }}
            title="Web View"
          />
          {/* Timeout hint — shown when iframe hasn't confirmed load after 5s */}
          {loadState === "timeout" && (
            <div style={{
              position: "absolute",
              bottom: 16,
              left: "50%",
              transform: "translateX(-50%)",
              background: "rgba(11, 21, 37, 0.92)",
              border: "1px solid #1a2a42",
              borderRadius: 8,
              padding: "0.6rem 1rem",
              fontSize: "0.8rem",
              color: "#9ca3af",
              textAlign: "center",
              pointerEvents: "none",
              maxWidth: 360,
            }}>
              Content may be blocked — this site may not permit iframe embedding.
            </div>
          )}
        </div>
      ) : (
        <div style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.75rem",
          color: "#6b7280",
          fontSize: "0.9rem",
        }}>
          {editMode ? (
            <>
              <span>Enter a URL above to load content</span>
              <button
                onClick={() => inputRef.current?.focus()}
                style={{ padding: "0.4rem 0.9rem", borderRadius: 6, border: "1px solid #1e3a5f", background: "transparent", color: "#3b82f6", cursor: "pointer", fontSize: "0.85rem" }}
              >
                Set URL
              </button>
            </>
          ) : (
            <span>No URL configured</span>
          )}
        </div>
      )}
    </div>
  );
}
