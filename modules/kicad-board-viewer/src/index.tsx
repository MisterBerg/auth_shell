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

function viewBoxFor(bounds: Bounds): string {
  const width = Math.max(bounds.maxX - bounds.minX, 10);
  const height = Math.max(bounds.maxY - bounds.minY, 10);
  const pad = Math.max(width, height) * 0.08;
  return `${bounds.minX - pad} ${bounds.minY - pad} ${width + pad * 2} ${height + pad * 2}`;
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

export default function KiCadBoardViewer({ config }: ModuleProps) {
  const { editMode } = useEditMode();
  const updateSlotMeta = useUpdateSlotMeta();
  const getS3Client = useAwsS3Client();
  const uploadTarget = useMemo(() => getProjectUploadTarget(config.id), [config.id]);
  const savedMeta = config.meta as { board?: BoardMeta } | undefined;

  const [boardMeta, setBoardMeta] = useState<BoardMeta | undefined>(savedMeta?.board);
  const [board, setBoard] = useState<BoardArtifact | undefined>();
  const [selectedNet, setSelectedNet] = useState<string | null>(null);
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
      query={query}
      editMode={editMode}
      error={error}
      onSelectNet={setSelectedNet}
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
  query,
  editMode,
  error,
  children,
  onSelectNet,
  onQueryChange,
  onReplace,
}: {
  board: BoardArtifact;
  filename?: string;
  selectedNet: string | null;
  query: string;
  editMode: boolean;
  error?: string;
  children: React.ReactNode;
  onSelectNet: (net: string | null) => void;
  onQueryChange: (query: string) => void;
  onReplace: () => void;
}) {
  const bounds = useMemo(() => boundsFor(board), [board]);
  const netNames = useMemo(() => sortedNetNames(board), [board]);
  const filteredNets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? netNames.filter((net) => net.toLowerCase().includes(normalized))
      : netNames;
  }, [netNames, query]);
  const selectedPads = useMemo(
    () => selectedNet ? board.pads.filter((pad) => pad.net === selectedNet) : [],
    [board.pads, selectedNet]
  );
  const selectedTrackCount = selectedNet
    ? board.tracks.filter((track) => track.net === selectedNet).length
    : 0;
  const selectedViaCount = selectedNet
    ? board.vias.filter((via) => via.net === selectedNet).length
    : 0;

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
              {selectedTrackCount} tracks, {selectedViaCount} vias, {selectedPads.length} pads
            </div>
          )}
          <div style={{ marginLeft: "auto", fontSize: "0.72rem", color: C.faint }}>
            Coordinates in {board.units}
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, background: "#020617" }}>
            <BoardSvg board={board} selectedNet={selectedNet} bounds={bounds} onSelectNet={onSelectNet} />
          </div>
          <section style={{ width: 330, flexShrink: 0, borderLeft: `1px solid ${C.border}`, background: C.panel, overflowY: "auto" }}>
            <NetDetails net={selectedNet} pads={selectedPads} board={board} />
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
  bounds,
  onSelectNet,
}: {
  board: BoardArtifact;
  selectedNet: string | null;
  bounds: Bounds;
  onSelectNet: (net: string) => void;
}) {
  return (
    <svg viewBox={viewBoxFor(bounds)} style={{ width: "100%", height: "100%", display: "block" }}>
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
        {board.tracks.map((track) => {
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
        {board.pads.map((pad) => {
          const active = selectedNet === pad.net;
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
              fill={active ? C.highlight : C.pad}
              stroke={active ? "#fef3c7" : "#0f172a"}
              strokeWidth={active ? 0.12 : 0.06}
              opacity={selectedNet && !active ? 0.18 : 0.9}
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
  board,
}: {
  net: string | null;
  pads: BoardPad[];
  board: BoardArtifact;
}) {
  if (!net) {
    return (
      <div style={{ padding: "1rem", color: C.muted, fontSize: "0.84rem", lineHeight: 1.6 }}>
        Select a net from the list or click a trace, via, or pad on the board to inspect the connected pads and components.
      </div>
    );
  }

  const tracks = board.tracks.filter((track) => track.net === net);
  const layers = [...new Set(tracks.map((track) => track.layer))].sort();
  const refs = [...new Set(pads.map((pad) => pad.ref))].sort();

  return (
    <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div>
        <div style={{ fontSize: "0.74rem", color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>Net</div>
        <div style={{ marginTop: "0.35rem", color: C.highlight, fontSize: "1rem", fontWeight: 800, overflowWrap: "anywhere" }}>{net}</div>
      </div>

      <div style={detailGridStyle}>
        <Metric label="Components" value={String(refs.length)} />
        <Metric label="Pads" value={String(pads.length)} />
        <Metric label="Tracks" value={String(tracks.length)} />
        <Metric label="Layers" value={layers.join(", ") || "-"} />
      </div>

      <div>
        <div style={sectionLabelStyle}>Connected Pads</div>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
          {pads.length === 0 ? (
            <div style={{ color: C.muted, fontSize: "0.8rem" }}>No pads found for this net.</div>
          ) : pads.map((pad) => (
            <div key={pad.id} style={padCardStyle}>
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.4rem" }}>
                <span style={{ color: C.text, fontWeight: 800 }}>{pad.ref}.{pad.pad}</span>
                {pad.pinFunction && <span style={{ color: C.accent, fontSize: "0.76rem" }}>{pad.pinFunction}</span>}
              </div>
              <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.74rem" }}>
                {pad.value ?? pad.footprint ?? "component"} at {pad.at.x.toFixed(2)}, {pad.at.y.toFixed(2)}
              </div>
            </div>
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
