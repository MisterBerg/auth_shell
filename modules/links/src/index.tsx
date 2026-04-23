import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import type { MouseEvent } from "react";
import type { ModuleProps } from "module-core";
import {
  useEditMode,
  useIsLinkSourceSelected,
  useLinkAuthoring,
  useNavigateToTarget,
  useRegisterLinkSource,
  useUiTargets,
  useUpdateSlotMeta,
} from "module-core";

type LinkItem = {
  text: string;
  url?: string;
  targetId?: string;
};

type LinkDraft = {
  text: string;
  destinationType: "url" | "tab";
  url: string;
  targetId: string;
};

type OverlayPosition = {
  left: number;
  top: number;
};

type TargetOption = {
  id: string;
  label: string;
};

const LINK_WIDTH = 120;

const DEFAULT_LINKS: LinkItem[] = [
  { text: "OpenAI", url: "https://openai.com" },
  { text: "GitHub", url: "https://github.com" },
];

function readLinks(metaLinks: unknown): LinkItem[] {
  if (!Array.isArray(metaLinks)) return [];
  const parsed: LinkItem[] = [];
  for (const item of metaLinks) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    const url = typeof record.url === "string" ? record.url.trim() : "";
    const targetId = typeof record.targetId === "string" ? record.targetId.trim() : "";
    if (!text) continue;
    if (targetId) {
      parsed.push({ text, targetId });
      continue;
    }
    if (url) {
      parsed.push({ text, url });
    }
  }
  return parsed;
}

function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function getDestinationType(link: LinkItem): "url" | "tab" {
  return link.targetId ? "tab" : "url";
}

function createDraft(link: LinkItem, defaultTargetId: string): LinkDraft {
  return {
    text: link.text,
    destinationType: getDestinationType(link),
    url: link.url ?? "",
    targetId: link.targetId ?? defaultTargetId,
  };
}

function createEmptyDraft(defaultTargetId: string, hasTabTargets: boolean): LinkDraft {
  return {
    text: "",
    destinationType: hasTabTargets ? "tab" : "url",
    url: "",
    targetId: defaultTargetId,
  };
}

function buildLinkFromDraft(draftLink: LinkDraft): LinkItem | null {
  const text = draftLink.text.trim();
  if (!text) return null;

  if (draftLink.destinationType === "tab") {
    const targetId = draftLink.targetId.trim();
    return targetId ? { text, targetId } : null;
  }

  const url = normalizeUrl(draftLink.url);
  return url ? { text, url } : null;
}

export default function LinksModule({ config }: ModuleProps) {
  const { editMode } = useEditMode();
  const updateSlotMeta = useUpdateSlotMeta();
  const navigateToTarget = useNavigateToTarget();
  const { step, chooseSource } = useLinkAuthoring();
  const targets = useUiTargets();
  const hasConfiguredLinks = Array.isArray(config.meta?.links);
  const savedLinks = readLinks(config.meta?.links);
  const links = hasConfiguredLinks ? savedLinks : DEFAULT_LINKS;
  const tabTargets = useMemo<TargetOption[]>(
    () => Array.from(targets.values())
      .filter((target) => target.kind === "tab")
      .map((target) => ({
        id: target.id,
        label: target.label?.trim() || target.id,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [targets]
  );
  const defaultTargetId = tabTargets[0]?.id ?? "";

  const [draftLinks, setDraftLinks] = useState<LinkItem[]>(links);
  const [editingIndex, setEditingIndex] = useState<number | "new" | null>(null);
  const [draftLink, setDraftLink] = useState<LinkDraft>(() => createEmptyDraft(defaultTargetId, tabTargets.length > 0));
  const [overlayPosition, setOverlayPosition] = useState<OverlayPosition | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();

  useEffect(() => {
    setDraftLinks(links);
    setEditingIndex(null);
    setSaveError(undefined);
  }, [links]);

  useEffect(() => {
    if (!editMode) {
      setEditingIndex(null);
      setOverlayPosition(null);
      setSaveError(undefined);
    }
  }, [editMode]);

  useEffect(() => {
    setDraftLink((current) => {
      if (current.targetId) return current;
      if (!defaultTargetId) return current;
      return { ...current, targetId: defaultTargetId };
    });
  }, [defaultTargetId]);

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
    setDraftLink(createEmptyDraft(defaultTargetId, tabTargets.length > 0));
    placeOverlay(event.currentTarget);
    setSaveError(undefined);
  }, [defaultTargetId, placeOverlay, tabTargets.length]);

  const beginEdit = useCallback((index: number, event: MouseEvent<HTMLButtonElement>) => {
    setEditingIndex(index);
    setDraftLink(createDraft(draftLinks[index] ?? { text: "", url: "" }, defaultTargetId));
    placeOverlay(event.currentTarget);
    setSaveError(undefined);
  }, [defaultTargetId, draftLinks, placeOverlay]);

  const saveDraftLink = useCallback(async () => {
    if (editingIndex === null) return;

    if (!updateSlotMeta) {
      setSaveError("Cannot save: this module is not running inside a slot.");
      return;
    }

    const nextLink = buildLinkFromDraft(draftLink);
    const nextLinks = (() => {
      if (editingIndex === "new") {
        return nextLink ? [...draftLinks, nextLink] : draftLinks;
      }
      if (!nextLink) {
        return draftLinks.filter((_, index) => index !== editingIndex);
      }
      return draftLinks.map((link, index) => index === editingIndex ? nextLink : link);
    })();

    setSaving(true);
    setSaveError(undefined);
    try {
      await updateSlotMeta({ links: nextLinks });
      setDraftLinks(nextLinks);
      setEditingIndex(null);
      setOverlayPosition(null);
      setDraftLink(createEmptyDraft(defaultTargetId, tabTargets.length > 0));
    } catch (err: unknown) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [defaultTargetId, draftLink, draftLinks, editingIndex, tabTargets.length, updateSlotMeta]);

  const commitAuthoredLink = useCallback(async (index: number, targetId: string) => {
    if (!updateSlotMeta) {
      throw new Error("Cannot save: this module is not running inside a slot.");
    }
    const current = draftLinks[index];
    if (!current) {
      throw new Error("Cannot find the selected link source.");
    }
    const nextLinks = draftLinks.map((link, linkIndex) => (
      linkIndex === index ? { text: link.text, targetId } : link
    ));
    await updateSlotMeta({ links: nextLinks });
    setDraftLinks(nextLinks);
  }, [draftLinks, updateSlotMeta]);

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
            <Fragment key={`${link.text}-${link.targetId ?? link.url ?? index}`}>
              {index > 0 && <div aria-hidden="true" style={dividerStyle} />}
              <LinkChip
                link={link}
                index={index}
                configId={config.id}
                editMode={editMode}
                linkStep={step}
                tabTargets={tabTargets}
                onChooseSource={() => chooseSource(getLinkSourceId(config.id, index))}
                onEdit={beginEdit}
                onNavigate={navigateToTarget}
                onCommitLink={commitAuthoredLink}
              />
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
          tabTargets={tabTargets}
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

function LinkChip({
  link,
  index,
  configId,
  editMode,
  linkStep,
  tabTargets,
  onChooseSource,
  onEdit,
  onNavigate,
  onCommitLink,
}: {
  link: LinkItem;
  index: number;
  configId: string;
  editMode: boolean;
  linkStep: "idle" | "select-source" | "source-selected" | "select-target" | "saving";
  tabTargets: TargetOption[];
  onChooseSource: () => void;
  onEdit: (index: number, event: MouseEvent<HTMLButtonElement>) => void;
  onNavigate: (targetId: string, options?: { highlightMs?: number }) => Promise<boolean>;
  onCommitLink: (index: number, targetId: string) => Promise<void>;
}) {
  const sourceId = getLinkSourceId(configId, index);
  const isSelectedSource = useIsLinkSourceSelected(sourceId);
  const isChoosingSource = editMode && linkStep === "select-source";

  useRegisterLinkSource(editMode ? {
    id: sourceId,
    label: link.text,
    commitLink: (targetId: string) => onCommitLink(index, targetId),
  } : null);

  if (editMode) {
    return (
      <button
        type="button"
        onClick={(event) => {
          if (linkStep === "select-source") {
            event.preventDefault();
            event.stopPropagation();
            onChooseSource();
            return;
          }
          if (linkStep !== "saving") {
            onEdit(index, event);
          }
        }}
        style={{
          ...linkControlStyle,
          boxShadow: isSelectedSource
            ? "inset 0 0 0 1px rgba(250, 204, 21, 0.95), 0 0 0 1px rgba(245, 158, 11, 0.42)"
            : isChoosingSource ? "inset 0 0 0 1px rgba(147, 197, 253, 0.55)" : undefined,
          color: isSelectedSource ? "#fde68a" : linkControlStyle.color,
        }}
        title={
          isSelectedSource
            ? `Selected source: ${link.text}`
            : linkStep === "select-source"
              ? `Choose ${link.text} as the source`
              : link.targetId ? `${link.text} -> ${resolveTargetLabel(link.targetId, tabTargets)}` : `${link.text} — ${link.url ?? ""}`
        }
      >
        {link.text}
      </button>
    );
  }

  if (link.targetId) {
    return (
      <button
        type="button"
        onClick={() => { void onNavigate(link.targetId!); }}
        style={linkControlStyle}
        title={`Open ${resolveTargetLabel(link.targetId, tabTargets)}`}
      >
        {link.text}
      </button>
    );
  }

  return (
    <a
      href={normalizeUrl(link.url ?? "")}
      target="_blank"
      rel="noreferrer"
      style={linkControlStyle}
    >
      {link.text}
    </a>
  );
}

function getLinkSourceId(configId: string, index: number): string {
  return `link-source:${configId}:${index}`;
}

function LinkEditor({
  draftLink,
  tabTargets,
  disabled,
  error,
  position,
  onChange,
  onSave,
  onCancel,
}: {
  draftLink: LinkDraft;
  tabTargets: TargetOption[];
  disabled: boolean;
  error: string | undefined;
  position: OverlayPosition;
  onChange: (link: LinkDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const canSave = draftLink.destinationType === "tab"
    ? Boolean(draftLink.text.trim()) && Boolean(draftLink.targetId.trim())
    : Boolean(draftLink.text.trim()) && Boolean(draftLink.url.trim());

  return (
    <div title={error} style={{ ...editorStyle, left: position.left, top: position.top }}>
      <input
        value={draftLink.text}
        onChange={(event) => onChange({ ...draftLink, text: event.target.value })}
        placeholder="Text"
        disabled={disabled}
        style={inputStyle}
      />
      <div style={toggleRowStyle}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ ...draftLink, destinationType: "tab", targetId: draftLink.targetId || tabTargets[0]?.id || "" })}
          style={{
            ...toggleButtonStyle,
            ...(draftLink.destinationType === "tab" ? toggleButtonActiveStyle : null),
          }}
        >
          Tab
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ ...draftLink, destinationType: "url" })}
          style={{
            ...toggleButtonStyle,
            ...(draftLink.destinationType === "url" ? toggleButtonActiveStyle : null),
          }}
        >
          URL
        </button>
      </div>
      {draftLink.destinationType === "tab" ? (
        <select
          value={draftLink.targetId}
          onChange={(event) => onChange({ ...draftLink, targetId: event.target.value })}
          disabled={disabled || tabTargets.length === 0}
          style={inputStyle}
        >
          {tabTargets.length === 0 ? (
            <option value="">No tabs available</option>
          ) : (
            tabTargets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.label}
              </option>
            ))
          )}
        </select>
      ) : (
        <input
          value={draftLink.url}
          onChange={(event) => onChange({ ...draftLink, url: event.target.value })}
          onKeyDown={(event) => { if (event.key === "Enter" && canSave) onSave(); }}
          placeholder="URL"
          disabled={disabled}
          style={inputStyle}
        />
      )}
      <div style={actionsRowStyle}>
        <button type="button" onClick={onSave} disabled={disabled || !canSave} style={primaryButtonStyle}>
          {disabled ? "..." : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={disabled} style={cancelButtonStyle}>
          Cancel
        </button>
      </div>
      {error && <div style={errorTextStyle}>{error}</div>}
    </div>
  );
}

function resolveTargetLabel(targetId: string, tabTargets: TargetOption[]): string {
  return tabTargets.find((target) => target.id === targetId)?.label ?? targetId;
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
  minHeight: "38px",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.45rem",
  padding: "0.55rem",
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

const toggleRowStyle: CSSProperties = {
  display: "flex",
  gap: "0.35rem",
};

const toggleButtonStyle: CSSProperties = {
  flex: 1,
  height: "28px",
  borderRadius: "999px",
  border: "1px solid rgba(148, 163, 184, 0.28)",
  background: "transparent",
  color: "#cbd5e1",
  cursor: "pointer",
  fontSize: "0.72rem",
  fontWeight: 700,
};

const toggleButtonActiveStyle: CSSProperties = {
  background: "rgba(56, 189, 248, 0.16)",
  borderColor: "rgba(56, 189, 248, 0.55)",
  color: "#e0f2fe",
};

const actionsRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.35rem",
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
  border: "1px solid rgba(148, 163, 184, 0.24)",
  borderRadius: "999px",
  background: "transparent",
  color: "#93c5fd",
  cursor: "pointer",
  fontWeight: 700,
  padding: "0 0.65rem",
  height: "28px",
  fontSize: "0.75rem",
};

const errorTextStyle: CSSProperties = {
  color: "#fca5a5",
  fontSize: "0.72rem",
  lineHeight: 1.3,
};
