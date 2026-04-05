import React, { useState, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { ModuleProps } from "module-core";
import { useEditMode, useUpdateSlotMeta, useAwsS3Client } from "module-core";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { MarkdownPane, MD_CSS } from "./MarkdownPane.tsx";
import type { MarkdownTab } from "./MarkdownPane.tsx";

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
// Markdown reference crawler
// ---------------------------------------------------------------------------

function extractLocalRefs(content: string): string[] {
  const refs: string[] = [];
  let m: RegExpExecArray | null;

  // Inline links/images: [text](url) or ![alt](url), optional title
  const inline = /!?\[[^\]]*\]\(([^)\s"']+)/g;
  while ((m = inline.exec(content)) !== null) {
    const u = m[1];
    if (u && !/^(https?:|mailto:|#|data:)/i.test(u)) refs.push(u.split(/[?#]/)[0]);
  }

  // Reference definitions: [id]: url
  const refDef = /^\s*\[[^\]]+\]:\s*([^\s"'<>\n]+)/gm;
  while ((m = refDef.exec(content)) !== null) {
    const u = m[1];
    if (u && !/^(https?:|mailto:|#|data:)/i.test(u)) refs.push(u.split(/[?#]/)[0]);
  }

  // HTML <img src="..."> (raw HTML inside markdown)
  const htmlImg = /<img[^>]+src=["']([^"']+)["']/gi;
  while ((m = htmlImg.exec(content)) !== null) {
    const u = m[1];
    if (u && !/^(https?:|data:)/i.test(u)) refs.push(u.split(/[?#]/)[0]);
  }

  return refs;
}

function resolveRelativePath(basePath: string, ref: string): string {
  const parts = basePath.split("/");
  parts.pop(); // remove filename, keep directory parts
  for (const seg of ref.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

async function crawlMarkdown(
  entryPath: string,
  fileMap: Map<string, File>,
  visited: Set<string> = new Set(),
): Promise<Set<string>> {
  if (visited.has(entryPath) || !fileMap.has(entryPath)) return visited;
  visited.add(entryPath);

  if (/\.mdx?$/i.test(entryPath)) {
    const content = await fileMap.get(entryPath)!.text();
    for (const ref of extractLocalRefs(content)) {
      const resolved = resolveRelativePath(entryPath, ref);
      if (fileMap.has(resolved)) {
        await crawlMarkdown(resolved, fileMap, visited);
      }
    }
  }

  return visited;
}

// ---------------------------------------------------------------------------
// File System helpers — read a directory entry recursively into a flat Map
// ---------------------------------------------------------------------------

async function readDirEntry(
  dir: FileSystemDirectoryEntry,
  prefix = "",
): Promise<Map<string, File>> {
  const result = new Map<string, File>();

  const readBatch = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
    new Promise((res, rej) => reader.readEntries(res, rej));

  const reader = dir.createReader();
  let batch: FileSystemEntry[];
  do {
    batch = await readBatch(reader);
    for (const child of batch) {
      const relPath = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isFile) {
        const file = await new Promise<File>((res, rej) =>
          (child as FileSystemFileEntry).file(res, rej),
        );
        result.set(relPath, file);
      } else if (child.isDirectory) {
        const sub = await readDirEntry(child as FileSystemDirectoryEntry, relPath);
        sub.forEach((f, p) => result.set(p, f));
      }
    }
  } while (batch.length > 0);

  return result;
}

// ---------------------------------------------------------------------------
// Popout — renders MarkdownPane into a new browser tab (shared JS context)
// ---------------------------------------------------------------------------

function openPopout(
  title: string,
  tab: MarkdownTab,
  getS3Client: (bucket?: string) => Promise<import("@aws-sdk/client-s3").S3Client>,
) {
  const popup = window.open("about:blank", "_blank");
  if (!popup) return;

  popup.document.title = title;
  popup.document.body.style.cssText = "margin:0;background:#080f1c;height:100vh";

  // Inject component styles into the popup's document
  const styleEl = popup.document.createElement("style");
  styleEl.textContent = MD_CSS;
  popup.document.head.appendChild(styleEl);

  const root = popup.document.createElement("div");
  root.style.cssText = "height:100vh;overflow:auto";
  popup.document.body.appendChild(root);

  createRoot(root).render(
    <MarkdownPane tab={tab} getS3Client={getS3Client} />,
  );
}

// ---------------------------------------------------------------------------
// DropZone — drop a single .md file; crawl references; upload reachable only
// ---------------------------------------------------------------------------

type DropPhase =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "pick"; dirName: string; mdFiles: string[]; fileMap: Map<string, File> }
  | { kind: "crawling" }
  | { kind: "confirm"; entryPath: string; fileMap: Map<string, File>; reachable: Set<string> }
  | { kind: "uploading"; done: number; total: number; current: string }
  | { kind: "error"; message: string };

interface DropZoneProps {
  prefix: string;
  bucket: string;
  onUploaded: (rootKey: string, suggestedTitle: string) => void;
}

function DropZone({ prefix, bucket, onUploaded }: DropZoneProps) {
  const getS3Client = useAwsS3Client();
  const [dragging, setDragging] = useState(false);
  const [phase,    setPhase]    = useState<DropPhase>({ kind: "idle" });

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);

    const items = Array.from(e.dataTransfer.items);
    const dirEntry = items
      .map((i) => i.webkitGetAsEntry())
      .find((entry): entry is FileSystemDirectoryEntry => entry?.isDirectory === true);

    if (!dirEntry) {
      setPhase({ kind: "error", message: "Drop a folder — the browser only grants access to files you explicitly drag, not their siblings. Drop the folder and choose your entry .md file from the list." });
      return;
    }

    setPhase({ kind: "reading" });
    try {
      const fileMap = await readDirEntry(dirEntry);
      const mdFiles = [...fileMap.keys()]
        .filter((p) => /\.mdx?$/i.test(p))
        .sort((a, b) => {
          // Root-level files first, then alphabetical
          const aDepth = a.split("/").length;
          const bDepth = b.split("/").length;
          if (aDepth !== bDepth) return aDepth - bDepth;
          return a.localeCompare(b);
        });

      if (mdFiles.length === 0) {
        setPhase({ kind: "error", message: "No .md files found in the dropped folder." });
        return;
      }

      // If exactly one root-level .md or a clear README/index, skip the picker
      const rootMd  = mdFiles.filter((p) => !p.includes("/"));
      const readme  = rootMd.find((p) => /^readme\.mdx?$/i.test(p));
      const index   = rootMd.find((p) => /^index\.mdx?$/i.test(p));
      const autoEntry = readme ?? index ?? (rootMd.length === 1 ? rootMd[0] : undefined);

      if (autoEntry) {
        setPhase({ kind: "crawling" });
        const reachable = await crawlMarkdown(autoEntry, fileMap);
        setPhase({ kind: "confirm", entryPath: autoEntry, fileMap, reachable });
      } else {
        setPhase({ kind: "pick", dirName: dirEntry.name, mdFiles, fileMap });
      }
    } catch (err: unknown) {
      setPhase({ kind: "error", message: (err as Error).message });
    }
  }, []);

  const handlePickEntry = useCallback(async (entryPath: string, fileMap: Map<string, File>) => {
    setPhase({ kind: "crawling" });
    try {
      const reachable = await crawlMarkdown(entryPath, fileMap);
      setPhase({ kind: "confirm", entryPath, fileMap, reachable });
    } catch (err: unknown) {
      setPhase({ kind: "error", message: (err as Error).message });
    }
  }, []);

  const handleConfirm = useCallback(async (
    entryPath: string,
    fileMap: Map<string, File>,
    reachable: Set<string>,
  ) => {
    const files = [...reachable].map((path) => ({ path, file: fileMap.get(path)! }));
    let done = 0;

    try {
      const s3 = await getS3Client(bucket);
      for (const { path, file } of files) {
        setPhase({ kind: "uploading", done, total: files.length, current: path });
        const bytes = await file.arrayBuffer();
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: `${prefix}/${path}`,
          Body: new Uint8Array(bytes),
          ContentType: file.type || "application/octet-stream",
        }));
        done++;
      }

      const rootKey        = `${prefix}/${entryPath}`;
      const suggestedTitle = entryPath.replace(/\.mdx?$/i, "").replace(/[-_]/g, " ");
      onUploaded(rootKey, suggestedTitle);
    } catch (err: unknown) {
      setPhase({ kind: "error", message: (err as Error).message });
    }
  }, [prefix, bucket, getS3Client, onUploaded]);

  if (phase.kind === "reading" || phase.kind === "crawling") {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: "0.875rem" }}>
        {phase.kind === "reading" ? "Reading directory…" : "Scanning references…"}
      </div>
    );
  }

  if (phase.kind === "pick") {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1rem", padding: "2rem", overflowY: "auto" }}>
        <p style={{ margin: 0, fontSize: "0.9rem", color: C.text, fontWeight: 500 }}>
          Choose the entry point for <span style={{ color: C.accent, fontFamily: "monospace" }}>{phase.dirName}</span>
        </p>
        <p style={{ margin: 0, fontSize: "0.75rem", color: C.muted }}>Which .md file is the top-level page?</p>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", width: "100%", maxWidth: 420, maxHeight: 320, overflowY: "auto" }}>
          {phase.mdFiles.map((path) => (
            <button
              key={path}
              onClick={() => handlePickEntry(path, phase.fileMap)}
              style={{
                textAlign: "left", padding: "0.45rem 0.75rem", borderRadius: 6,
                border: `1px solid ${C.border}`, background: "transparent",
                color: C.text, cursor: "pointer", fontSize: "0.8rem",
                fontFamily: "monospace",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(59,130,246,0.08)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {path}
            </button>
          ))}
        </div>
        <button onClick={() => setPhase({ kind: "idle" })} style={{ fontSize: "0.8rem", background: "none", border: "none", color: C.muted, cursor: "pointer", textDecoration: "underline" }}>
          Cancel
        </button>
      </div>
    );
  }

  if (phase.kind === "confirm") {
    const mdFiles    = [...phase.reachable].filter((p) => /\.mdx?$/i.test(p));
    const assetFiles = [...phase.reachable].filter((p) => !/\.mdx?$/i.test(p));
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1.25rem", padding: "2rem" }}>
        <p style={{ margin: 0, fontSize: "0.9rem", color: C.text, fontWeight: 500 }}>Ready to upload</p>
        <div style={{ background: "#0a1525", border: `1px solid ${C.border}`, borderRadius: 8, padding: "0.875rem 1.25rem", fontSize: "0.8rem", color: C.muted, maxWidth: 380, width: "100%", lineHeight: 1.8 }}>
          <div>Entry: <span style={{ color: C.accent, fontFamily: "monospace" }}>{phase.entryPath}</span></div>
          <div>{mdFiles.length} markdown file{mdFiles.length !== 1 ? "s" : ""}</div>
          <div>{assetFiles.length} asset{assetFiles.length !== 1 ? "s" : ""} (images, etc.)</div>
          <div style={{ marginTop: "0.25rem", color: "#374151", fontSize: "0.75rem" }}>
            Only files reachable via relative links are uploaded.
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button
            onClick={() => handleConfirm(phase.entryPath, phase.fileMap, phase.reachable)}
            style={{ padding: "0.45rem 1.25rem", borderRadius: 6, border: "none", background: C.accent, color: "#fff", cursor: "pointer", fontSize: "0.875rem", fontWeight: 500 }}
          >
            Upload {phase.reachable.size} files
          </button>
          <button
            onClick={() => setPhase({ kind: "idle" })}
            style={{ padding: "0.45rem 0.9rem", borderRadius: 6, border: `1px solid ${C.border}`, background: "transparent", color: C.muted, cursor: "pointer", fontSize: "0.875rem" }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === "uploading") {
    const pct = phase.total > 0 ? Math.round((phase.done / phase.total) * 100) : 0;
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1rem", padding: "2rem" }}>
        <div style={{ fontSize: "1.5rem" }}>⏫</div>
        <div style={{ width: 280, background: "#0a1525", border: `1px solid ${C.border}`, borderRadius: 6, overflow: "hidden" }}>
          <div style={{ height: 4, background: C.accent, width: `${pct}%`, transition: "width 0.2s" }} />
        </div>
        <p style={{ margin: 0, fontSize: "0.8rem", color: C.muted, textAlign: "center", maxWidth: 320, fontFamily: "monospace" }}>
          {phase.done} / {phase.total} — {phase.current}
        </p>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      style={{
        height: "100%", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", gap: "1rem",
        background: dragging ? "rgba(59,130,246,0.06)" : C.bg,
        border: `2px dashed ${dragging ? C.accent : C.border}`,
        borderRadius: 8, margin: "2rem",
        transition: "background 0.15s, border-color 0.15s",
      }}
    >
      {phase.kind === "error" && (
        <p style={{ margin: 0, fontSize: "0.8rem", color: "#fca5a5", textAlign: "center", maxWidth: 320 }}>
          {phase.message}
        </p>
      )}
      <div style={{ fontSize: "2.5rem", opacity: dragging ? 1 : 0.4 }}>📄</div>
      <p style={{ margin: 0, fontSize: "0.9rem", color: dragging ? C.text : C.muted, textAlign: "center", maxWidth: 360, lineHeight: 1.6 }}>
        Drop your <strong>entry .md file</strong> here.
      </p>
      <p style={{ margin: 0, fontSize: "0.75rem", color: "#374151", textAlign: "center", maxWidth: 320, lineHeight: 1.5 }}>
        The dropped file becomes the entry point. All files it links to (images,
        other .md pages) are discovered automatically and uploaded to S3.
        Files not reachable via links are ignored.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export default function MarkdownViewer({ config }: ModuleProps) {
  const { editMode }   = useEditMode();
  const updateSlotMeta = useUpdateSlotMeta();
  const getS3Client    = useAwsS3Client();

  const params        = new URLSearchParams(window.location.search);
  const uploadBucket  = params.get("bucket") ?? "";
  const configPath    = params.get("config") ?? "";
  // e.g. "projects/jeff-dev" — everything for this project lives here
  const projectDir    = configPath.split("/").slice(0, -1).join("/");

  const [tabs, setTabs] = useState<MarkdownTab[]>(
    () => (config.meta?.tabs as MarkdownTab[] | undefined) ?? [],
  );
  const [activeTabId,   setActiveTabId]   = useState<string | undefined>(
    () => ((config.meta?.tabs as MarkdownTab[] | undefined) ?? [])[0]?.tabId,
  );
  const [editingTabId,  setEditingTabId]  = useState<string | null>(null);
  const [tabDraft,      setTabDraft]      = useState("");
  const [replacing,     setReplacing]     = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const activeTab = tabs.find((t) => t.tabId === activeTabId);

  const saveTabs = useCallback(async (updated: MarkdownTab[]) => {
    setTabs(updated);
    if (updateSlotMeta) {
      try { await updateSlotMeta({ tabs: updated }); } catch { /* non-fatal */ }
    }
  }, [updateSlotMeta]);

  const addTab = useCallback(() => {
    const tabId  = `tab-${Date.now().toString(36)}`;
    // Prefix is computed once here and stored — it never changes after this point.
    const prefix = projectDir ? `${projectDir}/docs/${tabId}` : `docs/${tabId}`;
    const newTab: MarkdownTab = { tabId, title: "New Tab", bucket: uploadBucket, prefix, rootKey: "" };
    const updated = [...tabs, newTab];
    setActiveTabId(tabId);
    setEditingTabId(tabId);
    setTabDraft("New Tab");
    saveTabs(updated);
    setTimeout(() => titleInputRef.current?.select(), 50);
  }, [tabs, uploadBucket, projectDir, saveTabs]);

  const removeTab = useCallback((tabId: string) => {
    const updated = tabs.filter((t) => t.tabId !== tabId);
    setActiveTabId(updated[updated.length - 1]?.tabId);
    saveTabs(updated);
  }, [tabs, saveTabs]);

  const commitRename = useCallback((tabId: string) => {
    setEditingTabId(null);
    const trimmed = tabDraft.trim();
    if (!trimmed) return;
    saveTabs(tabs.map((t) => t.tabId === tabId ? { ...t, title: trimmed } : t));
  }, [tabs, tabDraft, saveTabs]);

  const handleUploaded = useCallback((tabId: string, rootKey: string, suggestedTitle: string) => {
    setReplacing(null);
    saveTabs(tabs.map((t) =>
      t.tabId !== tabId ? t : {
        ...t,
        rootKey,
        // Auto-rename from folder/file name only if still the default
        title: t.title === "New Tab" ? suggestedTitle : t.title,
      },
    ));
  }, [tabs, saveTabs]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: C.bg }}>

      {/* ── Tab bar ── */}
      <div style={{ display: "flex", alignItems: "stretch", background: C.bgBar, borderBottom: `1px solid ${C.border}`, height: 38, flexShrink: 0, overflowX: "auto" }}>
        {tabs.map((tab) => {
          const isActive = tab.tabId === activeTabId;
          return (
            <div
              key={tab.tabId}
              onClick={() => { setActiveTabId(tab.tabId); }}
              style={{
                display: "flex", alignItems: "center", gap: "0.35rem",
                padding: "0 0.75rem", flexShrink: 0, minWidth: 0, maxWidth: 180,
                background: isActive ? C.tabActive : "transparent",
                borderRight: `1px solid ${C.border}`,
                borderBottom: isActive ? `2px solid ${C.accent}` : "2px solid transparent",
                cursor: "pointer",
              }}
            >
              {editingTabId === tab.tabId ? (
                <input
                  ref={titleInputRef}
                  value={tabDraft}
                  onChange={(e) => setTabDraft(e.target.value)}
                  onBlur={() => commitRename(tab.tabId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")  { e.preventDefault(); commitRename(tab.tabId); }
                    if (e.key === "Escape") setEditingTabId(null);
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
                    setEditingTabId(tab.tabId);
                    setTabDraft(tab.title);
                    setTimeout(() => titleInputRef.current?.select(), 50);
                  }}
                  title={editMode ? "Double-click to rename" : tab.title}
                  style={{ fontSize: "0.8rem", color: isActive ? C.text : C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, cursor: editMode ? "text" : "pointer" }}
                >
                  {tab.title}
                </span>
              )}

              {isActive && tab.rootKey && (
                <button
                  onClick={(e) => { e.stopPropagation(); openPopout(tab.title, tab, getS3Client); }}
                  title="Open in new tab"
                  style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: "0.65rem", padding: "1px 3px", borderRadius: 3, flexShrink: 0 }}>
                  ↗
                </button>
              )}

              {editMode && isActive && tab.rootKey && (
                <button onClick={(e) => { e.stopPropagation(); setReplacing(tab.tabId); }}
                  title="Replace content"
                  style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: "0.65rem", padding: "1px 3px", borderRadius: 3, flexShrink: 0 }}>
                  ↺
                </button>
              )}

              {editMode && (
                <button onClick={(e) => { e.stopPropagation(); removeTab(tab.tabId); }}
                  title="Remove tab"
                  style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: "0.65rem", padding: "1px 3px", borderRadius: 3, flexShrink: 0 }}>
                  ✕
                </button>
              )}
            </div>
          );
        })}

        {editMode && (
          <button onClick={addTab} title="Add tab"
            style={{ padding: "0 0.75rem", background: "transparent", border: "none", borderRight: `1px solid ${C.border}`, color: C.muted, cursor: "pointer", fontSize: "1rem", flexShrink: 0 }}>
            +
          </button>
        )}
      </div>

      {/* ── Content ── */}
      <div style={{ flex: 1, minHeight: 0 }}>
        {!activeTab ? (
          <EmptyState editMode={editMode} onAdd={editMode ? addTab : undefined} />
        ) : (replacing === activeTab.tabId || !activeTab.rootKey) ? (
          <DropZone
            prefix={activeTab.prefix}
            bucket={activeTab.bucket || uploadBucket}
            onUploaded={(rootKey, title) => handleUploaded(activeTab.tabId, rootKey, title)}
          />
        ) : (
          <MarkdownPane
            tab={activeTab}
            getS3Client={getS3Client}
          />
        )}
      </div>
    </div>
  );
}

function EmptyState({ editMode, onAdd }: { editMode: boolean; onAdd?: () => void }) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "0.75rem", color: C.muted }}>
      {editMode ? (
        <>
          <p style={{ margin: 0, fontSize: "0.9rem" }}>No tabs yet.</p>
          <button onClick={onAdd} style={{ padding: "0.4rem 1rem", borderRadius: 6, border: `1px dashed ${C.border}`, background: "transparent", color: C.accent, cursor: "pointer", fontSize: "0.875rem" }}>
            + Add a tab
          </button>
        </>
      ) : (
        <p style={{ margin: 0, fontSize: "0.875rem" }}>No documentation configured.</p>
      )}
    </div>
  );
}
