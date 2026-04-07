import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExportContext, ModuleProps } from "module-core";
import {
  AuthProvider,
  useAuthContext,
  useAwsS3Client,
  useEditMode,
  useUpdateSlotMeta,
} from "module-core";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  assignPaths,
  createLinkedPage,
  copyObjectIfExists,
  deleteObjectIfExists,
  extractMediaRelativePaths,
  getDocKey,
  getMediaKey,
  getRelativePath,
  getStorageConfig,
  insertDocAtCursor,
  loadDocumentationState,
  moveDoc,
  readOptionalTextObject,
  renameDoc,
  removeDoc,
  rewriteDocLinksForExport,
  type ContentMap,
  type DocumentationManifest,
  type StorageConfig,
  type LinkAction,
  type MoveDirection,
  wrapSelection,
  writeBinaryObject,
  writeTextObject,
} from "./model.ts";

type SaveState = "idle" | "saving" | "saved" | "error";
const COLORS = {
  bg: "#080f1c",
  bgPanel: "#0b1525",
  bgToolbar: "#0d1a2e",
  bgInput: "#091322",
  border: "#1a2a42",
  text: "#e5e7eb",
  muted: "#6b7280",
  accent: "#3b82f6",
  success: "#22c55e",
  error: "#fca5a5",
  selected: "#11233a",
};

const mediaBlobCache = new Map<string, string>();

function safeMediaName(file: File): string {
  const dot = file.name.lastIndexOf(".");
  const base = (dot > 0 ? file.name.slice(0, dot) : file.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 44) || "media";
  const ext = dot > 0 ? file.name.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, "") : "";
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${base}${ext}`;
}

function contentTypeForPath(path: string): string {
  const ext = path.split(/[?#]/)[0].toLowerCase().split(".").pop() ?? "";
  const types: Record<string, string> = {
    apng: "image/apng",
    avif: "image/avif",
    gif: "image/gif",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    wav: "audio/wav",
    pdf: "application/pdf",
  };
  return types[ext] ?? "application/octet-stream";
}

function mediaKind(path: string, contentType = contentTypeForPath(path)): "image" | "video" | "audio" | "file" {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return "file";
}

function useDebouncedEffect(
  effect: () => void | (() => void),
  deps: React.DependencyList,
  delayMs: number
) {
  useEffect(() => {
    const handle = window.setTimeout(() => {
      effect();
    }, delayMs);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, delayMs]);
}

function centeredStyle(color = COLORS.muted): React.CSSProperties {
  return {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: COLORS.bg,
    color,
    fontFamily: "system-ui, -apple-system, sans-serif",
  };
}

function ToolbarButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: COLORS.bgInput,
        border: `1px solid ${COLORS.border}`,
        color: COLORS.text,
        borderRadius: 6,
        padding: "0.35rem 0.7rem",
        cursor: "pointer",
        fontSize: "0.8rem",
      }}
    >
      {label}
    </button>
  );
}

function SmallActionButton({
  onClick,
  label,
  disabled,
  danger,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: "transparent",
        border: `1px solid ${danger ? "#7f1d1d" : COLORS.border}`,
        color: disabled ? "#374151" : danger ? "#fca5a5" : COLORS.text,
        borderRadius: 6,
        padding: "0.35rem 0.55rem",
        cursor: disabled ? "default" : "pointer",
        fontSize: "0.76rem",
      }}
    >
      {label}
    </button>
  );
}

function isExternalHref(href: string): boolean {
  return /^(https?:|mailto:|data:)/i.test(href);
}

function resolveRelativeHref(fromRelativePath: string, href: string): string | null {
  if (!href || isExternalHref(href)) return null;
  const normalizedHref = href.split(/[?#]/)[0];
  const baseParts = fromRelativePath.split("/");
  baseParts.pop();
  const resolved = [...baseParts];

  for (const part of normalizedHref.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }

  return resolved.join("/");
}

function findLinkedDocId(
  manifest: DocumentationManifest,
  currentDocId: string,
  href: string | undefined
): string | null {
  if (!href) return null;
  if (href.startsWith("doc://") || href.startsWith("#doc:")) {
    const docId = href.replace("doc://", "").replace("#doc:", "");
    return manifest.docs[docId] ? docId : null;
  }

  const currentDoc = manifest.docs[currentDocId];
  if (!currentDoc) return null;
  const resolvedPath = resolveRelativeHref(currentDoc.relativePath, href);
  if (!resolvedPath) return null;

  const match = Object.values(manifest.docs).find((doc) => doc.relativePath === resolvedPath);
  return match?.id ?? null;
}

function resolveMediaRelativePath(
  manifest: DocumentationManifest,
  currentDocId: string,
  href: string | undefined
): string | null {
  if (!href || isExternalHref(href)) return null;
  const currentDoc = manifest.docs[currentDocId];
  if (!currentDoc) return null;
  const resolvedPath = resolveRelativeHref(currentDoc.relativePath, href);
  if (!resolvedPath?.startsWith("media/")) return null;
  return resolvedPath.slice("media/".length);
}

function DocumentationMedia({
  href,
  alt,
  manifest,
  currentDocId,
  storage,
}: {
  href?: string;
  alt?: string;
  manifest: DocumentationManifest;
  currentDocId: string;
  storage: StorageConfig;
}) {
  const getS3Client = useAwsS3Client();
  const [url, setUrl] = useState<string | "loading" | "error">("loading");
  const mediaRelativePath = resolveMediaRelativePath(manifest, currentDocId, href);

  useEffect(() => {
    if (!mediaRelativePath) {
      setUrl("error");
      return;
    }

    const key = getMediaKey(storage, mediaRelativePath);
    const cacheKey = `${storage.bucket}:${key}`;
    const cached = mediaBlobCache.get(cacheKey);
    if (cached) {
      setUrl(cached);
      return;
    }

    let cancelled = false;
    getS3Client(storage.bucket)
      .then((s3) => s3.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key })))
      .then((response) => response.Body!.transformToByteArray())
      .then((bytes) => {
        if (cancelled) return;
        const blob = new Blob([bytes.buffer as ArrayBuffer], {
          type: contentTypeForPath(mediaRelativePath),
        });
        const blobUrl = URL.createObjectURL(blob);
        mediaBlobCache.set(cacheKey, blobUrl);
        setUrl(blobUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl("error");
      });

    return () => {
      cancelled = true;
    };
  }, [getS3Client, mediaRelativePath, storage]);

  if (!mediaRelativePath) return null;
  if (url === "loading") {
    return <em style={{ color: COLORS.muted, fontSize: "0.85em" }}>[{alt ?? mediaRelativePath} loading...]</em>;
  }
  if (url === "error") {
    return <em style={{ color: COLORS.muted, fontSize: "0.85em" }}>[{alt ?? mediaRelativePath} unavailable]</em>;
  }

  const kind = mediaKind(mediaRelativePath);
  if (kind === "image") {
    return <img src={url} alt={alt ?? ""} style={{ maxWidth: "100%", borderRadius: 8 }} />;
  }
  if (kind === "video") {
    return <video src={url} controls style={{ maxWidth: "100%", borderRadius: 8 }} />;
  }
  if (kind === "audio") {
    return <audio src={url} controls style={{ width: "100%" }} />;
  }

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: COLORS.accent }}>
      {alt || mediaRelativePath.split("/").pop() || "Open media"}
    </a>
  );
}

function DocumentationLink({
  href,
  children,
  manifest,
  currentDocId,
  onNavigateDoc,
  storage,
}: {
  href?: string;
  children?: React.ReactNode;
  manifest: DocumentationManifest;
  currentDocId: string;
  onNavigateDoc: (docId: string) => void;
  storage: StorageConfig;
}) {
  if (!href) return <>{children}</>;

  if (resolveMediaRelativePath(manifest, currentDocId, href)) {
    return (
      <DocumentationMedia
        href={href}
        alt={typeof children === "string" ? children : undefined}
        manifest={manifest}
        currentDocId={currentDocId}
        storage={storage}
      />
    );
  }

  const linkedDocId = findLinkedDocId(manifest, currentDocId, href);
  if (isExternalHref(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: COLORS.accent }}>
        {children}
      </a>
    );
  }

  return (
    <a
      href="#"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (linkedDocId) {
          onNavigateDoc(linkedDocId);
        }
      }}
      style={{ color: linkedDocId ? COLORS.accent : COLORS.muted, cursor: linkedDocId ? "pointer" : "default" }}
      title={linkedDocId ? undefined : "This documentation link could not be resolved"}
    >
      {children}
    </a>
  );
}

function DocumentationBody({
  manifest,
  currentDocId,
  currentContent,
  onNavigateDoc,
  storage,
}: {
  manifest: DocumentationManifest;
  currentDocId: string;
  currentContent: string;
  onNavigateDoc: (docId: string) => void;
  storage: StorageConfig;
}) {
  const renderContent = currentContent.replace(/\]\(doc:\/\/([a-z0-9-]+)\)/gi, "](#doc:$1)");

  return (
    <article style={{ maxWidth: 860, color: COLORS.text }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => (
            <DocumentationLink
              href={props.href}
              manifest={manifest}
              currentDocId={currentDocId}
              onNavigateDoc={onNavigateDoc}
              storage={storage}
            >
              {props.children}
            </DocumentationLink>
          ),
          img: (props) => (
            <DocumentationMedia
              href={props.src}
              alt={props.alt}
              manifest={manifest}
              currentDocId={currentDocId}
              storage={storage}
            />
          ),
          code: ({ className, children, ...props }) => {
            const inline = !className;
            return inline ? (
              <code style={{ background: COLORS.bgInput, padding: "0.1rem 0.35rem", borderRadius: 4 }} {...props}>
                {children}
              </code>
            ) : (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre style={{ background: COLORS.bgInput, padding: "0.9rem", borderRadius: 8, overflowX: "auto", border: `1px solid ${COLORS.border}` }}>
              {children}
            </pre>
          ),
        }}
      >
        {renderContent}
      </ReactMarkdown>
    </article>
  );
}

function DocumentationPopout({
  initialManifest,
  initialContents,
  initialDocId,
  label,
  storage,
}: {
  initialManifest: DocumentationManifest;
  initialContents: ContentMap;
  initialDocId: string;
  label: string;
  storage: StorageConfig;
}) {
  const [currentDocId, setCurrentDocId] = useState(initialDocId);
  const currentDoc = initialManifest.docs[currentDocId] ?? initialManifest.docs[initialManifest.rootDocId];
  const currentContent = initialContents[currentDoc.id] ?? "";
  const tree = useMemo(() => {
    const walk = (docId: string, depth: number): Array<{ id: string; depth: number }> => {
      const doc = initialManifest.docs[docId];
      if (!doc) return [];
      const nodes = [{ id: docId, depth }];
      for (const childId of doc.children) nodes.push(...walk(childId, depth + 1));
      return nodes;
    };
    return walk(initialManifest.rootDocId, 0);
  }, [initialManifest]);

  return (
    <div style={{ display: "flex", height: "100vh", minHeight: 0, background: COLORS.bg, color: COLORS.text, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <aside style={{ width: 260, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: `1px solid ${COLORS.border}`, background: COLORS.bgPanel }}>
        <div style={{ padding: "0.9rem 1rem", borderBottom: `1px solid ${COLORS.border}` }}>
          <div style={{ fontSize: "0.75rem", color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>Documentation</div>
          <div style={{ marginTop: "0.35rem", fontSize: "0.95rem", fontWeight: 600 }}>{label}</div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0.5rem" }}>
          {tree.map(({ id, depth }) => {
            const doc = initialManifest.docs[id];
            const selected = id === currentDoc.id;
            return (
              <button
                key={id}
                onClick={() => setCurrentDocId(id)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  background: selected ? COLORS.selected : "transparent",
                  color: selected ? "#93c5fd" : COLORS.text,
                  border: "none",
                  borderRadius: 6,
                  padding: "0.45rem 0.6rem",
                  paddingLeft: `${0.6 + depth * 1.1}rem`,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.45rem",
                  fontSize: "0.84rem",
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: selected ? COLORS.accent : COLORS.muted, flexShrink: 0 }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.title}</span>
              </button>
            );
          })}
        </div>
      </aside>
      <section style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "0.7rem 0.9rem", borderBottom: `1px solid ${COLORS.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: "1rem", fontWeight: 600 }}>{currentDoc.title}</div>
            <div style={{ marginTop: "0.2rem", fontSize: "0.75rem", color: COLORS.muted, fontFamily: "monospace" }}>
              doc://{currentDoc.id} · {currentDoc.relativePath}
            </div>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", padding: "1rem 1.25rem" }}>
          <DocumentationBody
            manifest={initialManifest}
            currentDocId={currentDoc.id}
            currentContent={currentContent}
            onNavigateDoc={setCurrentDocId}
            storage={storage}
          />
        </div>
      </section>
    </div>
  );
}

export default function DocumentationViewer({ config }: ModuleProps) {
  const getS3Client = useAwsS3Client();
  const auth = useAuthContext();
  const { editMode } = useEditMode();
  const updateSlotMeta = useUpdateSlotMeta();
  const storage = useMemo(() => getStorageConfig(config), [config]);
  const hasPersistedStorageMeta =
    (config.meta?.["storageBucket"] as string | undefined) === storage.bucket &&
    (config.meta?.["manifestKey"] as string | undefined) === storage.manifestKey &&
    (config.meta?.["pagesPrefix"] as string | undefined) === storage.pagesPrefix;
  const rootTitle =
    (config.meta?.["title"] as string | undefined) ??
    (config.meta?.["name"] as string | undefined) ??
    "Documentation";

  const [manifest, setManifest] = useState<DocumentationManifest | null>(null);
  const [contents, setContents] = useState<ContentMap>({});
  const [currentDocId, setCurrentDocId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [statusMessage, setStatusMessage] = useState<string | undefined>();
  const [needsInitialPersist, setNeedsInitialPersist] = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(rootTitle);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const loadedRef = useRef(false);
  const prevEditModeRef = useRef(editMode);
  const manifestRef = useRef<DocumentationManifest | null>(null);
  const contentsRef = useRef<ContentMap>({});
  manifestRef.current = manifest;
  contentsRef.current = contents;

  const persistMeta = useCallback(async () => {
    if (!updateSlotMeta || hasPersistedStorageMeta) return;
    try {
      await updateSlotMeta({
        storageBucket: storage.bucket,
        manifestKey: storage.manifestKey,
        pagesPrefix: storage.pagesPrefix,
      });
    } catch {
      // best effort
    }
  }, [
    hasPersistedStorageMeta,
    storage.bucket,
    storage.manifestKey,
    storage.pagesPrefix,
    updateSlotMeta,
  ]);

  useEffect(() => {
    void persistMeta();
  }, [persistMeta]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);

    getS3Client(storage.bucket)
      .then((s3) => loadDocumentationState(s3, storage, rootTitle))
      .then((state) => {
        if (cancelled) return;
        setManifest(state.manifest);
        setContents(state.contents);
        setCurrentDocId(state.manifest.rootDocId);
        setNeedsInitialPersist(state.needsInitialPersist);
        loadedRef.current = true;
        setLoading(false);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError((loadError as Error).message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    getS3Client,
    rootTitle,
    storage.bucket,
    storage.manifestKey,
    storage.pagesPrefix,
  ]);

  const saveManifest = useCallback(
    async (nextManifest: DocumentationManifest) => {
      const s3 = await getS3Client(storage.bucket);
      await writeTextObject(
        s3,
        storage.bucket,
        storage.manifestKey,
        JSON.stringify(nextManifest, null, 2),
        "application/json"
      );
    },
    [getS3Client, storage]
  );

  const saveDocContent = useCallback(
    async (docId: string, content: string, activeManifest?: DocumentationManifest) => {
      const targetManifest = activeManifest ?? manifestRef.current;
      if (!targetManifest) return;
      const doc = targetManifest.docs[docId];
      if (!doc) return;

      const s3 = await getS3Client(storage.bucket);
      await writeTextObject(
        s3,
        storage.bucket,
        getDocKey(storage, doc.relativePath),
        content,
        "text/markdown; charset=utf-8"
      );
    },
    [getS3Client, storage]
  );

  const flushCurrentDocument = useCallback(async () => {
    const activeManifest = manifestRef.current;
    const activeDocId = currentDocId;
    if (!loadedRef.current || !activeManifest || !activeDocId) return;

    const activeContent = contentsRef.current[activeDocId] ?? "";
    setSaveState("saving");
    try {
      await saveDocContent(activeDocId, activeContent, activeManifest);
      setSaveState("saved");
      setStatusMessage("Saved");
    } catch (saveError: unknown) {
      setSaveState("error");
      setStatusMessage((saveError as Error).message);
    }
  }, [currentDocId, saveDocContent]);

  const syncStructure = useCallback(
    async (
      previousManifest: DocumentationManifest,
      nextManifest: DocumentationManifest,
      nextContents: ContentMap
    ) => {
      const s3 = await getS3Client(storage.bucket);
      const previousKeys = new Set(
        Object.values(previousManifest.docs).map((doc) => getDocKey(storage, doc.relativePath))
      );
      const nextKeys = new Set(
        Object.values(nextManifest.docs).map((doc) => getDocKey(storage, doc.relativePath))
      );

      for (const doc of Object.values(nextManifest.docs)) {
        await writeTextObject(
          s3,
          storage.bucket,
          getDocKey(storage, doc.relativePath),
          nextContents[doc.id] ?? `# ${doc.title}\n\n`,
          "text/markdown; charset=utf-8"
        );
      }

      for (const key of previousKeys) {
        if (!nextKeys.has(key)) {
          await deleteObjectIfExists(s3, storage.bucket, key);
        }
      }

      await writeTextObject(
        s3,
        storage.bucket,
        storage.manifestKey,
        JSON.stringify(nextManifest, null, 2),
        "application/json"
      );
    },
    [getS3Client, storage]
  );

  useEffect(() => {
    if (!needsInitialPersist || !manifest) return;
    let cancelled = false;
    setSaveState("saving");
    syncStructure(manifest, manifest, contents)
      .then(() => {
        if (cancelled) return;
        setNeedsInitialPersist(false);
        setSaveState("saved");
        setStatusMessage("Saved");
      })
      .catch((saveError: unknown) => {
        if (cancelled) return;
        setSaveState("error");
        setStatusMessage((saveError as Error).message);
      });

    return () => {
      cancelled = true;
    };
  }, [contents, manifest, needsInitialPersist, syncStructure]);

  const currentDoc = manifest?.docs[currentDocId];
  const currentContent = currentDocId ? contents[currentDocId] ?? "" : "";

  useDebouncedEffect(
    () => {
      if (!loadedRef.current || !manifest || !currentDocId) return;
      setSaveState("saving");
      saveDocContent(currentDocId, contents[currentDocId] ?? "", manifest)
        .then(() => {
          setSaveState("saved");
          setStatusMessage("Saved");
        })
        .catch((saveError: unknown) => {
          setSaveState("error");
          setStatusMessage((saveError as Error).message);
        });
    },
    [contents[currentDocId], currentDocId, manifest, saveDocContent],
    700
  );

  useEffect(() => {
    const wasEditing = prevEditModeRef.current;
    prevEditModeRef.current = editMode;
    if (wasEditing && !editMode) {
      void flushCurrentDocument();
    }
  }, [editMode, flushCurrentDocument]);

  const updateCurrentContent = useCallback(
    (nextValue: string) => {
      setContents((prev) => ({ ...prev, [currentDocId]: nextValue }));
      setSaveState("idle");
    },
    [currentDocId]
  );

  const applyFormatting = useCallback(
    (before: string, after: string, placeholder: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const result = wrapSelection(
        currentContent,
        textarea.selectionStart,
        textarea.selectionEnd,
        before,
        after,
        placeholder
      );
      updateCurrentContent(result.nextValue);
      window.requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(result.nextSelectionStart, result.nextSelectionEnd);
      });
    },
    [currentContent, updateCurrentContent]
  );

  const insertBlock = useCallback(
    (text: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const result = insertDocAtCursor(
        currentContent,
        textarea.selectionStart,
        textarea.selectionEnd,
        text
      );
      updateCurrentContent(result.nextValue);
      window.requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(result.nextSelectionStart, result.nextSelectionEnd);
      });
    },
    [currentContent, updateCurrentContent]
  );

  const uploadMediaFiles = useCallback(
    async (files: File[]) => {
      if (!currentDoc || files.length === 0) return;
      const s3 = await getS3Client(storage.bucket);
      const inserted: string[] = [];

      setSaveState("saving");
      setStatusMessage(`Uploading ${files.length} media file${files.length === 1 ? "" : "s"}...`);

      try {
        for (const file of files) {
          const filename = safeMediaName(file);
          const key = getMediaKey(storage, filename);
          const bytes = new Uint8Array(await file.arrayBuffer());
          await writeBinaryObject(
            s3,
            storage.bucket,
            key,
            bytes,
            file.type || contentTypeForPath(file.name)
          );

          const mediaDocPath = `media/${filename}`;
          const href = getRelativePath(currentDoc.relativePath, mediaDocPath);
          const label = file.name.replace(/\.[^.]+$/, "") || filename;
          inserted.push(
            mediaKind(file.name, file.type || contentTypeForPath(file.name)) === "file"
              ? `[${file.name}](${href})`
              : `![${label}](${href})`
          );
        }

        const textarea = textareaRef.current;
        const selectionStart = textarea?.selectionStart ?? currentContent.length;
        const selectionEnd = textarea?.selectionEnd ?? currentContent.length;
        const insertion = `\n\n${inserted.join("\n\n")}\n\n`;
        const result = insertDocAtCursor(
          currentContent,
          selectionStart,
          selectionEnd,
          insertion
        );
        updateCurrentContent(result.nextValue);
        setSaveState("saved");
        setStatusMessage(`Uploaded ${files.length} media file${files.length === 1 ? "" : "s"}`);

        window.requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(
            result.nextSelectionStart,
            result.nextSelectionEnd
          );
        });
      } catch (uploadError: unknown) {
        setSaveState("error");
        setStatusMessage((uploadError as Error).message);
      }
    },
    [currentContent, currentDoc, getS3Client, storage, updateCurrentContent]
  );

  const createLinkedDocument = useCallback(
    async (action: LinkAction) => {
      if (!manifest || !currentDocId) return;
      const title = window
        .prompt(
          action === "child" ? "Title for the new child page" : "Title for the new sibling page",
          "New Page"
        )
        ?.trim();
      if (!title) return;

      const previousManifest = manifest;
      const created = createLinkedPage(manifest, contents, currentDocId, title, action);
      const textarea = textareaRef.current;
      const linkText = `[${title}](#doc:${created.newDocId})`;
      const selectionStart = textarea?.selectionStart ?? currentContent.length;
      const selectionEnd = textarea?.selectionEnd ?? currentContent.length;
      const linkInsertion = insertDocAtCursor(
        currentContent,
        selectionStart,
        selectionEnd,
        linkText
      );
      const patchedContents = {
        ...created.contents,
        [currentDocId]: linkInsertion.nextValue,
      };

      setManifest(created.manifest);
      setContents(patchedContents);
      setSaveState("saving");

      try {
        await syncStructure(previousManifest, created.manifest, patchedContents);
        setSaveState("saved");
        setStatusMessage(`Created "${title}"`);
      } catch (saveError: unknown) {
        setSaveState("error");
        setStatusMessage((saveError as Error).message);
        return;
      }

      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(
          linkInsertion.nextSelectionStart,
          linkInsertion.nextSelectionEnd
        );
      });
    },
    [contents, currentContent, currentDocId, manifest, syncStructure]
  );

  const renameCurrentPage = useCallback(async () => {
    if (!manifest || !currentDocId || currentDocId === manifest.rootDocId) return;
    const title = window.prompt("Rename page", manifest.docs[currentDocId].title)?.trim();
    if (!title) return;

    const nextManifest = renameDoc(manifest, currentDocId, title);
    setManifest(nextManifest);
    setSaveState("saving");
    try {
      await saveManifest(nextManifest);
      setSaveState("saved");
      setStatusMessage(`Renamed to "${title}"`);
    } catch (saveError: unknown) {
      setSaveState("error");
      setStatusMessage((saveError as Error).message);
    }
  }, [currentDocId, manifest, saveManifest]);

  const deleteCurrentPage = useCallback(async () => {
    if (!manifest || !currentDocId || currentDocId === manifest.rootDocId) return;
    const confirmed = window.confirm(`Delete "${manifest.docs[currentDocId].title}" and its child pages?`);
    if (!confirmed) return;

    const previousManifest = manifest;
    const removed = removeDoc(manifest, contents, currentDocId);
    setManifest(removed.manifest);
    setContents(removed.contents);
    setCurrentDocId(removed.nextSelectedId);
    setSaveState("saving");

    try {
      await syncStructure(previousManifest, removed.manifest, removed.contents);
      setSaveState("saved");
      setStatusMessage("Page removed");
    } catch (saveError: unknown) {
      setSaveState("error");
      setStatusMessage((saveError as Error).message);
    }
  }, [contents, currentDocId, manifest, syncStructure]);

  const moveCurrentPage = useCallback(
    async (direction: MoveDirection) => {
      if (!manifest || !currentDocId || currentDocId === manifest.rootDocId) return;
      const nextManifest = moveDoc(manifest, currentDocId, direction);
      setManifest(nextManifest);
      setSaveState("saving");
      try {
        await syncStructure(manifest, nextManifest, contents);
        setSaveState("saved");
        setStatusMessage("Navigation updated");
      } catch (saveError: unknown) {
        setSaveState("error");
        setStatusMessage((saveError as Error).message);
      }
    },
    [contents, currentDocId, manifest, syncStructure]
  );

  const tree = useMemo(() => {
    if (!manifest) return [] as Array<{ id: string; depth: number }>;
    const walk = (docId: string, depth: number): Array<{ id: string; depth: number }> => {
      const doc = manifest.docs[docId];
      if (!doc) return [];
      const nodes = [{ id: docId, depth }];
      for (const childId of doc.children) nodes.push(...walk(childId, depth + 1));
      return nodes;
    };
    return walk(manifest.rootDocId, 0);
  }, [manifest]);

  useEffect(() => {
    if (!editingLabel) {
      setLabelDraft(rootTitle);
    }
  }, [editingLabel, rootTitle]);

  const saveLabel = useCallback(async () => {
    const nextTitle = labelDraft.trim();
    setEditingLabel(false);
    if (!nextTitle || !updateSlotMeta || nextTitle === rootTitle) return;
    try {
      await updateSlotMeta({ title: nextTitle });
    } catch (saveError: unknown) {
      setSaveState("error");
      setStatusMessage((saveError as Error).message);
    }
  }, [labelDraft, rootTitle, updateSlotMeta]);

  const openPopout = useCallback(() => {
    if (!manifest) return;
    const popup = window.open("about:blank", "_blank");
    if (!popup) return;
    popup.document.title = rootTitle;
    popup.document.body.style.cssText = "margin:0;background:#080f1c;height:100vh";
    const root = popup.document.createElement("div");
    root.style.cssText = "height:100vh";
    popup.document.body.appendChild(root);
    const ReactDOM = (window as unknown as Record<string, unknown>)["__ReactDOM"] as typeof import("react-dom/client");
    const ReactGlobal = (window as unknown as Record<string, unknown>)["__React"] as typeof import("react");
    ReactDOM.createRoot(root).render(
      ReactGlobal.createElement(
        AuthProvider,
        {
          awsCredentialProvider: auth.awsCredentialProvider,
          userProfile: auth.userProfile,
          signOut: auth.signOut,
          getS3Client: auth.getS3Client,
          getDdbClient: auth.getDdbClient,
          children: ReactGlobal.createElement(DocumentationPopout, {
            initialManifest: manifest,
            initialContents: contents,
            initialDocId: currentDocId || manifest.rootDocId,
            label: rootTitle,
            storage,
          }),
        },
      )
    );
  }, [auth, contents, currentDocId, manifest, rootTitle, storage]);

  const copyCurrentPageLink = useCallback(async () => {
    if (!currentDoc) return;
    const markdownLink = `[${currentDoc.title}](#doc:${currentDoc.id})`;
    try {
      await navigator.clipboard.writeText(markdownLink);
      setStatusMessage("Link copied");
      setSaveState("saved");
    } catch (copyError: unknown) {
      setStatusMessage((copyError as Error).message || "Failed to copy link");
      setSaveState("error");
    }
  }, [currentDoc]);

  if (loading) {
    return <div style={centeredStyle()}>Loading documentation...</div>;
  }

  if (error || !manifest || !currentDoc) {
    return <div style={centeredStyle(COLORS.error)}>{error ?? "Failed to load documentation."}</div>;
  }

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, background: COLORS.bg, color: COLORS.text, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <aside style={{ width: 260, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: `1px solid ${COLORS.border}`, background: COLORS.bgPanel }}>
        <div style={{ padding: "0.9rem 1rem", borderBottom: `1px solid ${COLORS.border}` }}>
          <div style={{ fontSize: "0.75rem", color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>Documentation</div>
          {editMode && editingLabel ? (
            <input
              value={labelDraft}
              onChange={(event) => setLabelDraft(event.target.value)}
              onBlur={() => void saveLabel()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveLabel();
                }
                if (event.key === "Escape") {
                  setEditingLabel(false);
                }
              }}
              autoFocus
              style={{ marginTop: "0.35rem", width: "100%", boxSizing: "border-box", background: COLORS.bgInput, border: `1px solid ${COLORS.accent}`, borderRadius: 6, color: COLORS.text, fontSize: "0.95rem", fontWeight: 600, padding: "0.3rem 0.45rem", outline: "none" }}
            />
          ) : (
            <button
              onClick={() => editMode && setEditingLabel(true)}
              style={{ marginTop: "0.35rem", padding: 0, background: "none", border: "none", color: COLORS.text, fontSize: "0.95rem", fontWeight: 600, cursor: editMode ? "text" : "default", textAlign: "left" }}
              title={editMode ? "Click to rename this documentation set" : undefined}
            >
              {rootTitle}
            </button>
          )}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "0.5rem" }}>
          {tree.map(({ id, depth }) => {
            const doc = manifest.docs[id];
            const selected = id === currentDocId;
            return (
              <button
                key={id}
                onClick={() => setCurrentDocId(id)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  background: selected ? COLORS.selected : "transparent",
                  color: selected ? "#93c5fd" : COLORS.text,
                  border: "none",
                  borderRadius: 6,
                  padding: "0.45rem 0.6rem",
                  paddingLeft: `${0.6 + depth * 1.1}rem`,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.45rem",
                  fontSize: "0.84rem",
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: selected ? COLORS.accent : COLORS.muted, flexShrink: 0 }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.title}</span>
              </button>
            );
          })}
        </div>

        {editMode && (
          <div style={{ padding: "0.75rem", borderTop: `1px solid ${COLORS.border}`, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.45rem" }}>
            <SmallActionButton onClick={() => void createLinkedDocument("child")} label="+ Child" />
            <SmallActionButton onClick={() => void createLinkedDocument("sibling")} label="+ Sibling" />
            <SmallActionButton onClick={() => void moveCurrentPage("up")} label="Move Up" disabled={currentDocId === manifest.rootDocId} />
            <SmallActionButton onClick={() => void moveCurrentPage("down")} label="Move Down" disabled={currentDocId === manifest.rootDocId} />
            <SmallActionButton onClick={() => void moveCurrentPage("demote")} label="Indent" disabled={currentDocId === manifest.rootDocId} />
            <SmallActionButton onClick={() => void moveCurrentPage("promote")} label="Outdent" disabled={currentDocId === manifest.rootDocId} />
            <SmallActionButton onClick={() => void renameCurrentPage()} label="Rename" disabled={currentDocId === manifest.rootDocId} />
            <SmallActionButton onClick={() => void deleteCurrentPage()} label="Delete" danger disabled={currentDocId === manifest.rootDocId} />
          </div>
        )}
      </aside>

      <section style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {editMode && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", padding: "0.7rem 0.9rem", background: COLORS.bgToolbar, borderBottom: `1px solid ${COLORS.border}`, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
              <ToolbarButton onClick={() => applyFormatting("**", "**", "bold text")} label="Bold" />
              <ToolbarButton onClick={() => applyFormatting("*", "*", "italic text")} label="Italic" />
              <ToolbarButton onClick={() => applyFormatting("`", "`", "code")} label="Inline Code" />
              <ToolbarButton onClick={() => insertBlock("## Heading\n")} label="Heading" />
              <ToolbarButton onClick={() => insertBlock("- List item\n")} label="Bullet" />
              <ToolbarButton onClick={() => insertBlock("\n```ts\ncode\n```\n")} label="Code Block" />
              <ToolbarButton onClick={() => mediaInputRef.current?.click()} label="Media" />
              <input
                ref={mediaInputRef}
                type="file"
                multiple
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                  void uploadMediaFiles(files);
                }}
                style={{ display: "none" }}
              />
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", flexWrap: "wrap" }}>
              <span style={{ fontSize: "0.75rem", color: saveState === "error" ? COLORS.error : saveState === "saved" ? COLORS.success : COLORS.muted }}>
                {statusMessage ?? (saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved" : "Ready")}
              </span>
            </div>
          </div>
        )}

        <div style={{ padding: "0.7rem 0.9rem", borderBottom: `1px solid ${COLORS.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.65rem", flexWrap: "wrap" }}>
              <div style={{ fontSize: "1rem", fontWeight: 600 }}>{currentDoc.title}</div>
              {editMode && (
                <button
                  onClick={() => void copyCurrentPageLink()}
                  style={{ background: "none", border: `1px solid ${COLORS.border}`, color: COLORS.muted, cursor: "pointer", fontSize: "0.75rem", padding: "0.25rem 0.55rem", borderRadius: 6 }}
                >
                  Copy Link
                </button>
              )}
            </div>
            <div style={{ marginTop: "0.2rem", fontSize: "0.75rem", color: COLORS.muted, fontFamily: "monospace" }}>
              doc://{currentDoc.id} ? {currentDoc.relativePath}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            <button
              onClick={openPopout}
              style={{ background: "none", border: `1px solid ${COLORS.border}`, color: COLORS.muted, cursor: "pointer", fontSize: "0.75rem", padding: "0.3rem 0.6rem", borderRadius: 6 }}
            >
              ↗ Pop out
            </button>
            {editMode && (
              <div style={{ fontSize: "0.75rem", color: COLORS.muted }}>
                Links use stable IDs in-app and are rewritten to relative paths during export.
              </div>
            )}
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {editMode && (
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", borderRight: `1px solid ${COLORS.border}` }}>
              <textarea
                ref={textareaRef}
                value={currentContent}
                onChange={(event) => updateCurrentContent(event.target.value)}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.files);
                  if (files.length === 0) return;
                  event.preventDefault();
                  void uploadMediaFiles(files);
                }}
                onDrop={(event) => {
                  const files = Array.from(event.dataTransfer.files);
                  if (files.length === 0) return;
                  event.preventDefault();
                  void uploadMediaFiles(files);
                }}
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes("Files")) {
                    event.preventDefault();
                  }
                }}
                spellCheck={false}
                style={{
                  flex: 1,
                  minHeight: 0,
                  resize: "none",
                  border: "none",
                  outline: "none",
                  background: COLORS.bg,
                  color: COLORS.text,
                  padding: "1rem",
                  fontFamily: "Consolas, Menlo, Monaco, monospace",
                  fontSize: "0.9rem",
                  lineHeight: 1.6,
                }}
              />
            </div>
          )}

          <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", padding: "1rem 1.25rem" }}>
            <DocumentationBody
              manifest={manifest}
              currentDocId={currentDocId}
              currentContent={currentContent}
              onNavigateDoc={setCurrentDocId}
              storage={storage}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

export async function onExport(ctx: ExportContext): Promise<void> {
  const meta = ctx.config.meta as Record<string, unknown> | undefined;
  const storageBucket = meta?.["storageBucket"] as string | undefined;
  const manifestKey = meta?.["manifestKey"] as string | undefined;
  const pagesPrefix = meta?.["pagesPrefix"] as string | undefined;
  if (!storageBucket || !manifestKey || !pagesPrefix) return;

  const manifestText = await readOptionalTextObject(ctx.s3Client as S3Client, storageBucket, manifestKey);
  if (!manifestText) return;

  const manifest = assignPaths(JSON.parse(manifestText) as DocumentationManifest);
  const exportBase = `${ctx.projectPrefix}${ctx.config.id}/export/docs`;
  const mediaPrefix = pagesPrefix.endsWith("/pages")
    ? `${pagesPrefix.slice(0, -"/pages".length)}/media`
    : `${pagesPrefix.split("/").slice(0, -1).join("/")}/media`;
  const storage: StorageConfig = {
    bucket: storageBucket,
    manifestKey,
    pagesPrefix,
    mediaPrefix,
  };
  const copiedMedia = new Set<string>();

  for (const doc of Object.values(manifest.docs)) {
    const sourceKey = `${pagesPrefix}/${doc.relativePath}`;
    const markdown =
      (await readOptionalTextObject(ctx.s3Client as S3Client, storageBucket, sourceKey)) ??
      `# ${doc.title}\n\n`;
    const exportedMarkdown = rewriteDocLinksForExport(markdown, manifest, doc.id);

    for (const href of extractMediaRelativePaths(exportedMarkdown)) {
      const resolvedPath = resolveRelativeHref(doc.relativePath, href);
      if (!resolvedPath?.startsWith("media/")) continue;

      const mediaRelativePath = resolvedPath.slice("media/".length);
      if (copiedMedia.has(mediaRelativePath)) continue;

      try {
        await copyObjectIfExists(
          ctx.s3Client as S3Client,
          storageBucket,
          getMediaKey(storage, mediaRelativePath),
          `${exportBase}/media/${mediaRelativePath}`,
          contentTypeForPath(mediaRelativePath)
        );
        copiedMedia.add(mediaRelativePath);
      } catch {
        // Keep documentation export resilient when a referenced media file is missing.
      }
    }

    await writeTextObject(
      ctx.s3Client as S3Client,
      storageBucket,
      `${exportBase}/${doc.relativePath}`,
      exportedMarkdown,
      "text/markdown; charset=utf-8"
    );
  }

  await writeTextObject(
    ctx.s3Client as S3Client,
    storageBucket,
    `${exportBase}/manifest.json`,
    JSON.stringify(manifest, null, 2),
    "application/json"
  );
}
