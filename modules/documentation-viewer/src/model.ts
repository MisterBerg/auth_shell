import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

export type StorageConfig = {
  bucket: string;
  manifestKey: string;
  pagesPrefix: string;
};

export type DocRecord = {
  id: string;
  title: string;
  parentId: string | null;
  children: string[];
  slug: string;
  relativePath: string;
  createdAt: string;
  updatedAt: string;
};

export type DocumentationManifest = {
  version: 1;
  rootDocId: string;
  docs: Record<string, DocRecord>;
};

export type ContentMap = Record<string, string>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "page"
  );
}

export function createDocId(): string {
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx) : "";
}

export function withoutExtension(path: string): string {
  return path.replace(/\.md$/i, "");
}

export function getDocKey(storage: StorageConfig, relativePath: string): string {
  return `${storage.pagesPrefix}/${relativePath}`;
}

export function getStorageConfig(config: {
  id: string;
  app: { bucket: string };
  meta?: Record<string, unknown>;
}): StorageConfig {
  const params = new URLSearchParams(window.location.search);
  const bucket =
    (config.meta?.["storageBucket"] as string | undefined) ??
    params.get("bucket") ??
    config.app.bucket;

  const manifestKeyFromMeta = config.meta?.["manifestKey"] as string | undefined;
  const pagesPrefixFromMeta = config.meta?.["pagesPrefix"] as string | undefined;

  if (manifestKeyFromMeta && pagesPrefixFromMeta) {
    return { bucket, manifestKey: manifestKeyFromMeta, pagesPrefix: pagesPrefixFromMeta };
  }

  const configPath = params.get("config") ?? "";
  const projectDir = dirname(configPath);
  const basePrefix = projectDir
    ? `${projectDir}/documentation/${config.id}`
    : `documentation/${config.id}`;

  return {
    bucket,
    manifestKey: `${basePrefix}/manifest.json`,
    pagesPrefix: `${basePrefix}/pages`,
  };
}

export function createDefaultManifest(title: string): DocumentationManifest {
  const createdAt = nowIso();
  const rootDocId = "root";
  return {
    version: 1,
    rootDocId,
    docs: {
      [rootDocId]: {
        id: rootDocId,
        title,
        parentId: null,
        children: [],
        slug: "index",
        relativePath: "index.md",
        createdAt,
        updatedAt: createdAt,
      },
    },
  };
}

export function createDefaultRootContent(title: string): string {
  return `# ${title}\n\nStart documenting your project here.\n`;
}

export function deepCloneManifest(manifest: DocumentationManifest): DocumentationManifest {
  return JSON.parse(JSON.stringify(manifest)) as DocumentationManifest;
}

export function ensureUniqueSlug(
  manifest: DocumentationManifest,
  parentId: string,
  desiredSlug: string,
  excludeDocId?: string
): string {
  const siblings = manifest.docs[parentId].children;
  const used = new Set(
    siblings
      .filter((id) => id !== excludeDocId)
      .map((id) => manifest.docs[id]?.slug)
      .filter((slug): slug is string => !!slug)
  );

  let slug = desiredSlug || "page";
  let counter = 2;
  while (used.has(slug)) {
    slug = `${desiredSlug || "page"}-${counter}`;
    counter += 1;
  }
  return slug;
}

export function assignPaths(manifest: DocumentationManifest): DocumentationManifest {
  const next = deepCloneManifest(manifest);
  const root = next.docs[next.rootDocId];
  root.slug = "index";
  root.relativePath = "index.md";

  const walk = (docId: string) => {
    const parent = next.docs[docId];
    const baseDir = docId === next.rootDocId ? "" : withoutExtension(parent.relativePath);

    for (const childId of parent.children) {
      const child = next.docs[childId];
      if (!child) continue;
      child.slug = ensureUniqueSlug(next, docId, child.slug || slugify(child.title), child.id);
      const filename = `${child.slug}.md`;
      child.relativePath = baseDir ? `${baseDir}/${filename}` : filename;
      walk(childId);
    }
  };

  walk(next.rootDocId);
  return next;
}

export function insertDocAtCursor(
  source: string,
  selectionStart: number,
  selectionEnd: number,
  insertedText: string
): { nextValue: string; nextSelectionStart: number; nextSelectionEnd: number } {
  const nextValue =
    source.slice(0, selectionStart) + insertedText + source.slice(selectionEnd);
  const caret = selectionStart + insertedText.length;
  return { nextValue, nextSelectionStart: caret, nextSelectionEnd: caret };
}

export function wrapSelection(
  source: string,
  selectionStart: number,
  selectionEnd: number,
  before: string,
  after: string,
  placeholder: string
): { nextValue: string; nextSelectionStart: number; nextSelectionEnd: number } {
  const selected = source.slice(selectionStart, selectionEnd) || placeholder;
  const wrapped = `${before}${selected}${after}`;
  const nextValue =
    source.slice(0, selectionStart) + wrapped + source.slice(selectionEnd);
  const nextSelectionStart = selectionStart + before.length;
  const nextSelectionEnd = nextSelectionStart + selected.length;
  return { nextValue, nextSelectionStart, nextSelectionEnd };
}

export type LinkAction = "child" | "sibling";

export function createLinkedPage(
  manifest: DocumentationManifest,
  contents: ContentMap,
  currentDocId: string,
  title: string,
  action: LinkAction
): { manifest: DocumentationManifest; contents: ContentMap; newDocId: string } {
  const createdAt = nowIso();
  const nextManifest = deepCloneManifest(manifest);
  const nextContents = { ...contents };
  const newDocId = createDocId();
  const targetParentId =
    action === "child"
      ? currentDocId
      : nextManifest.docs[currentDocId].parentId ?? nextManifest.rootDocId;

  const slug = ensureUniqueSlug(nextManifest, targetParentId, slugify(title));
  nextManifest.docs[newDocId] = {
    id: newDocId,
    title,
    parentId: targetParentId,
    children: [],
    slug,
    relativePath: "",
    createdAt,
    updatedAt: createdAt,
  };

  if (action === "child") {
    nextManifest.docs[targetParentId].children.push(newDocId);
  } else {
    const siblings = nextManifest.docs[targetParentId].children;
    const currentIndex = siblings.indexOf(currentDocId);
    siblings.splice(currentIndex + 1, 0, newDocId);
  }

  nextContents[newDocId] = `# ${title}\n\n`;
  return { manifest: assignPaths(nextManifest), contents: nextContents, newDocId };
}

export function renameDoc(
  manifest: DocumentationManifest,
  docId: string,
  title: string
): DocumentationManifest {
  const next = deepCloneManifest(manifest);
  next.docs[docId].title = title;
  next.docs[docId].updatedAt = nowIso();
  return next;
}

export function removeDoc(
  manifest: DocumentationManifest,
  contents: ContentMap,
  docId: string
): { manifest: DocumentationManifest; contents: ContentMap; nextSelectedId: string } {
  const nextManifest = deepCloneManifest(manifest);
  const nextContents = { ...contents };
  const doc = nextManifest.docs[docId];
  if (!doc.parentId) {
    throw new Error("The root document cannot be removed.");
  }

  const collect = (id: string, acc: string[]) => {
    acc.push(id);
    for (const childId of nextManifest.docs[id].children) collect(childId, acc);
    return acc;
  };

  const removedIds = collect(docId, []);
  nextManifest.docs[doc.parentId].children = nextManifest.docs[doc.parentId].children.filter(
    (id) => id !== docId
  );

  for (const removedId of removedIds) {
    delete nextManifest.docs[removedId];
    delete nextContents[removedId];
  }

  const siblings = nextManifest.docs[doc.parentId].children;
  const nextSelectedId = siblings[siblings.length - 1] ?? doc.parentId;
  return {
    manifest: assignPaths(nextManifest),
    contents: nextContents,
    nextSelectedId,
  };
}

export type MoveDirection = "up" | "down" | "promote" | "demote";

export function moveDoc(
  manifest: DocumentationManifest,
  docId: string,
  direction: MoveDirection
): DocumentationManifest {
  const next = deepCloneManifest(manifest);
  const doc = next.docs[docId];
  if (!doc.parentId) return next;

  const siblings = next.docs[doc.parentId].children;
  const currentIndex = siblings.indexOf(docId);
  if (currentIndex < 0) return next;

  if (direction === "up" && currentIndex > 0) {
    [siblings[currentIndex - 1], siblings[currentIndex]] = [
      siblings[currentIndex],
      siblings[currentIndex - 1],
    ];
    return assignPaths(next);
  }

  if (direction === "down" && currentIndex < siblings.length - 1) {
    [siblings[currentIndex + 1], siblings[currentIndex]] = [
      siblings[currentIndex],
      siblings[currentIndex + 1],
    ];
    return assignPaths(next);
  }

  if (direction === "demote" && currentIndex > 0) {
    const previousSiblingId = siblings[currentIndex - 1];
    siblings.splice(currentIndex, 1);
    next.docs[previousSiblingId].children.push(docId);
    doc.parentId = previousSiblingId;
    doc.slug = ensureUniqueSlug(next, previousSiblingId, doc.slug, doc.id);
    return assignPaths(next);
  }

  if (direction === "promote") {
    const parent = next.docs[doc.parentId];
    if (!parent.parentId) return next;
    const grandSiblings = next.docs[parent.parentId].children;
    const parentIndex = grandSiblings.indexOf(parent.id);
    siblings.splice(currentIndex, 1);
    grandSiblings.splice(parentIndex + 1, 0, docId);
    doc.parentId = parent.parentId;
    doc.slug = ensureUniqueSlug(next, parent.parentId, doc.slug, doc.id);
    return assignPaths(next);
  }

  return next;
}

export function rewriteDocLinksForExport(
  markdown: string,
  manifest: DocumentationManifest,
  sourceId: string
): string {
  return markdown.replace(/\]\(((?:doc:\/\/|#doc:)[a-z0-9-]+)\)/gi, (_, target) => {
    const targetId = String(target)
      .replace(/^doc:\/\//i, "")
      .replace(/^#doc:/i, "");
    const sourceDoc = manifest.docs[sourceId];
    const targetDoc = manifest.docs[targetId];
    if (!sourceDoc || !targetDoc) return `](#broken-link-${targetId})`;

    const sourceParts = sourceDoc.relativePath.split("/");
    sourceParts.pop();
    const targetParts = targetDoc.relativePath.split("/");

    while (
      sourceParts.length > 0 &&
      targetParts.length > 0 &&
      sourceParts[0] === targetParts[0]
    ) {
      sourceParts.shift();
      targetParts.shift();
    }

    const relative = `${"../".repeat(sourceParts.length)}${targetParts.join("/")}` || "./";
    return `](${relative})`;
  });
}

export async function readTextObject(s3: S3Client, bucket: string, key: string): Promise<string> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return response.Body!.transformToString("utf-8");
}

export async function readOptionalTextObject(
  s3: S3Client,
  bucket: string,
  key: string
): Promise<string | null> {
  try {
    return await readTextObject(s3, bucket, key);
  } catch (error: unknown) {
    const err = error as {
      name?: string;
      Code?: string;
      code?: string;
      $metadata?: { httpStatusCode?: number };
      statusCode?: number;
    };
    const status = err.$metadata?.httpStatusCode ?? err.statusCode;
    const code = err.name ?? err.Code ?? err.code;
    if (
      code === "NoSuchKey" ||
      code === "NotFound" ||
      code === "NoSuchBucket" ||
      error instanceof NoSuchKey ||
      status === 404
    ) {
      return null;
    }
    throw error;
  }
}

export async function writeTextObject(
  s3: S3Client,
  bucket: string,
  key: string,
  body: string,
  contentType: string
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "no-store",
    })
  );
}

export async function deleteObjectIfExists(s3: S3Client, bucket: string, key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    // best effort cleanup
  }
}

export async function loadDocumentationState(
  s3: S3Client,
  storage: StorageConfig,
  title: string
): Promise<{ manifest: DocumentationManifest; contents: ContentMap; needsInitialPersist: boolean }> {
  const manifestText = await readOptionalTextObject(s3, storage.bucket, storage.manifestKey);
  if (!manifestText) {
    const manifest = createDefaultManifest(title);
    return {
      manifest,
      contents: {
        [manifest.rootDocId]: createDefaultRootContent(title),
      },
      needsInitialPersist: true,
    };
  }

  const manifest = assignPaths(JSON.parse(manifestText) as DocumentationManifest);
  const contentEntries = await Promise.all(
    Object.values(manifest.docs).map(async (doc) => {
      const content =
        (await readOptionalTextObject(s3, storage.bucket, getDocKey(storage, doc.relativePath))) ??
        `# ${doc.title}\n\n`;
      return [doc.id, content] as const;
    })
  );

  return {
    manifest,
    contents: Object.fromEntries(contentEntries),
    needsInitialPersist: false,
  };
}
