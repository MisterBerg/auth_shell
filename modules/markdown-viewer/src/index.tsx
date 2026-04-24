import React, { useState, useCallback, useRef } from "react";
import type { ModuleProps } from "module-core";
import { useEditMode, useUpdateSlotMeta, useAwsS3Client } from "module-core";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { MarkdownPane } from "./MarkdownPane.tsx";
import type { MarkdownTab } from "./MarkdownPane.tsx";

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const C = {
  bg:     "#080f1c",
  border: "#1a2a42",
  text:   "#e5e7eb",
  muted:  "#6b7280",
  accent: "#3b82f6",
};

// ---------------------------------------------------------------------------
// Markdown reference crawler (unchanged)
// ---------------------------------------------------------------------------

function extractLocalRefs(content: string): string[] {
  const refs: string[] = [];
  let m: RegExpExecArray | null;
  const inline = /!?\[[^\]]*\]\(([^)\s"']+)/g;
  while ((m = inline.exec(content)) !== null) {
    const u = m[1];
    if (u && !/^(https?:|mailto:|#|data:)/i.test(u)) refs.push(u.split(/[?#]/)[0]);
  }
  const refDef = /^\s*\[[^\]]+\]:\s*([^\s"'<>\n]+)/gm;
  while ((m = refDef.exec(content)) !== null) {
    const u = m[1];
    if (u && !/^(https?:|mailto:|#|data:)/i.test(u)) refs.push(u.split(/[?#]/)[0]);
  }
  const htmlImg = /<img[^>]+src=["']([^"']+)["']/gi;
  while ((m = htmlImg.exec(content)) !== null) {
    const u = m[1];
    if (u && !/^(https?:|data:)/i.test(u)) refs.push(u.split(/[?#]/)[0]);
  }
  return refs;
}

function mdLog(message: string, details?: unknown) {
  if (details === undefined) {
    console.log(`[markdown-viewer] ${message}`);
    return;
  }
  console.log(`[markdown-viewer] ${message}`, details);
}

function decodePathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

function resolveRelativePath(basePath: string, ref: string): string {
  const normalizedRef = decodePathSegments(ref);
  const parts = basePath.split("/");
  parts.pop();
  for (const seg of normalizedRef.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

function splitDirAndName(path: string): { dir: string; name: string } {
  const parts = path.split("/");
  const name = parts.pop() ?? "";
  return { dir: parts.join("/"), name };
}

function fileStem(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function normalizeLoose(value: string): string {
  return value
    .toLowerCase()
    .replace(/%20/g, " ")
    .replace(/[_|]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function extractHtmlTitle(content: string): string | null {
  const match = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1]?.trim() || null;
}

async function resolveLocalFileRef(
  entryPath: string,
  ref: string,
  fileMap: Map<string, File>,
): Promise<{ requestedPath: string; sourcePath: string | null }> {
  const requestedPath = resolveRelativePath(entryPath, ref);
  if (fileMap.has(requestedPath)) {
    return { requestedPath, sourcePath: requestedPath };
  }

  const { dir, name } = splitDirAndName(requestedPath);
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (!ext) return { requestedPath, sourcePath: null };

  const requestedStem = normalizeLoose(fileStem(name));
  const directoryPrefix = dir ? `${dir}/` : "";
  const candidates = [...fileMap.keys()].filter((path) => {
    const candidate = splitDirAndName(path);
    return candidate.dir === dir && candidate.name.toLowerCase().endsWith(`.${ext}`);
  });

  for (const candidatePath of candidates) {
    const candidateName = splitDirAndName(candidatePath).name;
    const candidateStem = normalizeLoose(fileStem(candidateName));
    if (
      candidateStem === requestedStem ||
      candidateStem.includes(requestedStem) ||
      requestedStem.includes(candidateStem)
    ) {
      return { requestedPath, sourcePath: candidatePath };
    }
  }

  if (ext === "html" || ext === "htm") {
    for (const candidatePath of candidates) {
      const file = fileMap.get(candidatePath);
      if (!file) continue;
      try {
        const title = extractHtmlTitle(await file.text());
        if (!title) continue;
        const normalizedTitle = normalizeLoose(title);
        if (
          normalizedTitle === requestedStem ||
          normalizedTitle.includes(requestedStem) ||
          requestedStem.includes(normalizedTitle)
        ) {
          return { requestedPath, sourcePath: candidatePath };
        }
      } catch {
        // Ignore parse failures and keep searching.
      }
    }
  }

  return { requestedPath, sourcePath: null };
}

async function crawlMarkdown(
  entryPath: string,
  fileMap: Map<string, File>,
  reachable: Map<string, string> = new Map(),
  visitedMarkdown: Set<string> = new Set(),
): Promise<Map<string, string>> {
  if (visitedMarkdown.has(entryPath) || !fileMap.has(entryPath)) return reachable;
  visitedMarkdown.add(entryPath);
  reachable.set(entryPath, entryPath);
  if (/\.mdx?$/i.test(entryPath)) {
    const content = await fileMap.get(entryPath)!.text();
    const refs = extractLocalRefs(content);
    mdLog("crawling markdown entry", { entryPath, refCount: refs.length });
    for (const ref of refs) {
      const { requestedPath, sourcePath } = await resolveLocalFileRef(entryPath, ref, fileMap);
      const found = !!sourcePath;
      mdLog("resolved local ref", { entryPath, ref, resolved: requestedPath, sourcePath, found });
      if (!sourcePath) continue;
      reachable.set(requestedPath, sourcePath);
      if (/\.mdx?$/i.test(sourcePath)) {
        await crawlMarkdown(sourcePath, fileMap, reachable, visitedMarkdown);
      }
    }
  }
  return reachable;
}

// ---------------------------------------------------------------------------
// File System helpers
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
  const styleEl = popup.document.createElement("style");
  styleEl.textContent = (window as unknown as Record<string, unknown>)["__hepMdCss"] as string ?? "";
  popup.document.head.appendChild(styleEl);
  const root = popup.document.createElement("div");
  root.style.cssText = "height:100vh;overflow:auto";
  popup.document.body.appendChild(root);
  const ReactDOMClient = (window as unknown as Record<string, unknown>)["__ReactDOMClient"] as typeof import("react-dom/client") | undefined;
  const React = (window as unknown as Record<string, unknown>)["__React"] as typeof import("react");
  if (!ReactDOMClient?.createRoot) {
    popup.document.body.innerHTML = '<div style="font-family: system-ui, sans-serif; color: #fca5a5; padding: 1rem;">Markdown popout failed: ReactDOM client renderer is unavailable.</div>';
    return;
  }
  ReactDOMClient.createRoot(root).render(
    React.createElement(MarkdownPane, { tab, getS3Client }),
  );
}

// ---------------------------------------------------------------------------
// DropZone
// ---------------------------------------------------------------------------

type DropPhase =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "pick"; dirName: string; mdFiles: string[]; fileMap: Map<string, File> }
  | { kind: "crawling" }
  | { kind: "confirm"; entryPath: string; fileMap: Map<string, File>; reachable: Map<string, string> }
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
      setPhase({ kind: "error", message: "Drop a folder — the browser only grants access to files you explicitly drag, not their siblings." });
      return;
    }
    setPhase({ kind: "reading" });
    try {
      const fileMap = await readDirEntry(dirEntry);
      const mdFiles = [...fileMap.keys()]
        .filter((p) => /\.mdx?$/i.test(p))
        .sort((a, b) => {
          const aDepth = a.split("/").length;
          const bDepth = b.split("/").length;
          if (aDepth !== bDepth) return aDepth - bDepth;
          return a.localeCompare(b);
        });
      if (mdFiles.length === 0) {
        setPhase({ kind: "error", message: "No .md files found in the dropped folder." });
        return;
      }
      const rootMd   = mdFiles.filter((p) => !p.includes("/"));
      const readme   = rootMd.find((p) => /^readme\.mdx?$/i.test(p));
      const index    = rootMd.find((p) => /^index\.mdx?$/i.test(p));
      const autoEntry = readme ?? index ?? (rootMd.length === 1 ? rootMd[0] : undefined);
      if (autoEntry) {
        setPhase({ kind: "crawling" });
        const reachable = await crawlMarkdown(autoEntry, fileMap);
        mdLog("auto-selected markdown entry", {
          entryPath: autoEntry,
          reachableCount: reachable.size,
          reachable: [...reachable.keys()].sort(),
        });
        setPhase({ kind: "confirm", entryPath: autoEntry, fileMap, reachable });
      } else {
        mdLog("multiple possible markdown entries discovered", { mdFiles });
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
      mdLog("manually selected markdown entry", {
        entryPath,
        reachableCount: reachable.size,
        reachable: [...reachable.keys()].sort(),
      });
      setPhase({ kind: "confirm", entryPath, fileMap, reachable });
    } catch (err: unknown) {
      setPhase({ kind: "error", message: (err as Error).message });
    }
  }, []);

  const handleConfirm = useCallback(async (
    entryPath: string,
    fileMap: Map<string, File>,
    reachable: Map<string, string>,
  ) => {
    const files = [...reachable.entries()].map(([path, sourcePath]) => ({
      path,
      sourcePath,
      file: fileMap.get(sourcePath)!,
    }));
    mdLog("upload confirmed", {
      entryPath,
      totalFiles: files.length,
      files: files.map(({ path, sourcePath }) => ({ path, sourcePath })).sort((a, b) => a.path.localeCompare(b.path)),
    });
    let done = 0;
    try {
      const s3 = await getS3Client(bucket);
      for (const { path, file, sourcePath } of files) {
        setPhase({ kind: "uploading", done, total: files.length, current: path });
        const bytes = await file.arrayBuffer();
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: `${prefix}/${path}`,
          Body: new Uint8Array(bytes),
          ContentType: file.type || "application/octet-stream",
        }));
        if (path !== sourcePath) {
          mdLog("uploaded alias path", { path, sourcePath });
        }
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
        <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", width: "100%", maxWidth: 420, maxHeight: 320, overflowY: "auto" }}>
          {phase.mdFiles.map((path) => (
            <button key={path} onClick={() => handlePickEntry(path, phase.fileMap)}
              style={{ textAlign: "left", padding: "0.45rem 0.75rem", borderRadius: 6, border: `1px solid ${C.border}`, background: "transparent", color: C.text, cursor: "pointer", fontSize: "0.8rem", fontFamily: "monospace" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(59,130,246,0.08)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {path}
            </button>
          ))}
        </div>
        <button onClick={() => setPhase({ kind: "idle" })} style={{ fontSize: "0.8rem", background: "none", border: "none", color: C.muted, cursor: "pointer", textDecoration: "underline" }}>Cancel</button>
      </div>
    );
  }

  if (phase.kind === "confirm") {
    const uploadPaths = [...phase.reachable.keys()];
    const mdFiles    = uploadPaths.filter((p) => /\.mdx?$/i.test(p));
    const assetFiles = uploadPaths.filter((p) => !/\.mdx?$/i.test(p));
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1.25rem", padding: "2rem" }}>
        <p style={{ margin: 0, fontSize: "0.9rem", color: C.text, fontWeight: 500 }}>Ready to upload</p>
        <div style={{ background: "#0a1525", border: `1px solid ${C.border}`, borderRadius: 8, padding: "0.875rem 1.25rem", fontSize: "0.8rem", color: C.muted, maxWidth: 380, width: "100%", lineHeight: 1.8 }}>
          <div>Entry: <span style={{ color: C.accent, fontFamily: "monospace" }}>{phase.entryPath}</span></div>
          <div>{mdFiles.length} markdown file{mdFiles.length !== 1 ? "s" : ""}</div>
          <div>{assetFiles.length} asset{assetFiles.length !== 1 ? "s" : ""}</div>
        </div>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button onClick={() => handleConfirm(phase.entryPath, phase.fileMap, phase.reachable)}
            style={{ padding: "0.45rem 1.25rem", borderRadius: 6, border: "none", background: C.accent, color: "#fff", cursor: "pointer", fontSize: "0.875rem", fontWeight: 500 }}>
            Upload {uploadPaths.length} files
          </button>
          <button onClick={() => setPhase({ kind: "idle" })}
            style={{ padding: "0.45rem 0.9rem", borderRadius: 6, border: `1px solid ${C.border}`, background: "transparent", color: C.muted, cursor: "pointer", fontSize: "0.875rem" }}>
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

  // idle / error
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
        Drop your <strong>docs folder</strong> here.
      </p>
      <p style={{ margin: 0, fontSize: "0.75rem", color: "#374151", textAlign: "center", maxWidth: 320, lineHeight: 1.5 }}>
        Drop the folder containing your .md files. A single entry point is picked
        automatically (README/index) or chosen from a list. Only reachable files are uploaded.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root component — single pane, no tab management
// ---------------------------------------------------------------------------

export default function MarkdownViewer({ config }: ModuleProps) {
  const { editMode }   = useEditMode();
  const updateSlotMeta = useUpdateSlotMeta();
  const getS3Client    = useAwsS3Client();

  const params       = new URLSearchParams(window.location.search);
  const uploadBucket = params.get("bucket") ?? "";
  const configPath   = params.get("config") ?? "";
  const projectDir   = configPath.split("/").slice(0, -1).join("/");

  // Meta shape: { prefix: string, rootKey: string, bucket: string }
  // prefix is derived once from config.id (the slot ID) and never changes.
  const savedMeta = config.meta as { prefix?: string; rootKey?: string; bucket?: string } | undefined;
  const bucket    = savedMeta?.bucket || uploadBucket;
  // prefix is stable: computed from slotId on first upload, stored in meta
  const prefix    = savedMeta?.prefix ?? (projectDir ? `${projectDir}/docs/${config.id}` : `docs/${config.id}`);

  const [rootKey,   setRootKey]   = useState(savedMeta?.rootKey ?? "");
  const [replacing, setReplacing] = useState(false);

  const tab: MarkdownTab | undefined = rootKey
    ? { tabId: config.id, title: "", bucket, prefix, rootKey }
    : undefined;

  const handleUploaded = useCallback(async (newRootKey: string) => {
    setReplacing(false);
    setRootKey(newRootKey);
    const newMeta = { prefix, rootKey: newRootKey, bucket: uploadBucket };
    if (updateSlotMeta) {
      try { await updateSlotMeta(newMeta); } catch { /* non-fatal */ }
    }
  }, [prefix, uploadBucket, updateSlotMeta]);

  const showDrop = (!rootKey || replacing) && editMode;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: C.bg }}>
      {/* Toolbar — only shown when content is loaded */}
      {!showDrop && tab && (
        <div style={{ height: 36, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "0 0.75rem", gap: "0.5rem", borderBottom: `1px solid ${C.border}` }}>
          <button
            onClick={() => openPopout("Document", tab, getS3Client)}
            title="Open in new tab"
            style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: "0.75rem", padding: "2px 6px", borderRadius: 3 }}
          >
            ↗ Pop out
          </button>
          {editMode && (
            <button
              onClick={() => setReplacing(true)}
              title="Replace content"
              style={{ background: "none", border: `1px solid ${C.border}`, color: C.muted, cursor: "pointer", fontSize: "0.75rem", padding: "2px 8px", borderRadius: 3 }}
            >
              ↺ Replace
            </button>
          )}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        {showDrop ? (
          <DropZone
            prefix={prefix}
            bucket={uploadBucket || bucket}
            onUploaded={(rootKey) => handleUploaded(rootKey)}
          />
        ) : tab ? (
          <MarkdownPane tab={tab} getS3Client={getS3Client} />
        ) : (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: "0.875rem" }}>
            No content configured.
          </div>
        )}
      </div>
    </div>
  );
}
