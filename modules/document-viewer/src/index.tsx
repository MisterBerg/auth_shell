import React, { useState, useEffect, useRef, useCallback } from "react";
import type { ModuleProps } from "module-core";
import { useEditMode, useUpdateSlotMeta, useAwsS3Client } from "module-core";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import * as pdfjsLib from "pdfjs-dist";

// Use CDN worker — avoids bundling the worker into the IIFE
pdfjsLib.GlobalWorkerOptions.workerSrc =
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const C = {
  bg:      "#080f1c",
  bgBar:   "#0d1a2e",
  border:  "#1a2a42",
  text:    "#e5e7eb",
  muted:   "#6b7280",
  accent:  "#3b82f6",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DocMeta {
  key: string;       // S3 key
  filename: string;  // display name
}

// ---------------------------------------------------------------------------
// PDF renderer — renders all pages onto stacked canvases
// ---------------------------------------------------------------------------

interface PdfViewerProps {
  blobUrl: string;
  filename: string;
}

function PdfViewer({ blobUrl, filename }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = "";
    setPageCount(0);
    setError(undefined);

    pdfjsLib.getDocument({ url: blobUrl }).promise
      .then(async (pdf) => {
        if (cancelled) return;
        setPageCount(pdf.numPages);

        for (let i = 1; i <= pdf.numPages; i++) {
          if (cancelled) break;
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 1.5 });

          const wrapper = document.createElement("div");
          wrapper.style.cssText = `
            margin: 0 auto 12px;
            width: ${viewport.width}px;
            max-width: 100%;
            box-shadow: 0 2px 12px rgba(0,0,0,0.5);
            border-radius: 4px;
            overflow: hidden;
          `;

          const canvas = document.createElement("canvas");
          canvas.width  = viewport.width;
          canvas.height = viewport.height;
          canvas.style.cssText = "display:block;width:100%;height:auto;";
          wrapper.appendChild(canvas);
          container.appendChild(wrapper);

          const ctx = canvas.getContext("2d")!;
          await page.render({ canvasContext: ctx, viewport }).promise;
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message);
      });

    return () => { cancelled = true; };
  }, [blobUrl]);

  if (error) return (
    <div style={{ padding: "2rem", color: "#fca5a5", fontSize: "0.875rem" }}>
      Failed to render PDF: {error}
    </div>
  );

  return (
    <div style={{ height: "100%", overflowY: "auto", background: "#111827", padding: "1.5rem 1rem" }}>
      {pageCount > 0 && (
        <div style={{ textAlign: "center", marginBottom: "1rem", fontSize: "0.75rem", color: C.muted }}>
          {filename} — {pageCount} page{pageCount !== 1 ? "s" : ""}
        </div>
      )}
      <div ref={containerRef} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export default function DocumentViewer({ config }: ModuleProps) {
  const { editMode }   = useEditMode();
  const updateSlotMeta = useUpdateSlotMeta();
  const getS3Client    = useAwsS3Client();

  const params       = new URLSearchParams(window.location.search);
  const bucket       = params.get("bucket") ?? "";
  const configPath   = params.get("config") ?? "";
  const projectDir   = configPath.split("/").slice(0, -1).join("/");

  const savedMeta = config.meta as { doc?: DocMeta } | undefined;
  const [doc,       setDoc]       = useState<DocMeta | undefined>(savedMeta?.doc);
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | undefined>();
  const [loading,   setLoading]   = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);
  const [dragging,  setDragging]  = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load PDF from S3 whenever doc key changes
  useEffect(() => {
    if (!doc?.key) return;
    let cancelled = false;
    setLoading(true);
    setPdfBlobUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return undefined; });
    setLoadError(undefined);

    getS3Client(bucket)
      .then((s3) => s3.send(new GetObjectCommand({ Bucket: bucket, Key: doc.key })))
      .then((r) => r.Body!.transformToByteArray())
      .then((bytes) => {
        if (cancelled) return;
        const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" }));
        setPdfBlobUrl(url);
        setLoading(false);
      })
      .catch((e: unknown) => { if (!cancelled) { setLoadError((e as Error).message); setLoading(false); } });

    return () => { cancelled = true; };
  }, [doc?.key, bucket, getS3Client]);

  const upload = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setLoadError("Only PDF files are supported.");
      return;
    }
    setUploading(true);
    setLoadError(undefined);
    try {
      const s3Key = `${projectDir}/docs/${Date.now().toString(36)}-${file.name}`;
      const bytes = await file.arrayBuffer();
      const s3 = await getS3Client(bucket);
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: new Uint8Array(bytes),
        ContentType: "application/pdf",
      }));
      const newDoc: DocMeta = { key: s3Key, filename: file.name };
      setDoc(newDoc);
      if (updateSlotMeta) await updateSlotMeta({ doc: newDoc });
    } catch (e: unknown) {
      setLoadError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }, [bucket, projectDir, getS3Client, updateSlotMeta]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) upload(file);
  }, [upload]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) upload(file);
    e.target.value = "";
  }, [upload]);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (uploading) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: "1rem", background: C.bg, color: C.muted, fontSize: "0.875rem" }}>
        <div style={{ fontSize: "1.5rem" }}>⏫</div>
        Uploading…
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, color: C.muted, fontSize: "0.875rem" }}>
        Loading…
      </div>
    );
  }

  if (pdfBlobUrl && doc) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", background: C.bg }}>
        {/* toolbar */}
        <div style={{ height: 38, flexShrink: 0, background: C.bgBar, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", padding: "0 0.75rem", gap: "0.75rem" }}>
          <span style={{ fontSize: "0.8rem", color: C.text, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {doc.filename}
          </span>
          <button
            onClick={() => window.open(pdfBlobUrl, "_blank")}
            title="Open in new tab"
            style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: "0.75rem", padding: "2px 6px", borderRadius: 3 }}
          >
            ↗ Open
          </button>
          {editMode && (
            <button
              onClick={() => fileInputRef.current?.click()}
              title="Replace document"
              style={{ background: "none", border: `1px solid ${C.border}`, color: C.muted, cursor: "pointer", fontSize: "0.75rem", padding: "2px 8px", borderRadius: 3 }}
            >
              ↺ Replace
            </button>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <PdfViewer blobUrl={pdfBlobUrl} filename={doc.filename} />
        </div>
        <input ref={fileInputRef} type="file" accept=".pdf" style={{ display: "none" }} onChange={handleFileChange} />
      </div>
    );
  }

  // Empty / upload state
  if (!editMode) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, color: C.muted, fontSize: "0.875rem" }}>
        No document configured.
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: C.bg }}>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{
          flex: 1, margin: "2rem", display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: "0.75rem",
          border: `2px dashed ${dragging ? C.accent : C.border}`,
          borderRadius: 8, cursor: "pointer",
          background: dragging ? "rgba(59,130,246,0.06)" : "transparent",
          transition: "background 0.15s, border-color 0.15s",
        }}
      >
        {loadError && (
          <p style={{ margin: 0, fontSize: "0.8rem", color: "#fca5a5", textAlign: "center", maxWidth: 320 }}>
            {loadError}
          </p>
        )}
        <div style={{ fontSize: "2.5rem", opacity: dragging ? 1 : 0.4 }}>📄</div>
        <p style={{ margin: 0, fontSize: "0.9rem", color: dragging ? C.text : C.muted }}>
          Drop a PDF here, or click to browse
        </p>
      </div>
      <input ref={fileInputRef} type="file" accept=".pdf" style={{ display: "none" }} onChange={handleFileChange} />
    </div>
  );
}
