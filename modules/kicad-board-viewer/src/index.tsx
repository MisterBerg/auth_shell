import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ModuleProps } from "module-core";
import { useAwsS3Client, useEditMode, useUpdateSlotMeta } from "module-core";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

type BoardMeta = {
  key: string;
  filename: string;
};

type BoardPoint = {
  x: number;
  y: number;
};

type BoardTrack = {
  id: string;
  net: string;
  layer: string;
  start: BoardPoint;
  end: BoardPoint;
  width?: number;
};

type BoardVia = {
  id: string;
  net: string;
  at: BoardPoint;
  diameter?: number;
};

type BoardPad = {
  id: string;
  net: string;
  ref: string;
  value?: string;
  footprint?: string;
  pad: string;
  pinFunction?: string;
  at: BoardPoint;
  size?: { x: number; y: number };
  shape?: string;
  layer?: string;
  rotation?: number;
};

type BoardEdge = {
  id: string;
  start: BoardPoint;
  end: BoardPoint;
};

type BoardNet = {
  name: string;
  code?: number;
};

type BoardArtifact = {
  schema: "jeffspace.kicad-board.v1";
  source?: {
    file?: string;
    exportedAt?: string;
    exporter?: string;
  };
  units: "mm";
  nets: BoardNet[];
  tracks: BoardTrack[];
  vias: BoardVia[];
  pads: BoardPad[];
  edges?: BoardEdge[];
};

type Bounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type Viewport = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type LayerViewMode = "all" | "exterior" | "top" | "bottom";

type DragState = {
  startX: number;
  startY: number;
  originCenter: BoardPoint;
};

const C = {
  bg: "#080f1c",
  panel: "#0b1525",
  toolbar: "#0d1a2e",
  border: "#1a2a42",
  text: "#e5e7eb",
  muted: "#6b7280",
  faint: "#334155",
  accent: "#38bdf8",
  highlight: "#facc15",
  componentPad: "#22c55e",
  track: "#2563eb",
  bottomTrack: "#dc2626",
  pad: "#94a3b8",
  edge: "#e2e8f0",
  error: "#fca5a5",
};

function getProjectUploadTarget(configId: string): { bucket: string; prefix: string } {
  const params = new URLSearchParams(window.location.search);
  const bucket = params.get("bucket") ?? "";
  const configPath = params.get("config") ?? "";
  const projectDir = configPath.split("/").slice(0, -1).join("/");
  return {
    bucket,
    prefix: projectDir ? `${projectDir}/boards/${configId}` : `boards/${configId}`,
  };
}

function validateArtifact(value: unknown): BoardArtifact {
  const artifact = value as Partial<BoardArtifact>;
  if (artifact.schema !== "jeffspace.kicad-board.v1") {
    throw new Error("Unsupported board JSON. Expected schema jeffspace.kicad-board.v1.");
  }
  if (!Array.isArray(artifact.nets) || !Array.isArray(artifact.tracks) || !Array.isArray(artifact.pads)) {
    throw new Error("Invalid board JSON. Missing nets, tracks, or pads.");
  }
  return {
    schema: artifact.schema,
    source: artifact.source,
    units: artifact.units ?? "mm",
    nets: artifact.nets,
    tracks: artifact.tracks,
    vias: artifact.vias ?? [],
    pads: artifact.pads,
    edges: artifact.edges ?? [],
  };
}

function boundsFor(board: BoardArtifact): Bounds {
  const points: BoardPoint[] = [];
  for (const track of board.tracks) points.push(track.start, track.end);
  for (const via of board.vias) points.push(via.at);
  for (const pad of board.pads) points.push(pad.at);
  for (const edge of board.edges ?? []) points.push(edge.start, edge.end);

  if (points.length === 0) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function baseViewportFor(bounds: Bounds): Viewport {
  const width = Math.max(bounds.maxX - bounds.minX, 10);
  const height = Math.max(bounds.maxY - bounds.minY, 10);
  const pad = Math.max(width, height) * 0.08;
  return {
    x: bounds.minX - pad,
    y: bounds.minY - pad,
    width: width + pad * 2,
    height: height + pad * 2,
  };
}

function viewBoxFor(viewport: Viewport): string {
  return `${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`;
}

function colorForTrack(layer: string, active: boolean): string {
  if (active) return C.highlight;
  if (layer === "B.Cu") return C.bottomTrack;
  if (layer === "F.Cu") return C.track;
  return "#64748b";
}

function layerOpacity(layer: string, selectedNet: string | null, net: string): number {
  if (!selectedNet) return layer === "F.Cu" || layer === "B.Cu" ? 0.82 : 0.45;
  return selectedNet === net ? 1 : 0.12;
}

function sortedNetNames(board: BoardArtifact): string[] {
  const names = new Set(board.nets.map((net) => net.name).filter(Boolean));
  for (const track of board.tracks) names.add(track.net);
  for (const via of board.vias) names.add(via.net);
  for (const pad of board.pads) names.add(pad.net);
  return [...names].sort((a, b) => a.localeCompare(b));
}

function formatPad(pad: BoardPad): string {
  const pin = pad.pinFunction ? ` ${pad.pinFunction}` : "";
  return `${pad.ref}.${pad.pad}${pin}`;
}

function padAccessMode(pad: BoardPad): "top" | "bottom" | "through" | "unknown" {
  if (pad.layer === "*.Cu") return "through";
  if (pad.layer === "F.Cu") return "top";
  if (pad.layer === "B.Cu") return "bottom";
  return "unknown";
}

function trackVisible(layer: string, mode: LayerViewMode): boolean {
  if (mode === "all") return true;
  if (mode === "exterior") return layer === "F.Cu" || layer === "B.Cu";
  if (mode === "top") return layer === "F.Cu";
  return layer === "B.Cu";
}

function padVisible(pad: BoardPad, mode: LayerViewMode): boolean {
  const access = padAccessMode(pad);
  if (mode === "all" || mode === "exterior") return access !== "unknown";
  if (mode === "top") return access === "top" || access === "through";
  return access === "bottom" || access === "through";
}

function padAccessLabel(pad: BoardPad): string {
  const access = padAccessMode(pad);
  if (access === "through") return "top + bottom";
  if (access === "top") return "top side";
  if (access === "bottom") return "bottom side";
  return "unknown side";
}

function clampViewportCenter(center: BoardPoint, baseViewport: Viewport, zoom: number): BoardPoint {
  const width = baseViewport.width / zoom;
  const height = baseViewport.height / zoom;
  const minX = baseViewport.x + width / 2;
  const maxX = baseViewport.x + baseViewport.width - width / 2;
  const minY = baseViewport.y + height / 2;
  const maxY = baseViewport.y + baseViewport.height - height / 2;
  return {
    x: Math.min(maxX, Math.max(minX, center.x)),
    y: Math.min(maxY, Math.max(minY, center.y)),
  };
}

export default function KiCadBoardViewer({ config }: ModuleProps) {
  const { editMode } = useEditMode();
  const updateSlotMeta = useUpdateSlotMeta();
  const getS3Client = useAwsS3Client();
  const uploadTarget = useMemo(() => getProjectUploadTarget(config.id), [config.id]);
  const savedMeta = config.meta as { board?: BoardMeta } | undefined;

  const [boardMeta, setBoardMeta] = useState<BoardMeta | undefined>(savedMeta?.board);
  const [board, setBoard] = useState<BoardArtifact | undefined>();
  const [selectedNet, setSelectedNet] = useState<string | null>(null);
  const [focusedPadId, setFocusedPadId] = useState<string | null>(null);
  const [layerMode, setLayerMode] = useState<LayerViewMode>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setBoardMeta(savedMeta?.board);
  }, [savedMeta?.board?.key, savedMeta?.board?.filename]);

  useEffect(() => {
    if (!boardMeta?.key || !uploadTarget.bucket) {
      setBoard(undefined);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(undefined);
    getS3Client(uploadTarget.bucket)
      .then((s3) => s3.send(new GetObjectCommand({ Bucket: uploadTarget.bucket, Key: boardMeta.key })))
      .then((response) => response.Body!.transformToString("utf-8"))
      .then((text) => {
        if (cancelled) return;
        const parsed = validateArtifact(JSON.parse(text));
        setBoard(parsed);
        setSelectedNet((current) => current && sortedNetNames(parsed).includes(current) ? current : null);
        setFocusedPadId(null);
        setLoading(false);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError((loadError as Error).message);
          setBoard(undefined);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [boardMeta?.key, getS3Client, uploadTarget.bucket]);

  const uploadBoard = useCallback(async (file: File) => {
    if (!uploadTarget.bucket) {
      setError("No project bucket is available in the current URL.");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".json")) {
      setError("Upload the JSON artifact generated by scripts/kicad/export-board-viewer.ts.");
      return;
    }

    setUploading(true);
    setError(undefined);
    try {
      const text = await file.text();
      const parsed = validateArtifact(JSON.parse(text));
      const key = `${uploadTarget.prefix}/${Date.now().toString(36)}-${file.name}`;
      const s3 = await getS3Client(uploadTarget.bucket);
      await s3.send(new PutObjectCommand({
        Bucket: uploadTarget.bucket,
        Key: key,
        Body: text,
        ContentType: "application/json",
        CacheControl: "no-store",
      }));

      const nextMeta = { key, filename: file.name };
      setBoardMeta(nextMeta);
      setBoard(parsed);
      setSelectedNet(null);
      setFocusedPadId(null);
      if (updateSlotMeta) await updateSlotMeta({ board: nextMeta });
    } catch (uploadError: unknown) {
      setError((uploadError as Error).message);
    } finally {
      setUploading(false);
    }
  }, [getS3Client, updateSlotMeta, uploadTarget.bucket, uploadTarget.prefix]);

  const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void uploadBoard(file);
  }, [uploadBoard]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void uploadBoard(file);
  }, [uploadBoard]);

  if (uploading || loading) {
    return (
      <Centered>
        {uploading ? "Uploading board artifact..." : "Loading board artifact..."}
      </Centered>
    );
  }

  if (!board) {
    if (!editMode) {
      return <Centered>{error ?? "No KiCad board artifact configured."}</Centered>;
    }

    return (
      <div style={dropShellStyle}>
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            ...dropZoneStyle,
            borderColor: dragging ? C.accent : C.border,
            background: dragging ? "rgba(56, 189, 248, 0.08)" : "transparent",
          }}
        >
          {error && <p style={{ margin: 0, color: C.error, fontSize: "0.82rem" }}>{error}</p>}
          <div style={{ fontSize: "0.78rem", color: C.muted, textTransform: "uppercase", letterSpacing: "0.12em" }}>
            KiCad Board Viewer
          </div>
          <p style={{ margin: 0, color: C.text, fontSize: "0.95rem", fontWeight: 700 }}>
            Drop a board-viewer JSON artifact, or click to browse
          </p>
          <p style={{ margin: 0, color: C.muted, fontSize: "0.78rem", maxWidth: 520, lineHeight: 1.6, textAlign: "center" }}>
            Generate one with: npm run kicad:export-board -- --pcb path/to/board.kicad_pcb --out board-viewer.json
          </p>
        </div>
        <input ref={fileInputRef} type="file" accept=".json,application/json" onChange={handleFileChange} style={{ display: "none" }} />
      </div>
    );
  }

  return (
    <BoardExplorer
      board={board}
      filename={boardMeta?.filename}
      selectedNet={selectedNet}
      focusedPadId={focusedPadId}
      layerMode={layerMode}
      query={query}
      editMode={editMode}
      error={error}
      onSelectNet={setSelectedNet}
      onFocusPad={setFocusedPadId}
      onLayerModeChange={setLayerMode}
      onQueryChange={setQuery}
      onReplace={() => fileInputRef.current?.click()}
    >
      <input ref={fileInputRef} type="file" accept=".json,application/json" onChange={handleFileChange} style={{ display: "none" }} />
    </BoardExplorer>
  );
}

function BoardExplorer({
  board,
  filename,
  selectedNet,
  focusedPadId,
  layerMode,
  query,
  editMode,
  error,
  children,
  onSelectNet,
  onFocusPad,
  onLayerModeChange,
  onQueryChange,
  onReplace,
}: {
  board: BoardArtifact;
  filename?: string;
  selectedNet: string | null;
  focusedPadId: string | null;
  layerMode: LayerViewMode;
  query: string;
  editMode: boolean;
  error?: string;
  children: React.ReactNode;
  onSelectNet: (net: string | null) => void;
  onFocusPad: (padId: string | null) => void;
  onLayerModeChange: (mode: LayerViewMode) => void;
  onQueryChange: (query: string) => void;
  onReplace: () => void;
}) {
  const bounds = useMemo(() => boundsFor(board), [board]);
  const baseViewport = useMemo(() => baseViewportFor(bounds), [bounds]);
  const boardPaneRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [viewportCenter, setViewportCenter] = useState<BoardPoint>({
    x: baseViewport.x + baseViewport.width / 2,
    y: baseViewport.y + baseViewport.height / 2,
  });
  const netNames = useMemo(() => sortedNetNames(board), [board]);
  const filteredNets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? netNames.filter((net) => net.toLowerCase().includes(normalized))
      : netNames;
  }, [netNames, query]);
  const selectedPads = useMemo(() => {
    if (!selectedNet) return [];
    return board.pads
      .filter((pad) => pad.net === selectedNet && padVisible(pad, layerMode))
      .sort((a, b) => a.ref.localeCompare(b.ref) || a.pad.localeCompare(b.pad));
  }, [board.pads, layerMode, selectedNet]);
  const visibleTrackCount = useMemo(
    () => selectedNet ? board.tracks.filter((track) => track.net === selectedNet && trackVisible(track.layer, layerMode)).length : 0,
    [board.tracks, layerMode, selectedNet]
  );
  const visibleViaCount = useMemo(
    () => selectedNet ? board.vias.filter((via) => via.net === selectedNet).length : 0,
    [board.vias, selectedNet]
  );
  const visibleLayers = useMemo(() => {
    if (!selectedNet) return [] as string[];
    return [...new Set(
      board.tracks
        .filter((track) => track.net === selectedNet && trackVisible(track.layer, layerMode))
        .map((track) => track.layer)
    )].sort();
  }, [board.tracks, layerMode, selectedNet]);
  const selectedTrackCount = selectedNet
    ? board.tracks.filter((track) => track.net === selectedNet).length
    : 0;
  const selectedViaCount = selectedNet
    ? board.vias.filter((via) => via.net === selectedNet).length
    : 0;

  useEffect(() => {
    setZoom(1);
    setViewportCenter({
      x: baseViewport.x + baseViewport.width / 2,
      y: baseViewport.y + baseViewport.height / 2,
    });
  }, [baseViewport.x, baseViewport.y, baseViewport.width, baseViewport.height]);

  useEffect(() => {
    if (!focusedPadId) return;
    const pad = board.pads.find((item) => item.id === focusedPadId);
    if (!pad) return;

    setViewportCenter(clampViewportCenter(pad.at, baseViewport, zoom));
  }, [baseViewport, board.pads, focusedPadId, zoom]);

  useEffect(() => {
    setViewportCenter((current) => clampViewportCenter(current, baseViewport, zoom));
  }, [baseViewport, zoom]);

  const adjustZoom = useCallback((delta: number) => {
    setZoom((current) => {
      const next = Math.min(18, Math.max(1, Number((current * delta).toFixed(4))));
      return next;
    });
  }, []);

  const resetView = useCallback(() => {
    setZoom(1);
    setViewportCenter({
      x: baseViewport.x + baseViewport.width / 2,
      y: baseViewport.y + baseViewport.height / 2,
    });
  }, [baseViewport]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 1 / 1.12 : 1.12;
    setZoom((current) => {
      const next = Math.min(18, Math.max(1, Number((current * factor).toFixed(4))));
      return next;
    });
  }, []);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originCenter: viewportCenter,
    };
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [viewportCenter]);

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragStateRef.current = null;
    setIsPanning(false);
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    const element = boardPaneRef.current;
    if (!drag || !element) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const unitsPerPixelX = (baseViewport.width / zoom) / Math.max(element.clientWidth, 1);
    const unitsPerPixelY = (baseViewport.height / zoom) / Math.max(element.clientHeight, 1);

    setViewportCenter(clampViewportCenter({
      x: drag.originCenter.x - dx * unitsPerPixelX,
      y: drag.originCenter.y - dy * unitsPerPixelY,
    }, baseViewport, zoom));
  }, [baseViewport, zoom]);

  const viewport: Viewport = {
    x: viewportCenter.x - baseViewport.width / zoom / 2,
    y: viewportCenter.y - baseViewport.height / zoom / 2,
    width: baseViewport.width / zoom,
    height: baseViewport.height / zoom,
  };

  return (
    <div style={{ height: "100%", minHeight: 0, display: "flex", background: C.bg, color: C.text, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <aside style={{ width: 300, flexShrink: 0, borderRight: `1px solid ${C.border}`, background: C.panel, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "0.9rem 1rem", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: "0.76rem", color: C.muted, textTransform: "uppercase", letterSpacing: "0.11em" }}>Board</div>
          <div style={{ marginTop: "0.35rem", fontSize: "0.95rem", fontWeight: 750, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {filename ?? board.source?.file ?? "KiCad board"}
          </div>
          <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.76rem" }}>
            {netNames.length} nets, {board.tracks.length} tracks, {board.pads.length} pads
          </div>
          {editMode && (
            <button type="button" onClick={onReplace} style={replaceButtonStyle}>
              Replace artifact
            </button>
          )}
          {error && <div style={{ marginTop: "0.5rem", color: C.error, fontSize: "0.78rem" }}>{error}</div>}
        </div>

        <div style={{ padding: "0.75rem", borderBottom: `1px solid ${C.border}` }}>
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Filter nets..."
            style={searchStyle}
          />
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0.4rem" }}>
          <button
            type="button"
            onClick={() => onSelectNet(null)}
            style={netButtonStyle(!selectedNet)}
          >
            All nets
          </button>
          {filteredNets.map((net) => (
            <button
              key={net}
              type="button"
              onClick={() => onSelectNet(net)}
              style={netButtonStyle(selectedNet === net)}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{net}</span>
              <span style={{ color: C.muted, fontSize: "0.72rem" }}>
                {board.pads.filter((pad) => pad.net === net).length}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ height: 44, flexShrink: 0, borderBottom: `1px solid ${C.border}`, background: C.toolbar, display: "flex", alignItems: "center", gap: "1rem", padding: "0 0.9rem" }}>
          <div style={{ fontSize: "0.82rem", color: C.muted }}>
            Selected: <span style={{ color: selectedNet ? C.highlight : C.text, fontWeight: 750 }}>{selectedNet ?? "all nets"}</span>
          </div>
          {selectedNet && (
            <div style={{ fontSize: "0.78rem", color: C.muted }}>
              {visibleTrackCount}/{selectedTrackCount} tracks, {visibleViaCount}/{selectedViaCount} vias, {selectedPads.length} visible pads
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
            <button type="button" onClick={() => adjustZoom(1 / 1.25)} style={zoomButtonStyle}>-</button>
            <div style={{ minWidth: 60, textAlign: "center", fontSize: "0.76rem", color: C.muted }}>
              {Math.round(zoom * 100)}%
            </div>
            <button type="button" onClick={() => adjustZoom(1.25)} style={zoomButtonStyle}>+</button>
            <button type="button" onClick={resetView} style={zoomButtonStyle}>Reset</button>
          </div>
          <div style={{ marginLeft: "auto", fontSize: "0.72rem", color: C.faint }}>
            Coordinates in {board.units}
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <div
            ref={boardPaneRef}
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            style={{ flex: 1, minWidth: 0, minHeight: 0, background: "#020617", touchAction: "none", cursor: isPanning ? "grabbing" : "grab" }}
          >
            <BoardSvg
              board={board}
              selectedNet={selectedNet}
              focusedPadId={focusedPadId}
              layerMode={layerMode}
              viewport={viewport}
              onSelectNet={onSelectNet}
            />
          </div>
          <section style={{ width: 330, flexShrink: 0, borderLeft: `1px solid ${C.border}`, background: C.panel, overflowY: "auto" }}>
            <NetDetails
              net={selectedNet}
              pads={selectedPads}
              trackCount={visibleTrackCount}
              layers={visibleLayers}
              layerMode={layerMode}
              onFocusPad={onFocusPad}
              onLayerModeChange={onLayerModeChange}
            />
          </section>
        </div>
      </main>
      {children}
    </div>
  );
}

function BoardSvg({
  board,
  selectedNet,
  focusedPadId,
  layerMode,
  viewport,
  onSelectNet,
}: {
  board: BoardArtifact;
  selectedNet: string | null;
  focusedPadId: string | null;
  layerMode: LayerViewMode;
  viewport: Viewport;
  onSelectNet: (net: string) => void;
}) {
  const focusedPad = focusedPadId ? board.pads.find((pad) => pad.id === focusedPadId) : undefined;
  const focusedRef = focusedPad?.ref;

  return (
    <svg viewBox={viewBoxFor(viewport)} style={{ width: "100%", height: "100%", display: "block" }}>
      <g>
        {(board.edges ?? []).map((edge) => (
          <line
            key={edge.id}
            x1={edge.start.x}
            y1={edge.start.y}
            x2={edge.end.x}
            y2={edge.end.y}
            stroke={C.edge}
            strokeWidth={0.08}
            vectorEffect="non-scaling-stroke"
            opacity={0.72}
          />
        ))}
      </g>
      <g>
        {board.tracks.filter((track) => trackVisible(track.layer, layerMode)).map((track) => {
          const active = selectedNet === track.net;
          return (
            <line
              key={track.id}
              x1={track.start.x}
              y1={track.start.y}
              x2={track.end.x}
              y2={track.end.y}
              stroke={colorForTrack(track.layer, active)}
              strokeWidth={Math.max(track.width ?? 0.16, active ? 0.28 : 0.14)}
              strokeLinecap="round"
              opacity={layerOpacity(track.layer, selectedNet, track.net)}
              onClick={() => onSelectNet(track.net)}
              style={{ cursor: "pointer" }}
            />
          );
        })}
      </g>
      <g>
        {board.vias.map((via) => {
          const active = selectedNet === via.net;
          const radius = Math.max((via.diameter ?? 0.55) / 2, active ? 0.36 : 0.22);
          return (
            <circle
              key={via.id}
              cx={via.at.x}
              cy={via.at.y}
              r={radius}
              fill={active ? C.highlight : "#a78bfa"}
              stroke="#020617"
              strokeWidth={0.08}
              opacity={selectedNet && !active ? 0.18 : 0.86}
              onClick={() => onSelectNet(via.net)}
              style={{ cursor: "pointer" }}
            />
          );
        })}
      </g>
      <g>
        {board.pads.filter((pad) => padVisible(pad, layerMode)).map((pad) => {
          const active = selectedNet === pad.net;
          const focused = focusedPadId === pad.id;
          const sameComponent = !!focusedRef && pad.ref === focusedRef;
          const componentSibling = sameComponent && !focused;
          const sx = Math.max(pad.size?.x ?? 0.8, 0.36);
          const sy = Math.max(pad.size?.y ?? 0.8, 0.36);
          return (
            <rect
              key={pad.id}
              x={pad.at.x - sx / 2}
              y={pad.at.y - sy / 2}
              width={sx}
              height={sy}
              rx={Math.min(sx, sy) * 0.22}
              fill={focused || active ? C.highlight : componentSibling ? C.componentPad : C.pad}
              stroke={focused ? C.accent : componentSibling ? "#86efac" : active ? "#fef3c7" : "#0f172a"}
              strokeWidth={focused ? 0.2 : componentSibling ? 0.12 : active ? 0.12 : 0.06}
              opacity={selectedNet && !active ? 0.18 : 0.9}
              transform={pad.rotation ? `rotate(${pad.rotation} ${pad.at.x} ${pad.at.y})` : undefined}
              onClick={() => onSelectNet(pad.net)}
              style={{ cursor: "pointer" }}
            />
          );
        })}
      </g>
    </svg>
  );
}

function NetDetails({
  net,
  pads,
  trackCount,
  layers,
  layerMode,
  onFocusPad,
  onLayerModeChange,
}: {
  net: string | null;
  pads: BoardPad[];
  trackCount: number;
  layers: string[];
  layerMode: LayerViewMode;
  onFocusPad: (padId: string | null) => void;
  onLayerModeChange: (mode: LayerViewMode) => void;
}) {
  if (!net) {
    return (
      <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
        <LayerModePanel mode={layerMode} onChange={onLayerModeChange} />
        <div style={{ color: C.muted, fontSize: "0.84rem", lineHeight: 1.6 }}>
          Select a net from the list or click a trace, via, or pad on the board to inspect connected pads and measurement points on the visible board side.
        </div>
      </div>
    );
  }

  const refs = [...new Set(pads.map((pad) => pad.ref))].sort();

  return (
    <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <LayerModePanel mode={layerMode} onChange={onLayerModeChange} />

      <div>
        <div style={{ fontSize: "0.74rem", color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>Net</div>
        <div style={{ marginTop: "0.35rem", color: C.highlight, fontSize: "1rem", fontWeight: 800, overflowWrap: "anywhere" }}>{net}</div>
      </div>

      <div style={detailGridStyle}>
        <Metric label="Components" value={String(refs.length)} />
        <Metric label="Pads" value={String(pads.length)} />
        <Metric label="Tracks" value={String(trackCount)} />
        <Metric label="Layers" value={layers.join(", ") || "-"} />
      </div>

      <div>
        <div style={sectionLabelStyle}>Measurement Pads</div>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
          {pads.length === 0 ? (
            <div style={{ color: C.muted, fontSize: "0.8rem" }}>No visible pads found for this net on the selected side.</div>
          ) : pads.map((pad) => (
            <button key={pad.id} type="button" onClick={() => onFocusPad(pad.id)} style={padCardButtonStyle}>
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.4rem" }}>
                <span style={{ color: C.text, fontWeight: 800 }}>{pad.ref}.{pad.pad}</span>
                {pad.pinFunction && <span style={{ color: C.accent, fontSize: "0.76rem" }}>{pad.pinFunction}</span>}
              </div>
              <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.74rem" }}>
                {pad.value ?? pad.footprint ?? "component"} · {padAccessLabel(pad)} · {pad.at.x.toFixed(2)}, {pad.at.y.toFixed(2)}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div style={sectionLabelStyle}>Path Summary</div>
        <div style={{ color: C.muted, fontSize: "0.78rem", lineHeight: 1.65 }}>
          {pads.map(formatPad).join(" -> ") || "No endpoint pads detected."}
        </div>
      </div>
    </div>
  );
}

function LayerModePanel({
  mode,
  onChange,
}: {
  mode: LayerViewMode;
  onChange: (mode: LayerViewMode) => void;
}) {
  const options: Array<{ id: LayerViewMode; label: string }> = [
    { id: "all", label: "All" },
    { id: "exterior", label: "Exterior" },
    { id: "top", label: "Top" },
    { id: "bottom", label: "Bottom" },
  ];

  return (
    <div>
      <div style={sectionLabelStyle}>Visible Copper</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.45rem" }}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            style={layerModeButtonStyle(mode === option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#08111f", border: `1px solid ${C.border}`, borderRadius: 8, padding: "0.65rem" }}>
      <div style={{ color: C.muted, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ marginTop: "0.3rem", color: C.text, fontSize: "0.84rem", fontWeight: 750, overflowWrap: "anywhere" }}>{value}</div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: "100%", background: C.bg, color: C.muted, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.88rem", padding: "2rem", textAlign: "center" }}>
      {children}
    </div>
  );
}

const dropShellStyle: CSSProperties = {
  height: "100%",
  background: C.bg,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "2rem",
  boxSizing: "border-box",
};

const dropZoneStyle: CSSProperties = {
  width: "min(680px, 100%)",
  minHeight: 260,
  border: `2px dashed ${C.border}`,
  borderRadius: 16,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.85rem",
  cursor: "pointer",
  padding: "2rem",
  boxSizing: "border-box",
};

const searchStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "#08111f",
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  color: C.text,
  padding: "0.55rem 0.65rem",
  outline: "none",
  fontSize: "0.82rem",
};

function netButtonStyle(active: boolean): CSSProperties {
  return {
    width: "100%",
    border: "none",
    borderRadius: 7,
    background: active ? "#10253c" : "transparent",
    color: active ? C.accent : C.text,
    cursor: "pointer",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.48rem 0.6rem",
    fontSize: "0.8rem",
    textAlign: "left",
  };
}

const replaceButtonStyle: CSSProperties = {
  marginTop: "0.75rem",
  background: "transparent",
  border: `1px solid ${C.border}`,
  color: C.muted,
  borderRadius: 7,
  padding: "0.4rem 0.6rem",
  cursor: "pointer",
  fontSize: "0.76rem",
};

const detailGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "0.5rem",
};

const sectionLabelStyle: CSSProperties = {
  color: C.muted,
  fontSize: "0.7rem",
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  marginBottom: "0.5rem",
};

const padCardStyle: CSSProperties = {
  background: "#08111f",
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: "0.65rem 0.7rem",
};

const padCardButtonStyle: CSSProperties = {
  ...padCardStyle,
  width: "100%",
  textAlign: "left",
  cursor: "pointer",
  appearance: "none",
  color: C.text,
};

function layerModeButtonStyle(active: boolean): CSSProperties {
  return {
    border: `1px solid ${active ? "#155e75" : C.border}`,
    borderRadius: 8,
    background: active ? "#0f2c3b" : "#08111f",
    color: active ? C.accent : C.text,
    cursor: "pointer",
    padding: "0.5rem 0.65rem",
    fontSize: "0.76rem",
    fontWeight: active ? 800 : 600,
  };
}

const zoomButtonStyle: CSSProperties = {
  border: `1px solid ${C.border}`,
  borderRadius: 7,
  background: "#08111f",
  color: C.text,
  cursor: "pointer",
  padding: "0.32rem 0.55rem",
  fontSize: "0.76rem",
  lineHeight: 1,
};
