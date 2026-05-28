import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DependencyList, ReactNode } from "react";
import type { ExportContext, ModuleProps } from "module-core";
import {
  AuthProvider,
  useAuthContext,
  useAwsS3Client,
  useEditMode,
  useUpdateSlotMeta,
} from "module-core";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import {
  assignPaths,
  createLinkedPage,
  copyObjectIfExists,
  createDocId,
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
  slugify,
  type ContentMap,
  type DocKind,
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
const DOC_MD_STYLE_ID = "hep-doc-md-styles";
const DOC_MD_CSS = `
.hep-doc-md { font-family: system-ui,-apple-system,sans-serif; font-size: 0.95rem; line-height: 1.7; color: #e5e7eb; }
.hep-doc-md h1,.hep-doc-md h2,.hep-doc-md h3,.hep-doc-md h4 { color: #f9fafb; font-weight: 600; margin: 1.5em 0 0.5em; line-height: 1.3; }
.hep-doc-md h1 { font-size: 1.75rem; border-bottom: 1px solid #1a2a42; padding-bottom: 0.4em; }
.hep-doc-md h2 { font-size: 1.35rem; border-bottom: 1px solid #1a2a42; padding-bottom: 0.3em; }
.hep-doc-md h3 { font-size: 1.1rem; }
.hep-doc-md p { margin: 0.75em 0; }
.hep-doc-md a { color: #60a5fa; text-decoration: underline; }
.hep-doc-md code { background: #0a1525; border: 1px solid #1a2a42; border-radius: 4px; padding: 0.1em 0.4em; font-family: 'JetBrains Mono',Consolas,monospace; font-size: 0.85em; color: #93c5fd; }
.hep-doc-md pre { background: #0a1525; border: 1px solid #1a2a42; border-radius: 8px; padding: 1rem 1.25rem; overflow-x: auto; margin: 1em 0; }
.hep-doc-md pre code { background: none; border: none; padding: 0; font-size: 0.83rem; color: #d1d5db; }
.hep-doc-md blockquote { border-left: 3px solid #3b82f6; margin: 1em 0; padding: 0.1em 0 0.1em 1.25em; color: #9ca3af; }
.hep-doc-md table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.85rem; }
.hep-doc-md th,.hep-doc-md td { border: 1px solid #1a2a42; padding: 0.45rem 0.75rem; vertical-align: top; }
.hep-doc-md th { background: #0d1a2e; font-weight: 600; color: #93c5fd; }
.hep-doc-md tr:nth-child(even) td { background: #080f1c; }
.hep-doc-md ul,.hep-doc-md ol { padding-left: 1.5rem; margin: 0.5em 0; }
.hep-doc-md li { margin: 0.25em 0; }
.hep-doc-md hr { border: none; border-top: 1px solid #1a2a42; margin: 1.5em 0; }
.hep-doc-md img,.hep-doc-md video { max-width: 100%; }
`;

function ensureDocumentationStyles(targetDoc: Document = document) {
  if (targetDoc.getElementById(DOC_MD_STYLE_ID)) return;
  const el = targetDoc.createElement("style");
  el.id = DOC_MD_STYLE_ID;
  el.textContent = DOC_MD_CSS;
  targetDoc.head.appendChild(el);
}

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

function isMostlyBlankDocContent(content: string, title: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  const normalizedTitle = title.trim().toLowerCase();
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 1) {
    return lines[0].replace(/^#+\s*/, "").trim().toLowerCase() === normalizedTitle;
  }
  return false;
}

function replaceLeadingHeading(content: string, title: string): string {
  if (!content.trim()) return `# ${title}\n\n`;
  if (/^\s*#\s+/m.test(content)) {
    return content.replace(/^\s*#\s+.*$/m, `# ${title}`);
  }
  return `# ${title}\n\n${content.replace(/^\s+/, "")}`;
}

function chooseImportEntryPath(markdownFiles: string[], rootDir: string): string | null {
  if (markdownFiles.length === 0) return null;
  const topLevel = markdownFiles.filter((path) => !path.includes("/"));
  const rootName = rootDir.toLowerCase();
  return (
    topLevel.find((path) => /^readme\.mdx?$/i.test(path)) ??
    topLevel.find((path) => /^index\.mdx?$/i.test(path)) ??
    topLevel.find((path) => withoutFileExtension(basename(path)).toLowerCase() === rootName) ??
    (topLevel.length === 1 ? topLevel[0] : undefined) ??
    (markdownFiles.length === 1 ? markdownFiles[0] : undefined) ??
    markdownFiles
      .slice()
      .sort((a, b) => {
        const aDepth = a.split("/").length;
        const bDepth = b.split("/").length;
        if (aDepth !== bDepth) return aDepth - bDepth;
        const aRootish = withoutFileExtension(basename(a)).toLowerCase() === rootName ? -1 : 0;
        const bRootish = withoutFileExtension(basename(b)).toLowerCase() === rootName ? -1 : 0;
        if (aRootish !== bRootish) return aRootish - bRootish;
        return a.localeCompare(b);
      })[0] ??
    null
  );
}

function mediaKind(path: string, contentType = contentTypeForPath(path)): "image" | "video" | "audio" | "file" {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return "file";
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}

function withoutFileExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
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

function resolveImportPath(basePath: string, ref: string): string {
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
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
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

function extractMarkdownTitle(content: string, fallback: string): string {
  const heading = content.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim();
  return heading || fallback;
}

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
  const htmlImg = /<(?:img|video|audio|source)[^>]+src=["']([^"']+)["']/gi;
  while ((m = htmlImg.exec(content)) !== null) {
    const u = m[1];
    if (u && !/^(https?:|data:)/i.test(u)) refs.push(u.split(/[?#]/)[0]);
  }
  return refs;
}

async function resolveLocalFileRef(
  entryPath: string,
  ref: string,
  fileMap: Map<string, File>,
): Promise<{ requestedPath: string; sourcePath: string | null }> {
  const requestedPath = resolveImportPath(entryPath, ref);
  if (fileMap.has(requestedPath)) {
    return { requestedPath, sourcePath: requestedPath };
  }

  const { dir, name } = splitDirAndName(requestedPath);
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (!ext) return { requestedPath, sourcePath: null };

  const requestedStem = normalizeLoose(fileStem(name));
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

async function crawlMarkdownReachable(
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
    for (const ref of refs) {
      const { requestedPath, sourcePath } = await resolveLocalFileRef(entryPath, ref, fileMap);
      if (!sourcePath) continue;
      reachable.set(requestedPath, sourcePath);
      if (/\.mdx?$/i.test(sourcePath)) {
        await crawlMarkdownReachable(sourcePath, fileMap, reachable, visitedMarkdown);
      }
    }
  }
  return reachable;
}

type ImportedDocumentationData = {
  manifest: DocumentationManifest;
  contents: ContentMap;
  mediaFiles: Array<{ relativePath: string; file: File }>;
};

type ImportedDraftDoc = {
  id: string;
  title: string;
  parentId: string | null;
  slug: string;
  children: string[];
  createdAt: string;
  updatedAt: string;
  importPath: string;
  kind: DocKind;
};

function replaceImportHref(
  href: string,
  currentPath: string,
  currentDocRelativePath: string,
  pathToDocId: Map<string, string>,
  manifest: DocumentationManifest,
  mediaPaths: Set<string>,
): string {
  if (!href || /^(https?:|mailto:|data:|#)/i.test(href)) return href;
  const base = href.split(/[?#]/)[0];
  const suffix = href.slice(base.length);
  const resolvedPath = resolveImportPath(currentPath, base);
  const targetDocId = pathToDocId.get(resolvedPath);
  if (targetDocId && manifest.docs[targetDocId]) {
    return `#doc:${targetDocId}`;
  }
  if (mediaPaths.has(resolvedPath)) {
    return `${getRelativePath(currentDocRelativePath, `media/${resolvedPath}`)}${suffix}`;
  }
  return href;
}

function rewriteImportedMarkdownContent(args: {
  content: string;
  currentPath: string;
  currentDocRelativePath: string;
  pathToDocId: Map<string, string>;
  manifest: DocumentationManifest;
  mediaPaths: Set<string>;
}): string {
  const replacer = (href: string) =>
    replaceImportHref(href, args.currentPath, args.currentDocRelativePath, args.pathToDocId, args.manifest, args.mediaPaths);

  return args.content
    .replace(/(!?\[[^\]]*\]\()([^) \t\n"']+)(\))/g, (_match, prefix, href, suffix) => `${prefix}${replacer(href)}${suffix}`)
    .replace(/^(\s*\[[^\]]+\]:\s*)([^\s"'<>\n]+)(.*)$/gm, (_match, prefix, href, suffix) => `${prefix}${replacer(href)}${suffix}`)
    .replace(/(<(?:img|video|audio|source)[^>]+src=["'])([^"']+)(["'][^>]*>)/gi, (_match, prefix, href, suffix) => `${prefix}${replacer(href)}${suffix}`);
}

async function buildImportedDocumentationData(args: {
  entryPath: string;
  reachable: Map<string, string>;
  fileMap: Map<string, File>;
  rootTitle: string;
}): Promise<ImportedDocumentationData> {
  const markdownEntries = [...args.reachable.entries()]
    .filter(([path]) => /\.mdx?$/i.test(path))
    .sort(([a], [b]) => a.localeCompare(b));
  const rootDir = splitDirAndName(args.entryPath).dir;
  const mediaFiles = [...args.reachable.entries()]
    .filter(([path]) => !/\.mdx?$/i.test(path))
    .map(([path, sourcePath]) => ({ relativePath: path, file: args.fileMap.get(sourcePath)! }));

  const representativeByDir = new Map<string, string>();
  representativeByDir.set(rootDir, args.entryPath);
  const markdownPathsByDir = new Map<string, string[]>();
  for (const [path] of markdownEntries) {
    const { dir, name } = splitDirAndName(path);
    const bucket = markdownPathsByDir.get(dir) ?? [];
    bucket.push(path);
    markdownPathsByDir.set(dir, bucket);
    if (path === args.entryPath) continue;
    if (/^(readme|index)\.mdx?$/i.test(name) && !representativeByDir.has(dir)) {
      representativeByDir.set(dir, path);
    }
  }

  for (const [dir, paths] of markdownPathsByDir.entries()) {
    if (representativeByDir.has(dir) || dir === rootDir) continue;
    if (paths.length === 1) {
      representativeByDir.set(dir, paths[0]);
      continue;
    }
    const dirName = basename(dir).toLowerCase();
    const sameNamed = paths.find((path) => withoutFileExtension(basename(path)).toLowerCase() === dirName);
    if (sameNamed) {
      representativeByDir.set(dir, sameNamed);
    }
  }

  const allDirs = new Set<string>();
  for (const [path] of markdownEntries) {
    if (path === args.entryPath) continue;
    let current = splitDirAndName(path).dir;
    while (current && current !== rootDir) {
      allDirs.add(current);
      current = splitDirAndName(current).dir;
    }
  }

  const syntheticDirIdByDir = new Map<string, string>();
  for (const dir of [...allDirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
    if (!representativeByDir.has(dir)) {
      syntheticDirIdByDir.set(dir, createDocId());
    }
  }

  const docIdByPath = new Map<string, string>();
  docIdByPath.set(args.entryPath, "root");
  for (const [path] of markdownEntries) {
    if (path === args.entryPath) continue;
    docIdByPath.set(path, createDocId());
  }

  const containerDocIdForDir = (dir: string): string => {
    if (dir === rootDir) return "root";
    const representativePath = representativeByDir.get(dir);
    if (representativePath) return docIdByPath.get(representativePath)!;
    const syntheticId = syntheticDirIdByDir.get(dir);
    if (syntheticId) return syntheticId;
    const parentDir = splitDirAndName(dir).dir;
    return containerDocIdForDir(parentDir);
  };

  const draftDocs = new Map<string, ImportedDraftDoc>();

  for (const [dir, docId] of syntheticDirIdByDir.entries()) {
    const title = basename(dir).replace(/[-_]/g, " ") || "Section";
    const parentDir = splitDirAndName(dir).dir;
    draftDocs.set(docId, {
      id: docId,
      title,
      parentId: containerDocIdForDir(parentDir),
      slug: slugify(title),
      children: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      importPath: `${dir}/`,
      kind: "section",
    });
  }

  for (const [path, sourcePath] of markdownEntries) {
    const file = args.fileMap.get(sourcePath)!;
    const content = await file.text();
    const stem = withoutFileExtension(basename(path)).replace(/[-_]/g, " ") || args.rootTitle;
    const title = extractMarkdownTitle(content, stem);
    const id = docIdByPath.get(path)!;
    const { dir } = splitDirAndName(path);
    let parentId: string | null = null;
    if (path !== args.entryPath) {
      const directoryRepresentative = representativeByDir.get(dir);
      if (directoryRepresentative === path) {
        parentId = containerDocIdForDir(splitDirAndName(dir).dir);
      } else {
        parentId = containerDocIdForDir(dir);
      }
    }
    draftDocs.set(id, {
      id,
      title,
      parentId,
      slug: path === args.entryPath ? "index" : slugify(withoutFileExtension(basename(path))),
      children: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      importPath: path,
      kind: "page",
    });
  }

  for (const doc of draftDocs.values()) {
    if (doc.parentId && draftDocs.has(doc.parentId)) {
      draftDocs.get(doc.parentId)!.children.push(doc.id);
    }
  }

  for (const doc of draftDocs.values()) {
    doc.children.sort((a, b) => {
      const left = draftDocs.get(a)?.importPath ?? "";
      const right = draftDocs.get(b)?.importPath ?? "";
      const leftIsDir = left.endsWith("/");
      const rightIsDir = right.endsWith("/");
      if (leftIsDir !== rightIsDir) return leftIsDir ? -1 : 1;
      return left.localeCompare(right);
    });
  }

  const manifest = assignPaths({
    version: 1,
    rootDocId: "root",
    docs: Object.fromEntries(
      [...draftDocs.values()].map((doc) => [
        doc.id,
        {
          id: doc.id,
          title: doc.title,
          parentId: doc.parentId,
          children: doc.children,
          slug: doc.slug,
          relativePath: doc.id === "root" ? "index.md" : "",
          kind: doc.id === "root" ? "page" : doc.kind,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        },
      ]),
    ),
  });

  const contents: ContentMap = {};
  const mediaPathSet = new Set(mediaFiles.map((file) => file.relativePath));

  for (const [path, sourcePath] of markdownEntries) {
    const file = args.fileMap.get(sourcePath)!;
    const rawContent = await file.text();
    const docId = docIdByPath.get(path)!;
    contents[docId] = rewriteImportedMarkdownContent({
      content: rawContent,
      currentPath: path,
      currentDocRelativePath: manifest.docs[docId].relativePath,
      pathToDocId: docIdByPath,
      manifest,
      mediaPaths: mediaPathSet,
    });
  }

  for (const doc of draftDocs.values()) {
    if (doc.kind !== "section") continue;
    contents[doc.id] = "";
  }

  return { manifest, contents, mediaFiles };
}

function appendImportedDocumentation(args: {
  existingManifest: DocumentationManifest;
  existingContents: ContentMap;
  importedManifest: DocumentationManifest;
  importedContents: ContentMap;
  targetDocId: string;
}): { manifest: DocumentationManifest; contents: ContentMap; focusDocId: string } {
  const nextManifest = JSON.parse(JSON.stringify(args.existingManifest)) as DocumentationManifest;
  const nextContents = { ...args.existingContents };
  const importedRoot = args.importedManifest.docs[args.importedManifest.rootDocId];
  const targetDoc = nextManifest.docs[args.targetDocId];
  if (!importedRoot || !targetDoc) {
    throw new Error("Unable to import into the selected documentation page.");
  }

  const cloneSubtree = (sourceId: string, parentId: string): string => {
    const source = args.importedManifest.docs[sourceId];
    const clonedId = createDocId();
    nextManifest.docs[clonedId] = {
      id: clonedId,
      title: source.title,
      parentId,
      children: [],
      slug: slugify(source.title),
      relativePath: "",
      kind: source.kind ?? "page",
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    };
    nextContents[clonedId] =
      (source.kind ?? "page") === "section"
        ? ""
        : args.importedContents[sourceId] ?? `# ${source.title}\n\n`;
    for (const childId of source.children) {
      const clonedChildId = cloneSubtree(childId, clonedId);
      nextManifest.docs[clonedId].children.push(clonedChildId);
    }
    return clonedId;
  };

  if (isMostlyBlankDocContent(nextContents[targetDoc.id] ?? "", targetDoc.title)) {
    nextContents[targetDoc.id] = replaceLeadingHeading(
      args.importedContents[importedRoot.id] ?? `# ${targetDoc.title}\n\n`,
      targetDoc.title,
    );
    for (const childId of importedRoot.children) {
      const clonedChildId = cloneSubtree(childId, targetDoc.id);
      nextManifest.docs[targetDoc.id].children.push(clonedChildId);
    }
    return {
      manifest: assignPaths(nextManifest),
      contents: nextContents,
      focusDocId: targetDoc.id,
    };
  }

  const importedRootId = createDocId();
  nextManifest.docs[importedRootId] = {
    id: importedRootId,
    title: importedRoot.title,
    parentId: targetDoc.id,
    children: [],
    slug: slugify(importedRoot.title),
    relativePath: "",
    kind: importedRoot.kind ?? "page",
    createdAt: importedRoot.createdAt,
    updatedAt: importedRoot.updatedAt,
  };
  nextContents[importedRootId] =
    (importedRoot.kind ?? "page") === "section"
      ? ""
      : args.importedContents[importedRoot.id] ?? `# ${importedRoot.title}\n\n`;
  for (const childId of importedRoot.children) {
    const clonedChildId = cloneSubtree(childId, importedRootId);
    nextManifest.docs[importedRootId].children.push(clonedChildId);
  }
  nextManifest.docs[targetDoc.id].children.push(importedRootId);

  return {
    manifest: assignPaths(nextManifest),
    contents: nextContents,
    focusDocId: importedRootId,
  };
}

function collectExpandableDocIds(manifest: DocumentationManifest): string[] {
  return Object.values(manifest.docs)
    .filter((doc) => doc.children.length > 0)
    .map((doc) => doc.id);
}

function buildVisibleDocTree(
  manifest: DocumentationManifest,
  expanded: ReadonlySet<string>,
): Array<{ id: string; depth: number }> {
  const walk = (docId: string, depth: number): Array<{ id: string; depth: number }> => {
    const doc = manifest.docs[docId];
    if (!doc) return [];
    const nodes = [{ id: docId, depth }];
    if (!expanded.has(docId)) return nodes;
    for (const childId of doc.children) nodes.push(...walk(childId, depth + 1));
    return nodes;
  };
  return walk(manifest.rootDocId, 0);
}

function buildSectionLandingContent(manifest: DocumentationManifest, docId: string): string {
  const doc = manifest.docs[docId];
  if (!doc) return "";
  const childLinks = doc.children
    .map((childId) => manifest.docs[childId])
    .filter((child): child is DocumentationManifest["docs"][string] => Boolean(child))
    .map((child) => `- [${child.title}](#doc:${child.id})`)
    .join("\n");
  return childLinks ? `# ${doc.title}\n\n${childLinks}\n` : `# ${doc.title}\n\n`;
}

function TreeToggle({
  expanded,
  hasChildren,
  onClick,
}: {
  expanded: boolean;
  hasChildren: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      disabled={!hasChildren}
      aria-label={hasChildren ? (expanded ? "Collapse section" : "Expand section") : "No child pages"}
      style={{
        width: 18,
        height: 18,
        border: "none",
        background: "transparent",
        color: hasChildren ? COLORS.muted : "transparent",
        cursor: hasChildren ? "pointer" : "default",
        padding: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        fontSize: "0.8rem",
        lineHeight: 1,
      }}
    >
      {hasChildren ? (expanded ? "▾" : "▸") : "•"}
    </button>
  );
}

async function listObjectKeysWithPrefix(s3: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const item of response.Contents ?? []) {
      if (item.Key) keys.push(item.Key);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

function useDebouncedEffect(
  effect: () => void | (() => void),
  deps: DependencyList,
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

function centeredStyle(color = COLORS.muted): CSSProperties {
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
  children?: ReactNode;
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
  useEffect(() => {
    ensureDocumentationStyles();
  }, []);
  const renderContent = currentContent.replace(/\]\(doc:\/\/([a-z0-9-]+)\)/gi, "](#doc:$1)");

  return (
    <article className="hep-doc-md" style={{ maxWidth: 860, color: COLORS.text }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
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
          table: ({ children }) => (
            <div style={{ overflowX: "auto", margin: "1rem 0" }}>
              <table>{children}</table>
            </div>
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
  const [expandedDocIds, setExpandedDocIds] = useState<Set<string>>(
    () => new Set(collectExpandableDocIds(initialManifest))
  );
  const currentDoc = initialManifest.docs[currentDocId] ?? initialManifest.docs[initialManifest.rootDocId];
  const currentContent =
    (currentDoc.kind ?? "page") === "section"
      ? buildSectionLandingContent(initialManifest, currentDoc.id)
      : initialContents[currentDoc.id] ?? "";
  const tree = useMemo(() => {
    return buildVisibleDocTree(initialManifest, expandedDocIds);
  }, [expandedDocIds, initialManifest]);

  const toggleExpanded = useCallback((docId: string) => {
    setExpandedDocIds((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  }, []);

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
            const hasChildren = doc.children.length > 0;
            const expanded = expandedDocIds.has(id);
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
                <TreeToggle expanded={expanded} hasChildren={hasChildren} onClick={() => toggleExpanded(id)} />
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
              doc://{currentDoc.id} · {(currentDoc.kind ?? "page") === "section" ? "[section]" : currentDoc.relativePath}
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
  const [importingDocs, setImportingDocs] = useState(false);
  const [expandedDocIds, setExpandedDocIds] = useState<Set<string>>(new Set());

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const importDirectoryInputRef = useRef<HTMLInputElement>(null);
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
        setExpandedDocIds(new Set(collectExpandableDocIds(state.manifest)));
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
      if (!doc || (doc.kind ?? "page") === "section" || !doc.relativePath) return;

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
        Object.values(previousManifest.docs)
          .filter((doc) => (doc.kind ?? "page") === "page" && doc.relativePath)
          .map((doc) => getDocKey(storage, doc.relativePath))
      );
      const nextKeys = new Set(
        Object.values(nextManifest.docs)
          .filter((doc) => (doc.kind ?? "page") === "page" && doc.relativePath)
          .map((doc) => getDocKey(storage, doc.relativePath))
      );

      for (const doc of Object.values(nextManifest.docs)) {
        if ((doc.kind ?? "page") !== "page" || !doc.relativePath) continue;
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
  const currentContent =
    currentDocId && currentDoc
      ? (currentDoc.kind ?? "page") === "section"
        ? buildSectionLandingContent(manifest!, currentDocId)
        : contents[currentDocId] ?? ""
      : "";

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

  const importMarkdownDirectory = useCallback(
    async (files: File[]) => {
      if (!manifest || !currentDocId || files.length === 0) return;
      const targetDoc = manifest.docs[currentDocId];
      if (!targetDoc) return;

      const firstPath = files[0]?.webkitRelativePath || files[0]?.name || "folder";
      const rootDir = firstPath.split("/")[0] || "folder";
      const fileMap = new Map<string, File>();

      for (const file of files) {
        const rawPath = file.webkitRelativePath || file.name;
        const parts = rawPath.split("/");
        const relativePath = parts.length > 1 ? parts.slice(1).join("/") : rawPath;
        if (relativePath) fileMap.set(relativePath, file);
      }

      const markdownFiles = [...fileMap.keys()]
        .filter((path) => /\.mdx?$/i.test(path))
        .sort((a, b) => {
          const aDepth = a.split("/").length;
          const bDepth = b.split("/").length;
          if (aDepth !== bDepth) return aDepth - bDepth;
          return a.localeCompare(b);
        });

      if (markdownFiles.length === 0) {
        setSaveState("error");
        setStatusMessage("No .md files found in the selected folder.");
        return;
      }

      const entryPath = chooseImportEntryPath(markdownFiles, rootDir);
      if (!entryPath) {
        setSaveState("error");
        setStatusMessage("Unable to determine the markdown entry point for that folder.");
        return;
      }
      if (!fileMap.has(entryPath)) {
        setSaveState("error");
        setStatusMessage(`Markdown entry not found: ${entryPath}`);
        return;
      }

      setImportingDocs(true);
      setSaveState("saving");
      setStatusMessage(`Importing markdown from ${rootDir}...`);

      try {
        const reachable = await crawlMarkdownReachable(entryPath, fileMap);
        const imported = await buildImportedDocumentationData({
          entryPath,
          reachable,
          fileMap,
          rootTitle,
        });
        const merged = appendImportedDocumentation({
          existingManifest: manifest,
          existingContents: contents,
          importedManifest: imported.manifest,
          importedContents: imported.contents,
          targetDocId: currentDocId,
        });

        const previousManifest = manifest;
        const s3 = await getS3Client(storage.bucket);
        await Promise.all(
          imported.mediaFiles.map(async ({ relativePath, file }) => {
            const bytes = new Uint8Array(await file.arrayBuffer());
            await writeBinaryObject(
              s3,
              storage.bucket,
              getMediaKey(storage, relativePath),
              bytes,
              file.type || contentTypeForPath(file.name),
            );
          }),
        );
        await syncStructure(previousManifest, merged.manifest, merged.contents);

        setManifest(merged.manifest);
        setContents(merged.contents);
        setCurrentDocId(merged.focusDocId);
        setNeedsInitialPersist(false);
        setSaveState("saved");
        setStatusMessage(`Imported ${reachable.size} file${reachable.size === 1 ? "" : "s"} into ${targetDoc.title}.`);
      } catch (importError: unknown) {
        setSaveState("error");
        setStatusMessage((importError as Error).message);
      } finally {
        setImportingDocs(false);
      }
    },
    [contents, currentDocId, getS3Client, manifest, rootTitle, storage, syncStructure],
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
    return buildVisibleDocTree(manifest, expandedDocIds);
  }, [expandedDocIds, manifest]);

  useEffect(() => {
    if (!manifest) return;
    setExpandedDocIds((prev) => {
      const next = new Set(prev);
      for (const id of collectExpandableDocIds(manifest)) next.add(id);
      return next;
    });
  }, [manifest]);

  const toggleExpanded = useCallback((docId: string) => {
    setExpandedDocIds((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  }, []);

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
            const hasChildren = doc.children.length > 0;
            const expanded = expandedDocIds.has(id);
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
                <TreeToggle expanded={expanded} hasChildren={hasChildren} onClick={() => toggleExpanded(id)} />
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
              <ToolbarButton onClick={() => importDirectoryInputRef.current?.click()} label={importingDocs ? "Importing..." : "Import Folder"} />
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
              <input
                ref={importDirectoryInputRef}
                type="file"
                multiple
                disabled={importingDocs}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                  void importMarkdownDirectory(files);
                }}
                style={{ display: "none" }}
                {...{ webkitdirectory: "", directory: "" }}
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
              doc://{currentDoc.id} · {(currentDoc.kind ?? "page") === "section" ? "[section]" : currentDoc.relativePath}
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
    if ((doc.kind ?? "page") === "section" || !doc.relativePath) continue;
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
