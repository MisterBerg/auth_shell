import React, {
  useState, useEffect, useCallback, useRef, createContext, useContext,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

export function resolveS3Key(baseKey: string, href: string, rootKey?: string): string | null {
  if (/^(https?:|mailto:|#)/i.test(href)) return null;
  const rawPath = href.split("?")[0].split("#")[0];
  const path = rawPath
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
  if (!path) return null;
  if (path.startsWith("/")) return path.slice(1);
  const base = baseKey.split("/");
  base.pop();
  const rootParts = (rootKey ?? baseKey).split("/");
  rootParts.pop();
  const minLength = rootParts.length;
  const parts = path.split("/");
  const result = [...base];
  for (const p of parts) {
    if (p === "..") {
      if (result.length > minLength) result.pop();
    }
    else if (p && p !== ".") result.push(p);
  }
  return result.join("/");
}

function mdLog(message: string, details?: unknown) {
  if (details === undefined) {
    console.log(`[markdown-viewer] ${message}`);
    return;
  }
  console.log(`[markdown-viewer] ${message}`, details);
}

function toFriendlyLoadMessage(message: string): string {
  return /specified key does not exist/i.test(message)
    ? "The linked file is not present in the uploaded document set."
    : message;
}

function renderPopupMessage(popup: Window, title: string, message: string) {
  popup.document.open();
  popup.document.write(`<!doctype html><html><head><title>${title}</title></head><body style="font-family: system-ui, sans-serif; color: #6b7280; padding: 1rem; white-space: pre-wrap;">${message}</body></html>`);
  popup.document.close();
}

export function isExternal(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function isMarkdownPath(href: string): boolean {
  return /\.mdx?$/i.test(href.split("?")[0].split("#")[0]);
}

// ---------------------------------------------------------------------------
// Blob URL cache — persists across renders, cleared on page reload
// ---------------------------------------------------------------------------

const blobCache = new Map<string, string>();

function splitHref(href: string): { path: string; hash: string } {
  const [path, hash = ""] = href.split("#");
  return { path, hash };
}

function fileNameFromKey(key: string): string {
  return key.split("/").pop() ?? "download";
}

function mimeFromKey(key: string): string {
  const ext = key.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    html: "text/html",
    htm:  "text/html",
    txt:  "text/plain",
    csv:  "text/csv",
    json: "application/json",
    pdf:  "application/pdf",
    png:  "image/png",
    jpg:  "image/jpeg",
    jpeg: "image/jpeg",
    gif:  "image/gif",
    webp: "image/webp",
    svg:  "image/svg+xml",
    mp4:  "video/mp4",
    webm: "video/webm",
    mp3:  "audio/mpeg",
    wav:  "audio/wav",
  };
  return map[ext] ?? "application/octet-stream";
}

function isBrowserRenderableMime(mime: string): boolean {
  return (
    mime.startsWith("text/html") ||
    mime === "application/pdf" ||
    mime.startsWith("image/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("video/") ||
    mime === "text/plain" ||
    mime === "text/csv" ||
    mime === "application/json"
  );
}

async function getBlobUrlForKey(
  ctx: RenderCtx,
  key: string,
): Promise<{ blobUrl: string; mime: string }> {
  const cacheKey = `${ctx.bucket}:${key}`;
  let blobUrl = blobCache.get(cacheKey);
  const mime = mimeFromKey(key);
  mdLog("requesting asset blob", {
    bucket: ctx.bucket,
    key,
    mime,
    cached: !!blobUrl,
  });
  if (!blobUrl) {
    const s3 = await ctx.getS3Client(ctx.bucket);
    const r = await s3.send(new GetObjectCommand({ Bucket: ctx.bucket, Key: key }));
    const bytes = await r.Body!.transformToByteArray();
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime });
    blobUrl = URL.createObjectURL(blob);
    blobCache.set(cacheKey, blobUrl);
  }
  return { blobUrl, mime };
}

// ---------------------------------------------------------------------------
// Context passed to react-markdown custom renderers
// ---------------------------------------------------------------------------

interface RenderCtx {
  bucket: string;
  currentKey: string;
  rootKey: string;
  getS3Client: (bucket?: string) => Promise<S3Client>;
  onNavigate: (key: string) => void;
  onNavigateHash: (hash: string) => void;
}

const RenderCtx = createContext<RenderCtx | null>(null);

function slugifyHeading(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function getNodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(getNodeText).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return getNodeText(node.props.children);
  }
  return "";
}

function Heading({
  level,
  children,
}: {
  level: "h1" | "h2" | "h3" | "h4";
  children?: React.ReactNode;
}) {
  const Tag = level;
  const id = slugifyHeading(getNodeText(children ?? ""));
  return <Tag id={id || undefined}>{children}</Tag>;
}

// ---------------------------------------------------------------------------
// Async image — fetches from S3 and creates a blob URL
// ---------------------------------------------------------------------------

function S3Image({ src, alt }: { src?: string; alt?: string }) {
  const ctx = useContext(RenderCtx);
  const [url, setUrl] = useState<string | "loading" | "error">("loading");

  useEffect(() => {
    if (!src || !ctx) { setUrl("error"); return; }
    if (isExternal(src)) { setUrl(src); return; }

    const key = resolveS3Key(ctx.currentKey, src, ctx.rootKey);
    mdLog("resolving image source", {
      currentKey: ctx.currentKey,
      src,
      resolvedKey: key,
    });
    if (!key) { setUrl("error"); return; }

    const cacheKey = `${ctx.bucket}:${key}`;
    if (blobCache.has(cacheKey)) { setUrl(blobCache.get(cacheKey)!); return; }

    let cancelled = false;
    ctx.getS3Client(ctx.bucket)
      .then((s3) => s3.send(new GetObjectCommand({ Bucket: ctx.bucket, Key: key })))
      .then((r) => r.Body!.transformToByteArray())
      .then((bytes) => {
        if (cancelled) return;
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeFromKey(key) });
        const blobUrl = URL.createObjectURL(blob);
        blobCache.set(cacheKey, blobUrl);
        setUrl(blobUrl);
      })
      .catch(() => { if (!cancelled) setUrl("error"); });

    return () => { cancelled = true; };
  }, [src, ctx]);

  if (url === "loading") return <em style={{ color: "#6b7280", fontSize: "0.85em" }}>[{alt ?? "image"}…]</em>;
  if (url === "error")   return <em style={{ color: "#6b7280", fontSize: "0.85em" }}>[{alt ?? src}]</em>;
  return <img src={url} alt={alt ?? ""} style={{ maxWidth: "100%", borderRadius: 4 }} />;
}

// ---------------------------------------------------------------------------
// Link renderer — internal .md links navigate in-pane; external open tab
// ---------------------------------------------------------------------------

function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const ctx = useContext(RenderCtx);

  if (!href) return <>{children}</>;
  if (isExternal(href)) {
    return <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "#60a5fa" }}>{children}</a>;
  }
  if (ctx && href.startsWith("#")) {
    return (
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          ctx.onNavigateHash(href.slice(1));
        }}
        style={{ color: "#60a5fa", cursor: "pointer" }}
      >
        {children}
      </a>
    );
  }
  if (ctx && isMarkdownPath(href)) {
    const [pathPart, hashPart] = href.split("#");
    const key = resolveS3Key(ctx.currentKey, pathPart, ctx.rootKey);
    mdLog("resolving markdown link", {
      currentKey: ctx.currentKey,
      href,
      pathPart,
      hashPart,
      resolvedKey: key,
    });
    return (
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          if (key) ctx.onNavigate(key);
          if (hashPart) {
            ctx.onNavigateHash(hashPart);
          }
        }}
        style={{ color: "#60a5fa", cursor: "pointer" }}
      >
        {children}
      </a>
    );
  }
  // Non-markdown local file (PDF, images, etc.) — fetch from S3 and open as blob URL
  if (ctx) {
    const { path, hash } = splitHref(href);
    const key = resolveS3Key(ctx.currentKey, path, ctx.rootKey);
    mdLog("resolving asset link", {
      currentKey: ctx.currentKey,
      href,
      path,
      hash,
      resolvedKey: key,
      mime: key ? mimeFromKey(key) : undefined,
    });
    if (key) {
      return (
        <a
          href="#"
          onClick={async (e) => {
            e.preventDefault();
            const popup = window.open("about:blank", "_blank");
            if (popup) {
              renderPopupMessage(popup, "Loading asset...", "Loading asset...");
            }
            try {
              const { blobUrl, mime } = await getBlobUrlForKey(ctx, key);
              const targetUrl = hash ? `${blobUrl}#${hash}` : blobUrl;
              if (isBrowserRenderableMime(mime)) {
                if (popup) {
                  popup.location.replace(targetUrl);
                } else {
                  window.open(targetUrl, "_blank");
                }
                return;
              }

              if (popup) popup.close();
              const link = document.createElement("a");
              link.href = targetUrl;
              link.download = fileNameFromKey(key);
              link.rel = "noopener noreferrer";
              document.body.appendChild(link);
              link.click();
              link.remove();
            } catch (error) {
              const message = String((error as Error).message ?? error);
              mdLog("asset link failed", {
                currentKey: ctx.currentKey,
                href,
                path,
                hash,
                resolvedKey: key,
                message,
              });
              const friendly = toFriendlyLoadMessage(message);
              if (popup) {
                renderPopupMessage(popup, "Failed to load asset", friendly);
              }
            }
          }}
          style={{ color: "#60a5fa", cursor: "pointer" }}
        >
          {children}
        </a>
      );
    }
  }
  return <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "#60a5fa" }}>{children}</a>;
}

// ---------------------------------------------------------------------------
// Markdown styles — injected once into the document head
// ---------------------------------------------------------------------------

const STYLE_ID = "hep-md-styles";

export const MD_CSS = `
.hep-md { font-family: system-ui,-apple-system,sans-serif; font-size: 0.9rem; line-height: 1.7; color: #e5e7eb; }
.hep-md h1,.hep-md h2,.hep-md h3,.hep-md h4 { color: #f9fafb; font-weight: 600; margin: 1.5em 0 0.5em; line-height: 1.3; }
.hep-md h1 { font-size: 1.75rem; border-bottom: 1px solid #1a2a42; padding-bottom: 0.4em; }
.hep-md h2 { font-size: 1.35rem; border-bottom: 1px solid #1a2a42; padding-bottom: 0.3em; }
.hep-md h3 { font-size: 1.1rem; }
.hep-md p  { margin: 0.75em 0; }
.hep-md a  { color: #60a5fa; text-decoration: underline; }
.hep-md code { background: #0a1525; border: 1px solid #1a2a42; border-radius: 4px; padding: 0.1em 0.4em; font-family: 'JetBrains Mono',Consolas,monospace; font-size: 0.85em; color: #93c5fd; }
.hep-md pre  { background: #0a1525; border: 1px solid #1a2a42; border-radius: 8px; padding: 1rem 1.25rem; overflow-x: auto; margin: 1em 0; }
.hep-md pre code { background: none; border: none; padding: 0; font-size: 0.83rem; color: #d1d5db; }
.hep-md blockquote { border-left: 3px solid #3b82f6; margin: 1em 0; padding: 0.1em 0 0.1em 1.25em; color: #9ca3af; }
.hep-md table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.85rem; }
.hep-md th,.hep-md td { border: 1px solid #1a2a42; padding: 0.45rem 0.75rem; }
.hep-md th { background: #0d1a2e; font-weight: 600; color: #93c5fd; }
.hep-md tr:nth-child(even) td { background: #080f1c; }
.hep-md ul,.hep-md ol { padding-left: 1.5rem; margin: 0.5em 0; }
.hep-md li { margin: 0.25em 0; }
.hep-md hr { border: none; border-top: 1px solid #1a2a42; margin: 1.5em 0; }
.hep-md img { max-width: 100%; }
`;

function ensureStyles(targetDoc: Document = document) {
  if (targetDoc.getElementById(STYLE_ID)) return;
  const el = targetDoc.createElement("style");
  el.id = STYLE_ID;
  el.textContent = MD_CSS;
  targetDoc.head.appendChild(el);
  (window as unknown as Record<string, unknown>)["__hepMdCss"] = MD_CSS;
}

// ---------------------------------------------------------------------------
// MarkdownPane — fetches + renders one markdown file; supports in-pane nav
// ---------------------------------------------------------------------------

export interface MarkdownTab {
  tabId: string;
  title: string;
  bucket: string;
  /** S3 key prefix for this tab's files — set at creation, never changes.
   *  e.g. "projects/jeff-dev/docs/tab-m3fk9x" */
  prefix: string;
  /** Full S3 key of the entry markdown file. Empty until first upload. */
  rootKey: string;
}

interface MarkdownPaneProps {
  tab: MarkdownTab;
  getS3Client: (bucket?: string) => Promise<S3Client>;
  onContentLoaded?: (text: string | null) => void;
}

export function MarkdownPane({ tab, getS3Client, onContentLoaded }: MarkdownPaneProps) {
  const [navStack, setNavStack] = useState<string[]>([tab.rootKey]);
  const [content,  setContent]  = useState<string | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [fetchErr, setFetchErr] = useState<string | undefined>();
  const [pendingHash, setPendingHash] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentKey = navStack[navStack.length - 1] ?? tab.rootKey;

  useEffect(() => ensureStyles(), []);

  // Reset nav when tab identity changes
  useEffect(() => {
    setNavStack([tab.rootKey]);
    setPendingHash(null);
  }, [tab.tabId, tab.rootKey]);

  useEffect(() => {
    if (!currentKey) return;
    let cancelled = false;
    setLoading(true);
    setContent(null);
    setFetchErr(undefined);
    onContentLoaded?.(null);
    mdLog("loading markdown document", { bucket: tab.bucket, key: currentKey });
    getS3Client(tab.bucket)
      .then((s3) => s3.send(new GetObjectCommand({ Bucket: tab.bucket, Key: currentKey })))
      .then((r) => r.Body!.transformToString("utf-8"))
      .then((text) => {
        if (!cancelled) {
          mdLog("loaded markdown document", { key: currentKey, length: text.length });
          setContent(text);
          setLoading(false);
          onContentLoaded?.(text);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          const message = String((e as Error).message ?? e);
          mdLog("failed to load markdown document", {
            key: currentKey,
            message,
          });
          setFetchErr(toFriendlyLoadMessage(message));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [currentKey, tab.bucket, getS3Client]);

  const handleNavigate = useCallback((key: string) => {
    setNavStack((prev) => [...prev, key]);
    setPendingHash(null);
    containerRef.current?.scrollTo(0, 0);
  }, []);

  const handleBack = useCallback(() => {
    setNavStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
    setPendingHash(null);
    containerRef.current?.scrollTo(0, 0);
  }, []);

  const handleNavigateHash = useCallback((hash: string) => {
    if (!hash) return;
    const cssEscape = (globalThis as typeof globalThis & {
      CSS?: { escape?: (value: string) => string };
    }).CSS?.escape;
    const escaped = cssEscape
      ? cssEscape(hash)
      : hash.replace(/["\\.#:[\]]/g, "\\$&");
    const target = containerRef.current?.querySelector<HTMLElement>(`#${escaped}`);
    if (target) {
      setPendingHash(null);
      target.scrollIntoView({ block: "start" });
      return;
    }
    setPendingHash(hash);
  }, []);

  useEffect(() => {
    if (!pendingHash || content === null) return;
    const timer = window.setTimeout(() => {
      handleNavigateHash(pendingHash);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pendingHash, content, currentKey, handleNavigateHash]);

  const ctx: RenderCtx = {
    bucket: tab.bucket,
    currentKey,
    rootKey: tab.rootKey,
    getS3Client,
    onNavigate: handleNavigate,
    onNavigateHash: handleNavigateHash,
  };

  return (
    <div
      ref={containerRef}
      style={{ height: "100%", overflowY: "auto", padding: "1.5rem 2.5rem", background: "#080f1c" }}
    >
      {navStack.length > 1 && (
        <button onClick={handleBack} style={{ marginBottom: "1rem", padding: "0.3rem 0.75rem", borderRadius: 6, border: "1px solid #1a2a42", background: "transparent", color: "#9ca3af", cursor: "pointer", fontSize: "0.8rem" }}>
          ← Back
        </button>
      )}
      {loading  && <p style={{ color: "#6b7280", fontSize: "0.875rem" }}>Loading…</p>}
      {fetchErr && <p style={{ color: "#fca5a5", fontSize: "0.875rem" }}>Failed to load: {fetchErr}</p>}
      {content !== null && (
        <RenderCtx.Provider value={ctx}>
          <div className="hep-md">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw]}
              components={{
                a:   (p) => <MarkdownLink href={p.href}>{p.children}</MarkdownLink>,
                img: (p) => <S3Image src={p.src} alt={p.alt} />,
                h1:  (p) => <Heading level="h1">{p.children}</Heading>,
                h2:  (p) => <Heading level="h2">{p.children}</Heading>,
                h3:  (p) => <Heading level="h3">{p.children}</Heading>,
                h4:  (p) => <Heading level="h4">{p.children}</Heading>,
              }}
            >
              {content}
            </Markdown>
          </div>
        </RenderCtx.Provider>
      )}
    </div>
  );
}
