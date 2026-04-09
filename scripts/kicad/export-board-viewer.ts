import { readFileSync, writeFileSync } from "fs";
import { basename, resolve } from "path";

type SExpr = string | number | SExpr[];

type Point = { x: number; y: number };
type BoardNet = { name: string; code?: number };
type BoardTrack = { id: string; net: string; layer: string; start: Point; end: Point; width?: number };
type BoardVia = { id: string; net: string; at: Point; diameter?: number };
type BoardPad = {
  id: string;
  net: string;
  ref: string;
  value?: string;
  footprint?: string;
  pad: string;
  pinFunction?: string;
  at: Point;
  size?: { x: number; y: number };
  shape?: string;
  layer?: string;
};
type BoardEdge = { id: string; start: Point; end: Point };

type BoardArtifact = {
  schema: "jeffspace.kicad-board.v1";
  source: {
    file: string;
    exportedAt: string;
    exporter: string;
  };
  units: "mm";
  nets: BoardNet[];
  tracks: BoardTrack[];
  vias: BoardVia[];
  pads: BoardPad[];
  edges: BoardEdge[];
};

function parseArgs(): { pcb: string; out: string } {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [key, value] = arg.replace(/^--/, "").split("=");
      return [key, value ?? true];
    })
  );
  const pcb = args["pcb"] as string | undefined;
  const out = args["out"] as string | undefined;
  if (!pcb || !out) {
    console.error("Usage: npm run kicad:export-board -- --pcb=path/to/board.kicad_pcb --out=board-viewer.json");
    process.exit(1);
  }
  return { pcb: resolve(pcb), out: resolve(out) };
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === ";") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push(ch);
      i++;
      continue;
    }
    if (ch === "\"") {
      let value = "";
      i++;
      while (i < source.length) {
        const next = source[i];
        if (next === "\\") {
          value += source[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (next === "\"") {
          i++;
          break;
        }
        value += next;
        i++;
      }
      tokens.push(JSON.stringify(value));
      continue;
    }

    let value = "";
    while (i < source.length && !/\s|\(|\)/.test(source[i])) {
      value += source[i];
      i++;
    }
    tokens.push(value);
  }
  return tokens;
}

function parseSExpr(source: string): SExpr {
  const tokens = tokenize(source);
  let i = 0;

  const parseOne = (): SExpr => {
    const token = tokens[i++];
    if (token === "(") {
      const list: SExpr[] = [];
      while (tokens[i] !== ")" && i < tokens.length) list.push(parseOne());
      i++;
      return list;
    }
    if (token?.startsWith("\"")) return JSON.parse(token) as string;
    if (token !== undefined && /^-?\d+(?:\.\d+)?$/.test(token)) return Number(token);
    return token ?? "";
  };

  return parseOne();
}

function isList(value: SExpr | undefined): value is SExpr[] {
  return Array.isArray(value);
}

function head(list: SExpr[]): string {
  return String(list[0] ?? "");
}

function children(list: SExpr[], name: string): SExpr[][] {
  return list.filter((item): item is SExpr[] => isList(item) && head(item) === name);
}

function child(list: SExpr[], name: string): SExpr[] | undefined {
  return children(list, name)[0];
}

function stringAt(list: SExpr[] | undefined, index: number): string | undefined {
  const value = list?.[index];
  return value === undefined ? undefined : String(value);
}

function numberAt(list: SExpr[] | undefined, index: number): number | undefined {
  const value = list?.[index];
  return typeof value === "number" ? value : undefined;
}

function pointFrom(list: SExpr[] | undefined): Point | undefined {
  const x = numberAt(list, 1);
  const y = numberAt(list, 2);
  if (x === undefined || y === undefined) return undefined;
  return { x, y };
}

function rotate(point: Point, degrees: number): Point {
  const rad = degrees * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
}

function transformPoint(local: Point, origin: Point, degrees: number): Point {
  const rotated = rotate(local, degrees);
  return { x: origin.x + rotated.x, y: origin.y + rotated.y };
}

function readProperty(footprint: SExpr[], property: string): string | undefined {
  const prop = children(footprint, "property").find((item) => stringAt(item, 1) === property);
  if (prop) return stringAt(prop, 2);

  const normalized = property.toLowerCase();
  const legacy = children(footprint, "fp_text").find((item) => {
    const kind = stringAt(item, 1)?.toLowerCase();
    return kind === normalized;
  });
  return stringAt(legacy, 2);
}

function netNameFrom(netLookup: Map<number, string>, netExpr: SExpr[] | undefined): string | undefined {
  const direct = stringAt(netExpr, 2);
  if (direct) return direct;
  const code = numberAt(netExpr, 1);
  return code === undefined ? undefined : netLookup.get(code);
}

function firstCopperLayer(layers: SExpr[] | undefined): string | undefined {
  if (!layers) return undefined;
  for (const entry of layers.slice(1)) {
    const layer = String(entry);
    if (layer.endsWith(".Cu")) return layer;
  }
  return stringAt(layers, 1);
}

function exportBoard(pcbPath: string): BoardArtifact {
  const root = parseSExpr(readFileSync(pcbPath, "utf-8"));
  if (!isList(root) || head(root) !== "kicad_pcb") {
    throw new Error("Input is not a KiCad .kicad_pcb file.");
  }

  const netLookup = new Map<number, string>();
  const nets = children(root, "net").map((item) => {
    const code = numberAt(item, 1);
    const name = stringAt(item, 2) ?? `net-${code ?? "unknown"}`;
    if (code !== undefined) netLookup.set(code, name);
    return { code, name };
  });

  const tracks: BoardTrack[] = children(root, "segment").flatMap((item, index) => {
    const start = pointFrom(child(item, "start"));
    const end = pointFrom(child(item, "end"));
    const layer = stringAt(child(item, "layer"), 1) ?? "unknown";
    const net = netNameFrom(netLookup, child(item, "net"));
    if (!start || !end || !net) return [];
    return [{
      id: `track-${index}`,
      net,
      layer,
      start,
      end,
      width: numberAt(child(item, "width"), 1),
    }];
  });

  const vias: BoardVia[] = children(root, "via").flatMap((item, index) => {
    const at = pointFrom(child(item, "at"));
    const net = netNameFrom(netLookup, child(item, "net"));
    if (!at || !net) return [];
    return [{
      id: `via-${index}`,
      net,
      at,
      diameter: numberAt(child(item, "size"), 1),
    }];
  });

  const pads: BoardPad[] = [];
  for (const footprint of [...children(root, "footprint"), ...children(root, "module")]) {
    const footprintName = stringAt(footprint, 1);
    const ref = readProperty(footprint, "Reference") ?? "?";
    const value = readProperty(footprint, "Value");
    const footprintAt = child(footprint, "at");
    const origin = pointFrom(footprintAt) ?? { x: 0, y: 0 };
    const rotation = numberAt(footprintAt, 3) ?? 0;

    for (const pad of children(footprint, "pad")) {
      const padName = stringAt(pad, 1) ?? "?";
      const net = netNameFrom(netLookup, child(pad, "net"));
      if (!net) continue;

      const localAt = pointFrom(child(pad, "at")) ?? { x: 0, y: 0 };
      const absoluteAt = transformPoint(localAt, origin, rotation);
      const size = child(pad, "size");
      pads.push({
        id: `${ref}-${padName}-${pads.length}`,
        net,
        ref,
        value,
        footprint: footprintName,
        pad: padName,
        pinFunction: stringAt(child(pad, "pinfunction"), 1),
        at: absoluteAt,
        size: {
          x: numberAt(size, 1) ?? 0.8,
          y: numberAt(size, 2) ?? 0.8,
        },
        shape: stringAt(pad, 3),
        layer: firstCopperLayer(child(pad, "layers")),
      });
    }
  }

  const edges: BoardEdge[] = children(root, "gr_line").flatMap((item, index) => {
    const layer = stringAt(child(item, "layer"), 1);
    const start = pointFrom(child(item, "start"));
    const end = pointFrom(child(item, "end"));
    if (layer !== "Edge.Cuts" || !start || !end) return [];
    return [{ id: `edge-${index}`, start, end }];
  });

  return {
    schema: "jeffspace.kicad-board.v1",
    source: {
      file: basename(pcbPath),
      exportedAt: new Date().toISOString(),
      exporter: "scripts/kicad/export-board-viewer.ts",
    },
    units: "mm",
    nets,
    tracks,
    vias,
    pads,
    edges,
  };
}

const { pcb, out } = parseArgs();
const artifact = exportBoard(pcb);
writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`Exported ${artifact.nets.length} nets, ${artifact.tracks.length} tracks, ${artifact.vias.length} vias, ${artifact.pads.length} pads.`);
console.log(out);
