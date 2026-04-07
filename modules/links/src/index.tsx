import { Fragment, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import type { MouseEvent } from "react";
import type { ModuleProps } from "module-core";
import { useEditMode, useUpdateSlotMeta } from "module-core";

type LinkItem = {
  text: string;
  url: string;
};

type OverlayPosition = {
  left: number;
  top: number;
};

const LINK_WIDTH = 120;

const DEFAULT_LINKS: LinkItem[] = [
  { text: "OpenAI", url: "https://openai.com" },
  { text: "GitHub", url: "https://github.com" },
];

function readLinks(metaLinks: unknown): LinkItem[] {
  if (!Array.isArray(metaLinks)) return [];
  return metaLinks
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const text = typeof record.text === "string" ? record.text.trim() : "";
      const url = typeof record.url === "string" ? record.url.trim() : "";
      if (!text || !url) return null;
      return { text, url };
    })
    .filter((item): item is LinkItem => item !== null);
}

function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export default function LinksModule({ config }: ModuleProps) {
  const { editMode } = useEditMode();
  const updateSlotMeta = useUpdateSlotMeta();
  const hasConfiguredLinks = Array.isArray(config.meta?.links);
  const savedLinks = readLinks(config.meta?.links);
  const links = hasConfiguredLinks ? savedLinks : DEFAULT_LINKS;

  const [draftLinks, setDraftLinks] = useState<LinkItem[]>(links);
  const [editingIndex, setEditingIndex] = useState<number | "new" | null>(null);
  const [draftLink, setDraftLink] = useState<LinkItem>({ text: "", url: "" });
  const [overlayPosition, setOverlayPosition] = useState<OverlayPosition | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();

  useEffect(() => {
    setDraftLinks(links);
    setEditingIndex(null);
    setSaveError(undefined);
  }, [config.meta?.links]);

  useEffect(() => {
    if (!editMode) {
      setEditingIndex(null);
      setOverlayPosition(null);
      setSaveError(undefined);
    }
  }, [editMode]);

  const placeOverlay = useCallback((element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const overlayWidth = 340;
    setOverlayPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - overlayWidth - 8)),
      top: Math.min(rect.bottom + 6, window.innerHeight - 44),
    });
  }, []);

  const beginAdd = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    setEditingIndex("new");
    setDraftLink({ text: "", url: "" });
    placeOverlay(event.currentTarget);
    setSaveError(undefined);
  }, [placeOverlay]);

  const beginEdit = useCallback((index: number, event: MouseEvent<HTMLButtonElement>) => {
    setEditingIndex(index);
    setDraftLink(draftLinks[index] ?? { text: "", url: "" });
    placeOverlay(event.currentTarget);
    setSaveError(undefined);
  }, [draftLinks, placeOverlay]);

  const saveDraftLink = useCallback(async () => {
    if (editingIndex === null) return;

    if (!updateSlotMeta) {
      setSaveError("Cannot save: this module is not running inside a slot.");
      return;
    }

    const text = draftLink.text.trim();
    const url = normalizeUrl(draftLink.url);
    const nextLinks = (() => {
      if (editingIndex === "new") {
        return text && url ? [...draftLinks, { text, url }] : draftLinks;
      }
      if (!text || !url) {
        return draftLinks.filter((_, index) => index !== editingIndex);
      }
      return draftLinks.map((link, index) => index === editingIndex ? { text, url } : link);
    })();

    setSaving(true);
    setSaveError(undefined);
    try {
      await updateSlotMeta({ links: nextLinks });
      setDraftLinks(nextLinks);
      setEditingIndex(null);
      setOverlayPosition(null);
      setDraftLink({ text: "", url: "" });
    } catch (err: unknown) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draftLink, draftLinks, editingIndex, updateSlotMeta]);

  const visibleLinks = editMode ? draftLinks : links;
  return (
    <div style={{
      height: "100%",
      boxSizing: "border-box",
      overflow: "hidden",
      background: "transparent",
      color: "#172033",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-start",
      padding: "0 8px",
    }}>
      {visibleLinks.length > 0 || editMode ? (
        <nav
          aria-label="Links"
          style={{
            width: "100%",
            display: "flex",
            justifyContent: "flex-start",
            alignItems: "center",
            height: "100%",
          }}
        >
          {visibleLinks.map((link, index) => (
            <Fragment key={`${link.url}-${index}`}>
              {index > 0 && <div aria-hidden="true" style={dividerStyle} />}
              {editMode ? (
                <button
                  type="button"
                  onClick={(event) => beginEdit(index, event)}
                  style={linkControlStyle}
                  title={`${link.text} — ${link.url}`}
                >
                  {link.text}
                </button>
              ) : (
                <a
                  href={normalizeUrl(link.url)}
                  target="_blank"
                  rel="noreferrer"
                  style={linkControlStyle}
                >
                  {link.text}
                </a>
              )}
            </Fragment>
          ))}

          {editMode && (
            <>
              {visibleLinks.length > 0 && <div aria-hidden="true" style={dividerStyle} />}
              <button type="button" onClick={beginAdd} style={addControlStyle} title="Add link">
              +
              </button>
            </>
          )}
        </nav>
      ) : (
        <span style={{ color: "#64748b", fontSize: "0.82rem" }}>No links configured</span>
      )}
      {editMode && editingIndex !== null && overlayPosition && createPortal(
        <LinkEditor
          draftLink={draftLink}
          disabled={saving}
          error={saveError}
          position={overlayPosition}
          onChange={setDraftLink}
          onSave={saveDraftLink}
          onCancel={() => {
            setEditingIndex(null);
            setOverlayPosition(null);
          }}
        />,
        document.body
      )}
    </div>
  );
}

function LinkEditor({
  draftLink,
  disabled,
  error,
  position,
  onChange,
  onSave,
  onCancel,
}: {
  draftLink: LinkItem;
  disabled: boolean;
  error: string | undefined;
  position: OverlayPosition;
  onChange: (link: LinkItem) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div title={error} style={{ ...editorStyle, left: position.left, top: position.top }}>
      <input
        value={draftLink.text}
        onChange={(event) => onChange({ ...draftLink, text: event.target.value })}
        placeholder="Text"
        disabled={disabled}
        style={inputStyle}
      />
      <input
        value={draftLink.url}
        onChange={(event) => onChange({ ...draftLink, url: event.target.value })}
        onKeyDown={(event) => { if (event.key === "Enter") onSave(); }}
        placeholder="URL"
        disabled={disabled}
        style={inputStyle}
      />
      <button type="button" onClick={onSave} disabled={disabled} style={primaryButtonStyle}>
        {disabled ? "..." : "Save"}
      </button>
      <button type="button" onClick={onCancel} disabled={disabled} style={cancelButtonStyle}>
        x
      </button>
    </div>
  );
}

const linkControlStyle: CSSProperties = {
  width: `${LINK_WIDTH}px`,
  height: "100%",
  flex: `0 0 ${LINK_WIDTH}px`,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  padding: "0 0.75rem",
  boxSizing: "border-box",
  color: "#bfdbfe",
  textDecoration: "none",
  fontSize: "0.86rem",
  fontWeight: 650,
  letterSpacing: "0.01em",
  background: "transparent",
  border: "none",
  appearance: "none",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  cursor: "pointer",
  lineHeight: 1,
};

const addControlStyle: CSSProperties = {
  ...linkControlStyle,
  width: "42px",
  flex: "0 0 42px",
  color: "#93c5fd",
  fontSize: "1.05rem",
  fontWeight: 700,
  lineHeight: 1,
};

const dividerStyle: CSSProperties = {
  width: "1px",
  height: "52%",
  flex: "0 0 1px",
  background: "rgba(148, 163, 184, 0.32)",
};

const editorStyle: CSSProperties = {
  position: "fixed",
  zIndex: 2147483647,
  width: "340px",
  height: "38px",
  minWidth: 0,
  display: "grid",
  gridTemplateColumns: "minmax(4.5rem, 0.75fr) minmax(6.5rem, 1fr) auto auto",
  alignItems: "center",
  gap: "0.3rem",
  padding: "0 0.35rem",
  boxSizing: "border-box",
  borderRadius: "12px",
  background: "rgba(15, 23, 42, 0.98)",
  border: "1px solid rgba(147, 197, 253, 0.42)",
  boxShadow: "0 20px 45px rgba(2, 6, 23, 0.42)",
};

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid rgba(148, 163, 184, 0.36)",
  borderRadius: "8px",
  background: "#0f172a",
  color: "#f8fafc",
  padding: "0 0.5rem",
  height: "28px",
  fontSize: "0.76rem",
  outline: "none",
};

const primaryButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: "999px",
  background: "#38bdf8",
  color: "#082f49",
  cursor: "pointer",
  fontWeight: 800,
  padding: "0 0.65rem",
  height: "28px",
  fontSize: "0.72rem",
};

const cancelButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: "999px",
  background: "transparent",
  color: "#93c5fd",
  cursor: "pointer",
  fontWeight: 900,
  padding: "0 0.35rem",
  height: "28px",
  fontSize: "0.75rem",
};
