import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { parse as parseYaml } from "yaml";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ExportContext, ModuleProps } from "module-core";
import { useAwsS3Client, useUserProfile } from "module-core";

type Scalar = string | number | boolean | null;
type ValueMap = Record<string, unknown>;
type AppSection = "run" | "report";

type FieldDefinition = {
  id: string;
  label: string;
  type: string;
  required: boolean;
  helpText?: string;
  placeholder?: string;
  linkedValueSet?: string;
  options?: Array<{ value: string; label: string }>;
};

type LinkedValueRecord = {
  id: string;
  label: string;
  description?: string;
};

type TestCase = {
  id: string;
  title: string;
  description?: string;
  values: ValueMap;
};

type TestGroup = {
  id: string;
  title: string;
  description?: string;
  values: ValueMap;
  tests: TestCase[];
};

type TestDefinition = {
  program: ValueMap;
  diagrams: Record<string, DiagramDefinition>;
  linkedValues: Record<string, LinkedValueRecord[]>;
  inputFields: FieldDefinition[];
  testDefinedFields: FieldDefinition[];
  testGroups: TestGroup[];
  sourceText: string;
};

type ResolvedTest = {
  id: string;
  title: string;
  description?: string;
  testGroupId: string;
  testGroupTitle: string;
  definedValues: ValueMap;
  runtimeDefaults: ValueMap;
  fieldIssues: string[];
  linkedValueIssues: string[];
  preTestGuidance?: string;
  preTestAssets: PreTestAsset[];
  equipmentRuntime: EquipmentRuntimeSpec[];
};

type PreTestAsset = {
  id: string;
  label: string;
  type: "svg_inline" | "image_url" | "diagram_svg";
  content: string;
};

type DiagramNode = {
  id: string;
  label: string;
  note?: string;
  tone?: string;
  badge?: string;
};

type DiagramEdge = {
  id: string;
  from: string;
  to: string;
  label?: string;
  tone?: string;
};

type DiagramAnnotation = {
  label: string;
  tone?: string;
  connects: string[];
};

type DiagramDefinition = {
  id: string;
  title?: string;
  layout: "left-to-right" | "top-to-bottom";
  nodes: Record<string, DiagramNode>;
  edges: DiagramEdge[];
  annotations: DiagramAnnotation[];
};

type DiagramPatch = {
  nodes?: Record<string, Partial<DiagramNode>>;
  update_nodes?: Record<string, Partial<DiagramNode>>;
  add_nodes?: Record<string, Partial<DiagramNode>>;
  remove_nodes?: string[];
  edges?: DiagramEdge[];
  add_edges?: DiagramEdge[];
  remove_edges?: string[];
  annotations?: DiagramAnnotation[];
  add_annotations?: DiagramAnnotation[];
};

type EquipmentRuntimeSpec = {
  id: string;
  label: string;
  provider: string;
  mode: "manual" | "assisted" | "automated";
  actions: string[];
  outputs: string[];
  notes?: string;
};

type ArtifactRef = {
  id: string;
  fieldId?: string;
  kind: "typed" | "supporting";
  name: string;
  bucket: string;
  key: string;
  contentType?: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy?: string;
};

type ResultRecord = {
  status: string;
  inputValues: Record<string, Scalar>;
  notes: string;
  typedArtifacts: Record<string, ArtifactRef[]>;
  supportingArtifacts: ArtifactRef[];
  startedAt?: string;
  updatedAt: string;
  updatedBy?: string;
};

type TestRun = {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  resultsByTestId: Record<string, ResultRecord>;
};

type WorkspaceState = {
  version: 3;
  projectId: string;
  activeRunId?: string;
  runs: TestRun[];
};

type StorageInfo = {
  bucket: string;
  projectId: string;
  basePrefix: string;
  definitionKey: string;
  resultsKey: string;
};

type ReportPages = {
  summary: string;
  details: Record<string, string>;
};

const C = {
  bg: "var(--hep-bg, #08111d)",
  panel: "var(--hep-surface, #0d1726)",
  panel2: "var(--hep-surface-raised, #101d30)",
  border: "var(--hep-border, #24354f)",
  text: "var(--hep-text, #e5edf8)",
  muted: "var(--hep-muted, #94a3b8)",
  accent: "var(--hep-accent, #2dd4bf)",
  accentText: "var(--hep-accent-text, #041314)",
  accentSoft: "rgba(45,212,191,0.14)",
  input: "#0a1424",
  danger: "#f87171",
  warning: "#fbbf24",
  ok: "#34d399",
  idle: "#64748b",
  header: "linear-gradient(135deg, #08111d, #0f2135 55%, #173149)",
};

const STRUCTURAL_REQUIRED_FIELDS = ["test_group_id", "test_id", "title", "failure_mode", "target_module"];
const STATUS_OPTIONS = ["not-run", "in-progress", "pass", "fail", "blocked"];
const SECTION_LABELS: Record<AppSection, string> = { run: "Run", report: "Report" };

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId ? `${prefix}-${randomId}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : "";
}

function getStorageInfo(config: ModuleProps["config"]): StorageInfo {
  const params = new URLSearchParams(window.location.search);
  const configPath = params.get("config") ?? "";
  const projectDir = dirname(configPath);
  const projectId = configPath.match(/projects\/([^/]+)\//)?.[1] ?? config.id;
  const bucket = (config.meta?.["definitionBucket"] as string | undefined) ?? params.get("bucket") ?? config.app.bucket;
  const basePrefix = projectDir ? `${projectDir}/tests/${config.id}` : `tests/${config.id}`;
  return {
    bucket,
    projectId,
    basePrefix,
    definitionKey: (config.meta?.["definitionKey"] as string | undefined) ?? `${basePrefix}/definition.yaml`,
    resultsKey: (config.meta?.["resultsKey"] as string | undefined) ?? `${basePrefix}/results.json`,
  };
}

async function readOptionalText(s3: S3Client, bucket: string, key: string): Promise<string | null> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return response.Body?.transformToString("utf-8") ?? null;
  } catch (error: unknown) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === "NoSuchKey" || err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

async function writeText(s3: S3Client, bucket: string, key: string, body: string, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: "no-store",
  }));
}

function toRecord(value: unknown): ValueMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ValueMap : {};
}

function toStringValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function isMeaningful(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function guessLinkedValueSet(fieldId: string): string | undefined {
  if (!fieldId) return undefined;
  if (fieldId.endsWith("_id")) return `${fieldId.slice(0, -3)}s`;
  if (fieldId.endsWith("y")) return `${fieldId.slice(0, -1)}ies`;
  return `${fieldId}s`;
}

function normalizeOptionEntry(key: string, value: unknown): { value: string; label: string } {
  if (typeof value === "string") return { value: key, label: value };
  const record = toRecord(value);
  return {
    value: toStringValue(record.value ?? key, key),
    label: toStringValue(record.label ?? record.title ?? record.name ?? record.value ?? key, key),
  };
}

function normalizeFieldDefinitionRecord(id: string, entry: unknown): FieldDefinition {
  const record = toRecord(entry);
  const optionsSource = record.options ?? record.values;
  const options = Array.isArray(optionsSource)
    ? optionsSource.map((option) => typeof option === "string" ? { value: option, label: humanize(option) } : normalizeOptionEntry(id, option))
    : Object.keys(toRecord(optionsSource)).length
      ? Object.entries(toRecord(optionsSource)).map(([optionKey, optionValue]) => normalizeOptionEntry(optionKey, optionValue))
      : undefined;
  return {
    id,
    label: toStringValue(record.label ?? record.title ?? record.name, humanize(id)),
    type: toStringValue(record.type, "text"),
    required: Boolean(record.required),
    helpText: toStringValue(record.help_text ?? record.helpText ?? record.description, ""),
    placeholder: toStringValue(record.placeholder, ""),
    linkedValueSet: toStringValue(record.linked_values ?? record.linkedValueSet ?? record.linkedValue ?? record.source ?? record.options_from, "") || guessLinkedValueSet(id),
    options,
  };
}

function normalizeFieldDefinitions(catalog: unknown): FieldDefinition[] {
  const record = toRecord(catalog);
  if (Array.isArray(catalog)) {
    return catalog.flatMap((entry, index) => {
      const item = toRecord(entry);
      const nested = item.key && (item.label || item.type) ? item : item[Object.keys(item)[0] ?? ""];
      const nestedRecord = toRecord(nested);
      const id = toStringValue(nestedRecord.id ?? nestedRecord.key ?? item.id ?? item.key, `field_${index + 1}`);
      return id ? [normalizeFieldDefinitionRecord(id, nestedRecord)] : [];
    });
  }

  for (const key of ["result_fields", "fields", "definitions"]) {
    if (record[key]) return normalizeFieldDefinitions(record[key]);
  }

  return Object.entries(record).map(([id, value]) => typeof value === "string"
    ? { id, label: value, type: "text", required: false, linkedValueSet: guessLinkedValueSet(id) }
    : normalizeFieldDefinitionRecord(id, value));
}

function normalizeLinkedValues(value: unknown): Record<string, LinkedValueRecord[]> {
  const next: Record<string, LinkedValueRecord[]> = {};
  for (const [setName, rawSet] of Object.entries(toRecord(value))) {
    if (Array.isArray(rawSet)) {
      next[setName] = rawSet.map((entry, index) => {
        const record = toRecord(entry);
        const id = toStringValue(record.id ?? record.value ?? record.name, `${setName}-${index + 1}`);
        return {
          id,
          label: toStringValue(record.label ?? record.title ?? record.name ?? record.value, id),
          description: toStringValue(record.description ?? record.help_text ?? record.helpText, ""),
        };
      });
    } else {
      next[setName] = Object.entries(toRecord(rawSet)).map(([id, entry]) => {
        if (typeof entry === "string") return { id, label: entry };
        const record = toRecord(entry);
        return {
          id,
          label: toStringValue(record.label ?? record.title ?? record.name ?? record.value, id),
          description: toStringValue(record.description ?? record.help_text ?? record.helpText, ""),
        };
      });
    }
  }
  return next;
}

function stripReservedKeys(record: ValueMap, reserved: string[]): ValueMap {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !reserved.includes(key)));
}

function normalizeTests(value: unknown): TestCase[] {
  return Array.isArray(value)
    ? value.map((entry, index) => {
        const record = toRecord(entry);
        const values = toRecord(record.values);
        const id = toStringValue(record.id ?? record.test_id, `test-${index + 1}`);
        const base = stripReservedKeys(record, ["id", "test_id", "title", "description", "values"]);
        return {
          id,
          title: toStringValue(record.title, humanize(id)),
          description: toStringValue(record.description, ""),
          values: { ...base, ...values },
        };
      })
    : [];
}

function normalizeTestGroups(value: unknown): TestGroup[] {
  return Array.isArray(value)
    ? value.map((entry, index) => {
        const record = toRecord(entry);
        const values = toRecord(record.values);
        const id = toStringValue(record.id ?? record.test_group_id, `group-${index + 1}`);
        const base = stripReservedKeys(record, ["id", "test_group_id", "title", "description", "values", "tests"]);
        return {
          id,
          title: toStringValue(record.title, humanize(id)),
          description: toStringValue(record.description, ""),
          values: { ...base, ...values },
          tests: normalizeTests(record.tests),
        };
      })
    : [];
}

function normalizeEquipmentRuntime(value: unknown): EquipmentRuntimeSpec[] {
  return Array.isArray(value)
    ? value.flatMap((entry, index): EquipmentRuntimeSpec[] => {
        const record = toRecord(entry);
        const provider = toStringValue(record.provider, "");
        const label = toStringValue(record.label, "");
        if (!provider && !label) return [];
        return [{
          id: toStringValue(record.id, `equipment-${index + 1}`),
          label: label || humanize(provider || `equipment-${index + 1}`),
          provider: provider || "unknown-provider",
          mode: ((): EquipmentRuntimeSpec["mode"] => {
            const mode = toStringValue(record.mode, "manual");
            return mode === "automated" || mode === "assisted" ? mode : "manual";
          })(),
          actions: Array.isArray(record.actions) ? record.actions.map((item) => String(item)) : [],
          outputs: Array.isArray(record.outputs) ? record.outputs.map((item) => String(item)) : [],
          notes: toStringValue(record.notes, "") || undefined,
        }];
      })
    : [];
}

function normalizeDiagramNode(id: string, value: unknown): DiagramNode {
  const record = toRecord(value);
  return {
    id,
    label: toStringValue(record.label ?? record.title ?? record.name, humanize(id)),
    note: toStringValue(record.note ?? record.description, "") || undefined,
    tone: toStringValue(record.tone, "") || undefined,
    badge: toStringValue(record.badge, "") || undefined,
  };
}

function normalizeDiagramEdge(value: unknown, index: number): DiagramEdge | null {
  if (Array.isArray(value)) {
    const from = toStringValue(value[0], "");
    const to = toStringValue(value[1], "");
    if (!from || !to) return null;
    return {
      id: toStringValue(value[3], `${from}_to_${to}_${index + 1}`),
      from,
      to,
      label: toStringValue(value[2], "") || undefined,
    };
  }
  const record = toRecord(value);
  const from = toStringValue(record.from, "");
  const to = toStringValue(record.to, "");
  if (!from || !to) return null;
  return {
    id: toStringValue(record.id, `${from}_to_${to}_${index + 1}`),
    from,
    to,
    label: toStringValue(record.label, "") || undefined,
    tone: toStringValue(record.tone, "") || undefined,
  };
}

function normalizeDiagramAnnotation(value: unknown): DiagramAnnotation | null {
  const record = toRecord(value);
  const label = toStringValue(record.label ?? record.title, "");
  const connects = Array.isArray(record.connects) ? record.connects.map((item) => String(item)).filter(Boolean) : [];
  if (!label || connects.length === 0) return null;
  return {
    label,
    tone: toStringValue(record.tone, "") || undefined,
    connects,
  };
}

function normalizeDiagramDefinition(id: string, value: unknown): DiagramDefinition {
  const record = toRecord(value);
  const nodes = Object.fromEntries(
    Object.entries(toRecord(record.nodes)).map(([nodeId, node]) => [nodeId, normalizeDiagramNode(nodeId, node)])
  );
  const edges = Array.isArray(record.edges)
    ? record.edges.flatMap((edge, index) => {
        const normalized = normalizeDiagramEdge(edge, index);
        return normalized ? [normalized] : [];
      })
    : [];
  const annotations = Array.isArray(record.annotations)
    ? record.annotations.flatMap((annotation) => {
        const normalized = normalizeDiagramAnnotation(annotation);
        return normalized ? [normalized] : [];
      })
    : [];
  const layout = toStringValue(record.layout, "left-to-right");
  return {
    id,
    title: toStringValue(record.title, "") || undefined,
    layout: layout === "top-to-bottom" ? "top-to-bottom" : "left-to-right",
    nodes,
    edges,
    annotations,
  };
}

function normalizeDiagramDefinitions(value: unknown): Record<string, DiagramDefinition> {
  return Object.fromEntries(
    Object.entries(toRecord(value)).map(([id, diagram]) => [id, normalizeDiagramDefinition(id, diagram)])
  );
}

function normalizeDiagramPatch(value: unknown): DiagramPatch {
  const record = toRecord(value);
  const normalizeNodePatchMap = (candidate: unknown) => Object.fromEntries(
    Object.entries(toRecord(candidate)).map(([nodeId, node]) => [nodeId, toRecord(node)])
  );
  const normalizeEdgeList = (candidate: unknown) => Array.isArray(candidate)
    ? candidate.flatMap((edge, index) => {
        const normalized = normalizeDiagramEdge(edge, index);
        return normalized ? [normalized] : [];
      })
    : undefined;
  const normalizeAnnotationList = (candidate: unknown) => Array.isArray(candidate)
    ? candidate.flatMap((annotation) => {
        const normalized = normalizeDiagramAnnotation(annotation);
        return normalized ? [normalized] : [];
      })
    : undefined;

  return {
    nodes: normalizeNodePatchMap(record.nodes),
    update_nodes: normalizeNodePatchMap(record.update_nodes),
    add_nodes: normalizeNodePatchMap(record.add_nodes),
    remove_nodes: Array.isArray(record.remove_nodes) ? record.remove_nodes.map((item) => String(item)) : undefined,
    edges: normalizeEdgeList(record.edges),
    add_edges: normalizeEdgeList(record.add_edges),
    remove_edges: Array.isArray(record.remove_edges) ? record.remove_edges.map((item) => String(item)) : undefined,
    annotations: normalizeAnnotationList(record.annotations),
    add_annotations: normalizeAnnotationList(record.add_annotations),
  };
}

function applyDiagramPatch(base: DiagramDefinition, patch: DiagramPatch): DiagramDefinition {
  const nodes: Record<string, DiagramNode> = Object.fromEntries(
    Object.entries(base.nodes).map(([id, node]) => [id, { ...node }])
  );
  const mergeNode = (nodeId: string, update: Partial<DiagramNode>) => {
    nodes[nodeId] = {
      id: nodeId,
      label: toStringValue(update.label ?? nodes[nodeId]?.label, humanize(nodeId)),
      note: toStringValue(update.note ?? nodes[nodeId]?.note, "") || undefined,
      tone: toStringValue(update.tone ?? nodes[nodeId]?.tone, "") || undefined,
      badge: toStringValue(update.badge ?? nodes[nodeId]?.badge, "") || undefined,
    };
  };

  for (const [nodeId, update] of Object.entries(patch.add_nodes ?? {})) mergeNode(nodeId, update);
  for (const [nodeId, update] of Object.entries(patch.update_nodes ?? {})) mergeNode(nodeId, update);
  for (const [nodeId, update] of Object.entries(patch.nodes ?? {})) mergeNode(nodeId, update);
  for (const nodeId of patch.remove_nodes ?? []) delete nodes[nodeId];

  const removedNodeIds = new Set(patch.remove_nodes ?? []);
  const removedEdgeIds = new Set(patch.remove_edges ?? []);
  const replacementEdges = patch.edges;
  const baseEdges = replacementEdges ?? base.edges;
  const edges = [...baseEdges, ...(patch.add_edges ?? [])]
    .filter((edge) => !removedEdgeIds.has(edge.id))
    .filter((edge) => !removedNodeIds.has(edge.from) && !removedNodeIds.has(edge.to))
    .filter((edge) => nodes[edge.from] && nodes[edge.to]);

  return {
    ...base,
    nodes,
    edges,
    annotations: [
      ...(patch.annotations ?? base.annotations),
      ...(patch.add_annotations ?? []),
    ],
  };
}

function diagramToneColor(tone?: string): { fill: string; stroke: string; text: string } {
  if (tone === "danger") return { fill: "#450a0a", stroke: "#f87171", text: "#fecaca" };
  if (tone === "warning" || tone === "observe") return { fill: "#422006", stroke: "#f59e0b", text: "#fed7aa" };
  if (tone === "ok" || tone === "source") return { fill: "#064e3b", stroke: "#34d399", text: "#d1fae5" };
  if (tone === "protect") return { fill: "#172554", stroke: "#93c5fd", text: "#dbeafe" };
  return { fill: "#0f172a", stroke: "#38bdf8", text: "#e5edf8" };
}

function renderDiagramSvg(diagram: DiagramDefinition): string {
  const nodes = Object.values(diagram.nodes);
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of diagram.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }

  const levels = new Map<string, number>();
  const queue = nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id);
  if (queue.length === 0 && nodes[0]) queue.push(nodes[0].id);
  for (const nodeId of queue) levels.set(nodeId, 0);

  while (queue.length) {
    const nodeId = queue.shift()!;
    const nextLevel = (levels.get(nodeId) ?? 0) + 1;
    for (const targetId of outgoing.get(nodeId) ?? []) {
      if ((levels.get(targetId) ?? -1) < nextLevel) {
        levels.set(targetId, nextLevel);
        queue.push(targetId);
      }
    }
  }
  for (const node of nodes) if (!levels.has(node.id)) levels.set(node.id, 0);

  const byLevel = new Map<number, DiagramNode[]>();
  for (const node of nodes) {
    const level = levels.get(node.id) ?? 0;
    byLevel.set(level, [...(byLevel.get(level) ?? []), node]);
  }

  const nodeWidth = 155;
  const nodeHeight = 82;
  const xGap = 72;
  const yGap = 32;
  const topPad = diagram.title ? 92 : 42;
  const maxLevel = Math.max(0, ...byLevel.keys());
  const maxRows = Math.max(1, ...[...byLevel.values()].map((items) => items.length));
  const width = Math.max(620, 48 + (maxLevel + 1) * nodeWidth + maxLevel * xGap + 48);
  const height = Math.max(260, topPad + maxRows * nodeHeight + (maxRows - 1) * yGap + 118);
  const positions = new Map<string, { x: number; y: number; cx: number; cy: number }>();

  for (const [level, levelNodes] of byLevel.entries()) {
    const columnHeight = levelNodes.length * nodeHeight + (levelNodes.length - 1) * yGap;
    const startY = topPad + Math.max(0, ((height - topPad - 96) - columnHeight) / 2);
    levelNodes
      .sort((a, b) => a.label.localeCompare(b.label))
      .forEach((node, index) => {
        const x = 48 + level * (nodeWidth + xGap);
        const y = startY + index * (nodeHeight + yGap);
        positions.set(node.id, { x, y, cx: x + nodeWidth / 2, cy: y + nodeHeight / 2 });
      });
  }

  const edgeMarkup = diagram.edges.map((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return "";
    const tone = diagramToneColor(edge.tone);
    const x1 = from.cx < to.cx ? from.x + nodeWidth : from.x;
    const x2 = from.cx < to.cx ? to.x : to.x + nodeWidth;
    const y1 = from.cy;
    const y2 = to.cy;
    const midX = (x1 + x2) / 2;
    const label = edge.label
      ? `<text x="${midX}" y="${Math.min(y1, y2) - 8}" text-anchor="middle" fill="#94a3b8" font-size="13">${escapeXml(edge.label)}</text>`
      : "";
    return `<path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" stroke="${tone.stroke}" stroke-width="3" fill="none" marker-end="url(#arrow)"/>${label}`;
  }).join("\n");

  const nodeMarkup = nodes.map((node) => {
    const pos = positions.get(node.id);
    if (!pos) return "";
    const tone = diagramToneColor(node.tone);
    const note = node.note ? `<text x="${pos.cx}" y="${pos.y + 55}" text-anchor="middle" fill="#94a3b8" font-size="13">${escapeXml(node.note)}</text>` : "";
    const badge = node.badge ? `<rect x="${pos.x + 12}" y="${pos.y + nodeHeight - 21}" width="${nodeWidth - 24}" height="18" rx="9" fill="${tone.stroke}" opacity="0.22"/><text x="${pos.cx}" y="${pos.y + nodeHeight - 8}" text-anchor="middle" fill="${tone.text}" font-size="12" font-weight="700">${escapeXml(node.badge)}</text>` : "";
    return `<rect x="${pos.x}" y="${pos.y}" width="${nodeWidth}" height="${nodeHeight}" rx="12" fill="${tone.fill}" stroke="${tone.stroke}" stroke-width="2"/>
      <text x="${pos.cx}" y="${pos.y + 30}" text-anchor="middle" fill="${tone.text}" font-size="16" font-weight="700">${escapeXml(node.label)}</text>
      ${note}
      ${badge}`;
  }).join("\n");

  const annotationMarkup = diagram.annotations.map((annotation, index) => {
    const tone = diagramToneColor(annotation.tone);
    const connected = annotation.connects.map((id) => positions.get(id)).filter((pos): pos is { x: number; y: number; cx: number; cy: number } => Boolean(pos));
    const avgX = connected.length ? connected.reduce((sum, pos) => sum + pos.cx, 0) / connected.length : width / 2;
    const y = height - 72 + index * 24;
    const lines = connected.map((pos) => `<path d="M ${pos.cx} ${pos.y + nodeHeight} C ${pos.cx} ${y - 28}, ${avgX} ${y - 28}, ${avgX} ${y - 8}" stroke="${tone.stroke}" stroke-width="2" stroke-dasharray="6 6" fill="none"/>`).join("\n");
    return `${lines}<text x="${avgX}" y="${y}" text-anchor="middle" fill="${tone.text}" font-size="14" font-weight="700">${escapeXml(annotation.label)}</text>`;
  }).join("\n");

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#dbeafe"/>
      </marker>
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" rx="18" fill="#07111e"/>
    ${diagram.title ? `<text x="34" y="40" fill="#e5edf8" font-size="20" font-weight="700">${escapeXml(diagram.title)}</text>` : ""}
    ${edgeMarkup}
    ${nodeMarkup}
    ${annotationMarkup}
  </svg>`;
}

function normalizePreTestAssets(value: unknown, diagrams: Record<string, DiagramDefinition>): PreTestAsset[] {
  return Array.isArray(value)
    ? value.flatMap((entry, index): PreTestAsset[] => {
        const record = toRecord(entry);
        const type = toStringValue(record.type, "image_url");
        if (type === "diagram" || type === "diagram_ref") {
          const diagramId = toStringValue(record.diagram ?? record.ref ?? record.diagram_id, "");
          const base = diagramId ? diagrams[diagramId] : normalizeDiagramDefinition(toStringValue(record.id, `diagram-${index + 1}`), record.diagram);
          if (!base) return [];
          const rendered = renderDiagramSvg(applyDiagramPatch(base, normalizeDiagramPatch(record.patch)));
          return [{
            id: toStringValue(record.id, `asset-${index + 1}`),
            label: toStringValue(record.label, base.title ?? `Diagram ${index + 1}`),
            type: "diagram_svg",
            content: rendered,
          }];
        }

        const content = toStringValue(record.content ?? record.url ?? record.svg, "");
        if (!content) return [];
        return [{
          id: toStringValue(record.id, `asset-${index + 1}`),
          label: toStringValue(record.label, `Asset ${index + 1}`),
          type: type === "svg_inline" ? "svg_inline" : "image_url",
          content,
        }];
      })
    : [];
}

function parseDefinition(text: string): TestDefinition {
  const parsed = toRecord(parseYaml(text));
  return {
    program: toRecord(parsed.program),
    diagrams: normalizeDiagramDefinitions(parsed.diagrams),
    linkedValues: normalizeLinkedValues(parsed.linked_values),
    inputFields: normalizeFieldDefinitions(parsed.input_fields),
    testDefinedFields: normalizeFieldDefinitions(parsed.test_defined_fields),
    testGroups: normalizeTestGroups(parsed.test_groups),
    sourceText: text,
  };
}

function createDefaultRun(currentUser?: string, label = "Run 1"): TestRun {
  const createdAt = nowIso();
  return {
    id: makeId("run"),
    label,
    createdAt,
    updatedAt: createdAt,
    createdBy: currentUser,
    resultsByTestId: {},
  };
}

function normalizeResultRecord(value: unknown): ResultRecord {
  const record = toRecord(value);
  return {
    status: toStringValue(record.status, "not-run"),
    inputValues: toRecord(record.inputValues) as Record<string, Scalar>,
    notes: toStringValue(record.notes, ""),
    typedArtifacts: Object.fromEntries(Object.entries(toRecord(record.typedArtifacts)).map(([key, artifacts]) => [key, Array.isArray(artifacts) ? artifacts as ArtifactRef[] : []])),
    supportingArtifacts: Array.isArray(record.supportingArtifacts) ? record.supportingArtifacts as ArtifactRef[] : [],
    startedAt: toStringValue(record.startedAt, "") || undefined,
    updatedAt: toStringValue(record.updatedAt, nowIso()),
    updatedBy: toStringValue(record.updatedBy, "") || undefined,
  };
}

function normalizeWorkspaceState(store: unknown, projectId: string, currentUser?: string): WorkspaceState {
  const record = toRecord(store);
  const runs = Array.isArray(record.runs) ? record.runs as TestRun[] : [];
  const defaultRun = createDefaultRun(currentUser);
  return {
    version: 3,
    projectId: toStringValue(record.projectId, projectId) || projectId,
    activeRunId: toStringValue(record.activeRunId, runs[0]?.id ?? defaultRun.id),
    runs: runs.length > 0 ? runs.map((run) => ({
      ...run,
      resultsByTestId: Object.fromEntries(
        Object.entries(run.resultsByTestId ?? {}).map(([testId, result]) => [testId, normalizeResultRecord(result)])
      ),
    })) : [defaultRun],
  };
}

function isArtifactField(field: FieldDefinition): boolean {
  const type = field.type.toLowerCase();
  return type.includes("file") || type.includes("image") || type.includes("video") || type.includes("csv");
}

function artifactAccept(field: FieldDefinition): string | undefined {
  const type = field.type.toLowerCase();
  if (type.includes("image")) return "image/*";
  if (type.includes("video")) return "video/*";
  if (type.includes("csv")) return ".csv,text/csv";
  return undefined;
}

function artifactStoragePath(storage: StorageInfo, runId: string, testId: string, fieldId: string | null, fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const area = fieldId ? `typed/${fieldId}` : "supporting";
  return `${storage.basePrefix}/runs/${runId}/tests/${testId}/${area}/${makeId("artifact")}-${safeName}`;
}

function coerceRuntimeValue(value: unknown, type: string): Scalar {
  if (value == null) return null;
  if (type === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (type === "boolean") {
    return typeof value === "boolean" ? value : String(value).toLowerCase() === "true";
  }
  return typeof value === "string" ? value : String(value);
}

function buildResolvedTests(definition: TestDefinition): ResolvedTest[] {
  return definition.testGroups.flatMap((group) =>
    group.tests.map((test) => {
      const preTestGuidance = toStringValue(test.values.pre_test_guidance ?? group.values.pre_test_guidance, "") || undefined;
      const preTestAssets = normalizePreTestAssets(test.values.pre_test_assets ?? group.values.pre_test_assets, definition.diagrams);
      const equipmentRuntime = normalizeEquipmentRuntime(test.values.equipment_runtime ?? group.values.equipment_runtime);
      const definedValues: ValueMap = {
        test_group_id: group.id,
        test_group_title: group.title,
        test_id: test.id,
        title: test.title,
        description: test.description || undefined,
        ...group.values,
        ...test.values,
      };

      const fieldIssues: string[] = [];
      for (const field of definition.testDefinedFields) {
        if (field.required && !isMeaningful(definedValues[field.id])) {
          fieldIssues.push(`${field.label} is required after inheritance is resolved.`);
        }
      }

      for (const fieldId of STRUCTURAL_REQUIRED_FIELDS) {
        if (!isMeaningful(definedValues[fieldId])) {
          fieldIssues.push(`${humanize(fieldId)} is required.`);
        }
      }

      const linkedValueIssues: string[] = [];
      for (const field of definition.testDefinedFields) {
        const setName = field.linkedValueSet;
        if (!setName || !isMeaningful(definedValues[field.id])) continue;
        const linkedSet = definition.linkedValues[setName] ?? definition.linkedValues[field.id] ?? definition.linkedValues[guessLinkedValueSet(field.id) ?? ""];
        if (!linkedSet || linkedSet.length === 0) continue;
        const candidateId = String(definedValues[field.id]);
        if (!linkedSet.some((entry) => entry.id === candidateId)) {
          linkedValueIssues.push(`${field.label} references "${candidateId}", which is missing from linked values "${setName}".`);
        }
      }

      const runtimeDefaults = Object.fromEntries(
        definition.inputFields.filter((field) => !isArtifactField(field)).map((field) => [field.id, field.id === "status" ? "not-run" : field.type.toLowerCase().includes("boolean") ? false : ""])
      );

      return {
        id: test.id,
        title: test.title,
        description: test.description,
        testGroupId: group.id,
        testGroupTitle: group.title,
        definedValues,
        runtimeDefaults,
        fieldIssues,
        linkedValueIssues,
        preTestGuidance,
        preTestAssets,
        equipmentRuntime,
      };
    })
  );
}

function getProgramTitle(definition: TestDefinition | null, config: ModuleProps["config"]): string {
  if (!definition) return (config.meta?.["title"] as string | undefined) ?? "Test Manager";
  return toStringValue(definition.program.name ?? definition.program.title, (config.meta?.["title"] as string | undefined) ?? "Test Manager");
}

function getProgramDescription(definition: TestDefinition | null): string {
  return definition ? toStringValue(definition.program.description, "") : "";
}

function formatDate(value?: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function getActiveRun(store: WorkspaceState): TestRun {
  return store.runs.find((run) => run.id === store.activeRunId) ?? store.runs[0]!;
}

function ensureResult(run: TestRun, test: ResolvedTest, userEmail?: string): ResultRecord {
  return run.resultsByTestId[test.id] ?? {
    status: "not-run",
    inputValues: Object.fromEntries(Object.entries(test.runtimeDefaults).map(([key, value]) => [key, value as Scalar])),
    notes: "",
    typedArtifacts: {},
    supportingArtifacts: [],
    updatedAt: nowIso(),
    updatedBy: userEmail,
  };
}

function getLinkedValueLabel(definition: TestDefinition, field: FieldDefinition, value: unknown): string | undefined {
  if (!isMeaningful(value)) return undefined;
  const setName = field.linkedValueSet;
  const linkedSet = setName ? (definition.linkedValues[setName] ?? definition.linkedValues[field.id] ?? definition.linkedValues[guessLinkedValueSet(field.id) ?? ""]) : undefined;
  return linkedSet?.find((entry) => entry.id === String(value))?.label;
}

function valueDisplay(value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  return isMeaningful(value) ? String(value) : "Not set";
}

function statusTone(status: string): string {
  if (status === "pass") return C.ok;
  if (status === "fail") return C.danger;
  if (status === "blocked") return C.warning;
  if (status === "in-progress") return C.accent;
  return C.idle;
}

function inputStyle(): React.CSSProperties {
  return { width: "100%", boxSizing: "border-box", background: C.input, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, padding: "0.6rem 0.7rem", font: "inherit" };
}

function labelStyle(): React.CSSProperties {
  return { display: "flex", flexDirection: "column", gap: "0.38rem", color: C.muted, fontSize: "0.78rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" };
}

function buttonStyle(kind: "primary" | "ghost" | "danger" = "ghost"): React.CSSProperties {
  if (kind === "primary") {
    return { border: `1px solid ${C.accent}`, background: C.accent, color: C.accentText, borderRadius: 8, padding: "0.55rem 0.85rem", cursor: "pointer", fontWeight: 700, fontFamily: "inherit" };
  }
  if (kind === "danger") {
    return { border: `1px solid ${C.danger}`, background: "transparent", color: C.danger, borderRadius: 8, padding: "0.55rem 0.85rem", cursor: "pointer", fontWeight: 600, fontFamily: "inherit" };
  }
  return { border: `1px solid ${C.border}`, background: "transparent", color: C.text, borderRadius: 8, padding: "0.55rem 0.85rem", cursor: "pointer", fontWeight: 600, fontFamily: "inherit" };
}

function cardStyle(): React.CSSProperties {
  return { border: `1px solid ${C.border}`, borderRadius: 16, background: C.panel, padding: "1rem 1.1rem" };
}

function markdownContainerStyle(): React.CSSProperties {
  return { color: C.text, lineHeight: 1.65, fontSize: "0.92rem" };
}

function downloadText(filename: string, content: string, contentType: string): void {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function markdownArtifactLink(artifact: ArtifactRef): string {
  return `[${artifact.name}](s3://${artifact.bucket}/${artifact.key})`;
}

function generateReportPages(definition: TestDefinition, run: TestRun, tests: ResolvedTest[]): ReportPages {
  const title = getProgramTitle(definition, { id: "", app: { bucket: "" } } as ModuleProps["config"]);
  const summary: string[] = [];
  const details: Record<string, string> = {};

  summary.push(`# ${title} Report`);
  summary.push("");
  summary.push("## Report Summary");
  summary.push("");
  summary.push(`- Program: ${escapeMarkdownCell(title)}`);
  summary.push(`- Run: ${escapeMarkdownCell(run.label)}`);
  summary.push(`- Generated On: ${escapeMarkdownCell(formatDate(nowIso()))}`);
  summary.push(`- Tests in Scope: ${tests.length}`);
  summary.push("");
  summary.push("## Results Summary");
  summary.push("");
  summary.push("| Test ID | Test Group | Status | Failure Mode | Target Module | Detail |");
  summary.push("|---|---|---|---|---|---|");

  for (const test of tests) {
    const result = ensureResult(run, test);
    summary.push(`| ${escapeMarkdownCell(test.id)} | ${escapeMarkdownCell(test.testGroupId)} | ${escapeMarkdownCell(result.status)} | ${escapeMarkdownCell(valueDisplay(test.definedValues.failure_mode))} | ${escapeMarkdownCell(valueDisplay(test.definedValues.target_module))} | [View](tests/${test.id}.md) |`);

    const detail: string[] = [];
    detail.push(`# Test Result: ${test.id}`);
    detail.push("");
    detail.push(`- Program: ${escapeMarkdownCell(title)}`);
    detail.push(`- Run: ${escapeMarkdownCell(run.label)}`);
    detail.push(`- Test Group: ${escapeMarkdownCell(test.testGroupTitle)}`);
    detail.push(`- Status: ${escapeMarkdownCell(result.status)}`);
    detail.push(`- Last Updated: ${escapeMarkdownCell(formatDate(result.updatedAt))}`);
    detail.push("");
    if (test.preTestGuidance) {
      detail.push("## Pre-Test Guidance");
      detail.push("");
      detail.push(test.preTestGuidance.trim());
      detail.push("");
    }
    if (test.preTestAssets.length > 0) {
      detail.push("## Pre-Test Assets");
      detail.push("");
      for (const asset of test.preTestAssets) {
        detail.push(`- ${asset.label}: ${asset.type === "image_url" ? asset.content : "[generated svg asset]"}`);
      }
      detail.push("");
    }
    if (test.equipmentRuntime.length > 0) {
      detail.push("## Equipment Runtime");
      detail.push("");
      for (const spec of test.equipmentRuntime) {
        detail.push(`- ${spec.label}: provider=${spec.provider}; mode=${spec.mode}; actions=${spec.actions.join(", ")}; outputs=${spec.outputs.join(", ")}`);
      }
      detail.push("");
    }
    detail.push("## Test Definitions");
    detail.push("");
    for (const [key, value] of Object.entries(test.definedValues)) {
      detail.push(`- ${humanize(key)}: ${escapeMarkdownCell(valueDisplay(value))}`);
    }
    detail.push("");
    detail.push("## Runtime Inputs");
    detail.push("");
    for (const [key, value] of Object.entries(result.inputValues)) {
      detail.push(`- ${humanize(key)}: ${escapeMarkdownCell(valueDisplay(value))}`);
    }
    if (isMeaningful(result.notes)) detail.push(`- Notes: ${escapeMarkdownCell(result.notes)}`);
    detail.push("");
    if (Object.keys(result.typedArtifacts).length > 0) {
      detail.push("## Runtime Files");
      detail.push("");
      for (const [fieldId, artifacts] of Object.entries(result.typedArtifacts)) {
        detail.push(`### ${humanize(fieldId)}`);
        for (const artifact of artifacts) detail.push(`- ${markdownArtifactLink(artifact)}`);
        detail.push("");
      }
    }
    if (result.supportingArtifacts.length > 0) {
      detail.push("## Supporting Files");
      detail.push("");
      for (const artifact of result.supportingArtifacts) detail.push(`- ${markdownArtifactLink(artifact)}`);
      detail.push("");
    }
    detail.push("## Navigation");
    detail.push("");
    detail.push("- [Back to Report Summary](../report.md)");
    detail.push("");
    details[test.id] = detail.join("\n");
  }

  return { summary: summary.join("\n"), details };
}

function FieldInput({
  field,
  value,
  definition,
  onChange,
}: {
  field: FieldDefinition;
  value: Scalar;
  definition: TestDefinition;
  onChange: (nextValue: Scalar) => void;
}) {
  const linkedSet = field.linkedValueSet
    ? (definition.linkedValues[field.linkedValueSet] ?? definition.linkedValues[field.id] ?? definition.linkedValues[guessLinkedValueSet(field.id) ?? ""])
    : undefined;
  const type = field.type.toLowerCase();
  const options = field.options ?? linkedSet?.map((entry) => ({ value: entry.id, label: entry.label }));

  if (type.includes("multiline") || type.includes("textarea") || type.includes("notes")) {
    return (
      <label style={labelStyle()}>
        {field.label}{field.required ? " *" : ""}
        <textarea value={value == null ? "" : String(value)} onChange={(event) => onChange(event.target.value)} rows={4} style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.5 }} />
      </label>
    );
  }

  if (type.includes("boolean")) {
    return (
      <label style={{ display: "flex", alignItems: "center", gap: "0.55rem", color: C.text }}>
        <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
        {field.label}
      </label>
    );
  }

  if (type.includes("enum") || type.includes("select") || options?.length) {
    return (
      <label style={labelStyle()}>
        {field.label}{field.required ? " *" : ""}
        <select value={value == null ? "" : String(value)} onChange={(event) => onChange(event.target.value)} style={inputStyle()}>
          <option value="">Select...</option>
          {options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    );
  }

  return (
    <label style={labelStyle()}>
      {field.label}{field.required ? " *" : ""}
      <input
        type={type.includes("number") ? "number" : "text"}
        value={value == null ? "" : String(value)}
        onChange={(event) => onChange(type.includes("number") ? (event.target.value === "" ? null : Number(event.target.value)) : event.target.value)}
        style={inputStyle()}
      />
    </label>
  );
}

function ArtifactField({
  field,
  artifacts,
  supporting = false,
  onUpload,
}: {
  field: FieldDefinition;
  artifacts: ArtifactRef[];
  supporting?: boolean;
  onUpload: (files: FileList | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const accept = artifactAccept(field);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.55rem" }}>
      <div style={{ color: C.muted, fontSize: "0.78rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
        {field.label}{field.required ? " *" : ""}
      </div>
      <div
        onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          onUpload(event.dataTransfer.files);
        }}
        style={{
          border: `1px dashed ${dragActive ? C.accent : C.border}`,
          borderRadius: 12,
          background: dragActive ? C.accentSoft : C.panel2,
          padding: "0.9rem",
        }}
      >
        <div style={{ color: C.text, fontSize: "0.9rem" }}>
          Drop {supporting ? "supporting files" : "runtime files"} here, or{" "}
          <button type="button" onClick={() => inputRef.current?.click()} style={{ ...buttonStyle("ghost"), padding: "0.25rem 0.45rem", display: "inline-block" }}>
            browse
          </button>
        </div>
        <div style={{ marginTop: "0.4rem", color: C.muted, fontSize: "0.8rem" }}>
          {supporting ? "Ad hoc files are stored predictably for this test and linked from the detail page." : "Known file inputs can be rendered or linked consistently in the report."}
        </div>
        <input
          ref={inputRef}
          type="file"
          hidden
          multiple
          accept={accept}
          onChange={(event) => {
            onUpload(event.target.files);
            event.target.value = "";
          }}
        />
      </div>
      {artifacts.length === 0 ? (
        <div style={{ color: C.muted, fontSize: "0.82rem" }}>No files uploaded yet.</div>
      ) : (
        <div style={{ display: "grid", gap: "0.45rem" }}>
          {artifacts.map((artifact) => (
            <div key={artifact.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.panel2, padding: "0.65rem 0.75rem" }}>
              <div style={{ color: C.text, fontSize: "0.86rem", fontWeight: 600 }}>{artifact.name}</div>
              <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.78rem" }}>{artifact.contentType || "file"} · {Math.max(1, Math.round(artifact.sizeBytes / 1024))} KB · {formatDate(artifact.uploadedAt)}</div>
              <div style={{ marginTop: "0.25rem", color: C.accent, fontSize: "0.76rem", wordBreak: "break-all" }}>s3://{artifact.bucket}/{artifact.key}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, background: C.panel2, padding: "0.8rem 0.9rem" }}>
      <div style={{ color: C.muted, fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>{label}</div>
      <div style={{ marginTop: "0.35rem", fontSize: "1.25rem", fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function MarkdownBlock({ value }: { value: string }) {
  return (
    <div style={markdownContainerStyle()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 style={{ margin: "0 0 0.7rem", fontSize: "1.35rem" }}>{children}</h1>,
          h2: ({ children }) => <h2 style={{ margin: "1rem 0 0.6rem", fontSize: "1.1rem" }}>{children}</h2>,
          h3: ({ children }) => <h3 style={{ margin: "0.9rem 0 0.45rem", fontSize: "1rem" }}>{children}</h3>,
          p: ({ children }) => <p style={{ margin: "0.45rem 0" }}>{children}</p>,
          ul: ({ children }) => <ul style={{ margin: "0.45rem 0", paddingLeft: "1.2rem" }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: "0.45rem 0", paddingLeft: "1.2rem" }}>{children}</ol>,
          li: ({ children }) => <li style={{ margin: "0.2rem 0" }}>{children}</li>,
          code: ({ children }) => <code style={{ background: "#07111e", padding: "0.1rem 0.25rem", borderRadius: 4 }}>{children}</code>,
          pre: ({ children }) => <pre style={{ background: "#07111e", border: `1px solid ${C.border}`, borderRadius: 12, padding: "0.85rem", overflowX: "auto" }}>{children}</pre>,
          img: ({ src, alt }) => <img src={src ?? ""} alt={alt ?? ""} style={{ maxWidth: "100%", borderRadius: 12, border: `1px solid ${C.border}`, background: C.panel2, padding: "0.35rem" }} />,
          table: ({ children }) => <table style={{ width: "100%", borderCollapse: "collapse", margin: "0.7rem 0" }}>{children}</table>,
          th: ({ children }) => <th style={{ textAlign: "left", borderBottom: `1px solid ${C.border}`, padding: "0.45rem" }}>{children}</th>,
          td: ({ children }) => <td style={{ borderBottom: `1px solid ${C.border}`, padding: "0.45rem", verticalAlign: "top" }}>{children}</td>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" style={{ color: C.accent }}>{children}</a>,
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}

function PreTestAssetGallery({ assets }: { assets: PreTestAsset[] }) {
  if (assets.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
      {assets.map((asset) => (
        <div key={asset.id} style={{ border: `1px solid ${C.border}`, borderRadius: 14, background: C.panel2, padding: "0.75rem" }}>
          <div style={{ color: C.muted, fontSize: "0.74rem", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>{asset.label}</div>
          <div style={{ marginTop: "0.55rem" }}>
            {asset.type === "svg_inline" || asset.type === "diagram_svg" ? (
              <div
                style={{ border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", background: "#07111e" }}
                dangerouslySetInnerHTML={{ __html: asset.content }}
              />
            ) : (
              <img src={asset.content} alt={asset.label} style={{ maxWidth: "100%", borderRadius: 12, border: `1px solid ${C.border}`, background: "#07111e" }} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function EquipmentRuntimePanel({ specs }: { specs: EquipmentRuntimeSpec[] }) {
  if (specs.length === 0) return null;
  return (
    <section style={cardStyle()}>
      <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Connected Equipment</div>
      <div style={{ marginTop: "0.85rem", display: "grid", gap: "0.9rem" }}>
        {specs.map((spec) => (
          <div key={spec.id} style={{ border: `1px solid ${C.border}`, borderRadius: 14, background: C.panel2, padding: "0.85rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontWeight: 700 }}>{spec.label}</div>
                <div style={{ marginTop: "0.2rem", color: C.muted, fontSize: "0.8rem" }}>{spec.provider} · {spec.mode}</div>
              </div>
              <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
                {spec.actions.map((action) => (
                  <button key={action} type="button" style={buttonStyle("ghost")}>{action}</button>
                ))}
              </div>
            </div>
            {spec.outputs.length > 0 ? (
              <div style={{ marginTop: "0.65rem", color: C.muted, fontSize: "0.8rem" }}>
                Outputs: {spec.outputs.join(", ")}
              </div>
            ) : null}
            {spec.notes ? (
              <div style={{ marginTop: "0.45rem", color: C.text, fontSize: "0.84rem", lineHeight: 1.55 }}>{spec.notes}</div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

export default function TestManager({ config }: ModuleProps) {
  const user = useUserProfile();
  const getS3Client = useAwsS3Client();
  const storage = useMemo(() => getStorageInfo(config), [config]);
  const importRef = useRef<HTMLInputElement>(null);

  const [definition, setDefinition] = useState<TestDefinition | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [section, setSection] = useState<AppSection>("run");
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const resolvedTests = useMemo(() => definition ? buildResolvedTests(definition) : [], [definition]);
  const testsById = useMemo(() => new Map(resolvedTests.map((test) => [test.id, test])), [resolvedTests]);
  const scalarInputFields = useMemo(() => (definition?.inputFields ?? []).filter((field) => !isArtifactField(field) && field.id !== "operator_notes"), [definition]);
  const artifactInputFields = useMemo(() => (definition?.inputFields ?? []).filter(isArtifactField), [definition]);
  const operatorNotesField = useMemo(() => (definition?.inputFields ?? []).find((field) => field.id === "operator_notes"), [definition]);

  useEffect(() => {
    if (!selectedTestId && resolvedTests[0]) setSelectedTestId(resolvedTests[0].id);
    if (selectedTestId && !testsById.has(selectedTestId) && resolvedTests[0]) setSelectedTestId(resolvedTests[0].id);
  }, [resolvedTests, selectedTestId, testsById]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const s3 = await getS3Client(storage.bucket);
      const [definitionText, workspaceText] = await Promise.all([
        readOptionalText(s3, storage.bucket, storage.definitionKey),
        readOptionalText(s3, storage.bucket, storage.resultsKey),
      ]);
      setDefinition(definitionText ? parseDefinition(definitionText) : null);
      setWorkspace(normalizeWorkspaceState(workspaceText ? JSON.parse(workspaceText) : null, storage.projectId, user?.email));
    } catch (loadError: unknown) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [getS3Client, storage.bucket, storage.definitionKey, storage.projectId, storage.resultsKey, user?.email]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const persistWorkspace = useCallback(async (nextWorkspace: WorkspaceState, successMessage = "Saved"): Promise<void> => {
    setSaving(true);
    setError("");
    try {
      const s3 = await getS3Client(storage.bucket);
      await writeText(s3, storage.bucket, storage.resultsKey, JSON.stringify(nextWorkspace, null, 2), "application/json");
      setWorkspace(nextWorkspace);
      setMessage(successMessage);
    } catch (saveError: unknown) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  }, [getS3Client, storage.bucket, storage.resultsKey]);

  const persistDefinition = useCallback(async (yamlText: string): Promise<void> => {
    setSaving(true);
    setError("");
    try {
      const s3 = await getS3Client(storage.bucket);
      await writeText(s3, storage.bucket, storage.definitionKey, yamlText, "text/yaml;charset=utf-8");
      setDefinition(parseDefinition(yamlText));
      setMessage("Definition uploaded");
    } catch (saveError: unknown) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  }, [getS3Client, storage.bucket, storage.definitionKey]);

  const updateWorkspace = useCallback((mutate: (current: WorkspaceState) => WorkspaceState, successMessage = "Saved") => {
    if (!workspace) return;
    void persistWorkspace(mutate(workspace), successMessage);
  }, [persistWorkspace, workspace]);

  const activeRun = workspace ? getActiveRun(workspace) : null;
  const selectedTest = selectedTestId ? testsById.get(selectedTestId) ?? null : null;
  const selectedResult = selectedTest && activeRun ? ensureResult(activeRun, selectedTest, user?.email) : null;

  const createRun = useCallback(() => {
    if (!workspace) return;
    const nextRun = createDefaultRun(user?.email, `Run ${workspace.runs.length + 1}`);
    updateWorkspace((current) => ({
      ...current,
      activeRunId: nextRun.id,
      runs: [nextRun, ...current.runs],
    }), "New run created");
  }, [updateWorkspace, user?.email, workspace]);

  const updateSelectedResult = useCallback((mutate: (current: ResultRecord) => ResultRecord) => {
    if (!workspace || !activeRun || !selectedTest) return;
    const current = ensureResult(activeRun, selectedTest, user?.email);
    const nextRecord = mutate(current);
    updateWorkspace((currentWorkspace) => ({
      ...currentWorkspace,
      runs: currentWorkspace.runs.map((run) => run.id !== activeRun.id ? run : {
        ...run,
        updatedAt: nowIso(),
        resultsByTestId: {
          ...run.resultsByTestId,
          [selectedTest.id]: {
            ...nextRecord,
            updatedAt: nowIso(),
            updatedBy: user?.email,
            startedAt: nextRecord.startedAt ?? nowIso(),
          },
        },
      }),
    }));
  }, [activeRun, selectedTest, updateWorkspace, user?.email, workspace]);

  const uploadArtifacts = useCallback(async (files: FileList | null, testId: string, fieldId: string | null) => {
    if (!files?.length || !activeRun) return;
    const test = testsById.get(testId);
    if (!test) return;
    setSaving(true);
    setError("");
    try {
      const s3 = await getS3Client(storage.bucket);
      const uploaded: ArtifactRef[] = [];
      for (const file of Array.from(files)) {
        const key = artifactStoragePath(storage, activeRun.id, testId, fieldId, file.name);
        await s3.send(new PutObjectCommand({
          Bucket: storage.bucket,
          Key: key,
          Body: new Uint8Array(await file.arrayBuffer()),
          ContentType: file.type || "application/octet-stream",
          CacheControl: "no-store",
        }));
        uploaded.push({
          id: makeId("artifact"),
          fieldId: fieldId ?? undefined,
          kind: fieldId ? "typed" : "supporting",
          name: file.name,
          bucket: storage.bucket,
          key,
          contentType: file.type || undefined,
          sizeBytes: file.size,
          uploadedAt: nowIso(),
          uploadedBy: user?.email,
        });
      }

      updateWorkspace((currentWorkspace) => ({
        ...currentWorkspace,
        runs: currentWorkspace.runs.map((run) => {
          if (run.id !== activeRun.id) return run;
          const currentResult = ensureResult(run, test, user?.email);
          return {
            ...run,
            updatedAt: nowIso(),
            resultsByTestId: {
              ...run.resultsByTestId,
              [testId]: {
                ...currentResult,
                typedArtifacts: fieldId
                  ? { ...currentResult.typedArtifacts, [fieldId]: [...(currentResult.typedArtifacts[fieldId] ?? []), ...uploaded] }
                  : currentResult.typedArtifacts,
                supportingArtifacts: fieldId ? currentResult.supportingArtifacts : [...currentResult.supportingArtifacts, ...uploaded],
                updatedAt: nowIso(),
                updatedBy: user?.email,
                startedAt: currentResult.startedAt ?? nowIso(),
              },
            },
          };
        }),
      }), "Artifacts uploaded");
    } catch (uploadError: unknown) {
      setError((uploadError as Error).message);
      setSaving(false);
    }
  }, [activeRun, getS3Client, storage, testsById, updateWorkspace, user?.email]);

  const validationIssues = useMemo(() => {
    if (!definition || !activeRun) return [];
    return resolvedTests.flatMap((test) => {
      const result = ensureResult(activeRun, test, user?.email);
      const runtimeIssues = definition.inputFields.flatMap((field) => {
        if (isArtifactField(field)) {
          return field.required && (result.typedArtifacts[field.id]?.length ?? 0) === 0 ? [`${test.id}: ${field.label} requires at least one file.`] : [];
        }
        const candidate = field.id === "status" ? result.status : result.inputValues[field.id];
        return field.required && !isMeaningful(candidate) ? [`${test.id}: ${field.label} is required.`] : [];
      });
      return [
        ...test.fieldIssues.map((issue) => `${test.id}: ${issue}`),
        ...test.linkedValueIssues.map((issue) => `${test.id}: ${issue}`),
        ...runtimeIssues,
      ];
    });
  }, [activeRun, definition, resolvedTests, user?.email]);

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const status of STATUS_OPTIONS) counts.set(status, 0);
    if (!activeRun) return counts;
    for (const test of resolvedTests) {
      const status = ensureResult(activeRun, test, user?.email).status;
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return counts;
  }, [activeRun, resolvedTests, user?.email]);

  const completion = useMemo(() => {
    if (!activeRun || resolvedTests.length === 0) return 0;
    const doneCount = resolvedTests.filter((test) => {
      const status = ensureResult(activeRun, test, user?.email).status;
      return status === "pass" || status === "fail" || status === "blocked";
    }).length;
    return Math.round((doneCount / resolvedTests.length) * 100);
  }, [activeRun, resolvedTests, user?.email]);

  const reportPages = useMemo(() => {
    if (!definition || !activeRun) return null;
    return generateReportPages(definition, activeRun, resolvedTests);
  }, [activeRun, definition, resolvedTests]);

  if (loading || !workspace) {
    return <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, color: C.muted }}>Loading test manager...</div>;
  }

  return (
    <div style={{ height: "100%", minHeight: 0, display: "grid", gridTemplateRows: "auto auto auto 1fr", background: C.bg, color: C.text, fontFamily: "\"Segoe UI\", \"Aptos\", sans-serif" }}>
      <header style={{ padding: "1rem 1.1rem", borderBottom: `1px solid ${C.border}`, background: C.header, display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: "0.72rem", color: C.accent, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>Test Manager</div>
          <h2 style={{ margin: "0.2rem 0 0", fontSize: "1.35rem" }}>{getProgramTitle(definition, config)}</h2>
          <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.82rem" }}>
            {definition ? `${resolvedTests.length} tests across ${definition.testGroups.length} groups` : "No test definition uploaded yet"} · {storage.projectId}
          </div>
          {getProgramDescription(definition) ? <p style={{ margin: "0.55rem 0 0", color: C.text, maxWidth: 780, lineHeight: 1.55 }}>{getProgramDescription(definition)}</p> : null}
        </div>
        <div style={{ display: "flex", gap: "0.55rem", alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => importRef.current?.click()} style={buttonStyle("primary")}>Upload YAML</button>
          <button onClick={() => definition && downloadText(`test-definition-${storage.projectId}.yaml`, definition.sourceText, "text/yaml;charset=utf-8")} style={buttonStyle()} disabled={!definition}>Download YAML</button>
          <button onClick={() => reportPages && downloadText("report.md", reportPages.summary, "text/markdown;charset=utf-8")} style={buttonStyle()} disabled={!reportPages}>Export Summary</button>
          <button onClick={() => downloadText(`test-workspace-${storage.projectId}.json`, JSON.stringify(workspace, null, 2), "application/json")} style={buttonStyle()}>Export Workspace</button>
          <button onClick={createRun} style={buttonStyle()}>New Run</button>
          <button onClick={() => void loadAll()} style={buttonStyle()}>Reload</button>
          <input
            ref={importRef}
            type="file"
            accept=".yaml,.yml,text/yaml,text/plain"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void file.text().then((text) => persistDefinition(text));
              event.target.value = "";
            }}
          />
        </div>
      </header>

      <section style={{ padding: "0.8rem 1rem", display: "flex", gap: "0.55rem", borderBottom: `1px solid ${C.border}`, background: C.panel, flexWrap: "wrap" }}>
        {(["run", "report"] as AppSection[]).map((candidate) => (
          <button key={candidate} onClick={() => setSection(candidate)} style={{ ...buttonStyle(section === candidate ? "primary" : "ghost"), minWidth: 110 }}>
            {SECTION_LABELS[candidate]}
          </button>
        ))}
      </section>

      <section style={{ padding: "0.75rem 1rem", display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center", borderBottom: `1px solid ${C.border}`, background: C.panel2 }}>
        <label style={{ ...labelStyle(), minWidth: 220 }}>
          Active Run
          <select value={workspace.activeRunId ?? ""} onChange={(event) => updateWorkspace((current) => ({ ...current, activeRunId: event.target.value }), "Active run updated")} style={inputStyle()}>
            {workspace.runs.map((run) => <option key={run.id} value={run.id}>{run.label} · {formatDate(run.updatedAt)}</option>)}
          </select>
        </label>
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 999, padding: "0.32rem 0.75rem", fontSize: "0.78rem", fontWeight: 700 }}>Completion: {completion}%</div>
        {STATUS_OPTIONS.map((status) => (
          <div key={status} style={{ border: `1px solid ${statusTone(status)}`, borderRadius: 999, padding: "0.32rem 0.7rem", color: statusTone(status), fontSize: "0.78rem", fontWeight: 700 }}>
            {humanize(status)}: {statusCounts.get(status) ?? 0}
          </div>
        ))}
        <div style={{ color: validationIssues.length ? C.warning : C.ok, fontSize: "0.82rem", fontWeight: 700 }}>
          {validationIssues.length ? `${validationIssues.length} validation issue${validationIssues.length === 1 ? "" : "s"}` : "Resolved records are valid"}
        </div>
      </section>

      {(error || message || saving) && (
        <div style={{ padding: "0.5rem 1rem", borderBottom: `1px solid ${C.border}`, color: error ? C.danger : saving ? C.accent : C.ok, background: C.panel, fontSize: "0.82rem" }}>
          {error || (saving ? "Saving..." : message)}
        </div>
      )}

      <main style={{ minHeight: 0, display: "grid", gridTemplateColumns: section === "run" ? "330px 1fr" : "1fr", gap: "1px", background: C.border }}>
        {section === "run" ? (
          <>
            <aside style={{ minHeight: 0, overflowY: "auto", background: C.panel }}>
              {!definition ? (
                <div style={{ padding: "1rem", color: C.muted, lineHeight: 1.6 }}>
                  Upload the master YAML test definition to start.
                  <div style={{ marginTop: "0.5rem", fontFamily: "Consolas, monospace", fontSize: "0.78rem", color: C.text }}>{storage.definitionKey}</div>
                </div>
              ) : definition.testGroups.map((group) => (
                <section key={group.id} style={{ borderBottom: `1px solid ${C.border}`, padding: "0.55rem 0.55rem 0.75rem" }}>
                  <div style={{ padding: "0.85rem 0.95rem", background: "rgba(148,163,184,0.08)", border: `1px solid ${C.border}`, borderRadius: 12 }}>
                    <div style={{ fontWeight: 700, fontSize: "0.92rem", color: "#dbe7f3" }}>{group.title}</div>
                    {group.description ? <div style={{ color: C.muted, fontSize: "0.8rem", marginTop: "0.3rem", lineHeight: 1.45 }}>{group.description}</div> : null}
                  </div>
                  <div style={{ padding: "0.5rem 0.15rem 0 0.9rem", display: "grid", gap: "0.45rem" }}>
                    {group.tests.map((test) => {
                      const resolved = testsById.get(test.id);
                      if (!resolved || !activeRun) return null;
                      const result = ensureResult(activeRun, resolved, user?.email);
                      const invalid = resolved.fieldIssues.length + resolved.linkedValueIssues.length > 0;
                      return (
                        <button
                          key={test.id}
                          onClick={() => setSelectedTestId(test.id)}
                          style={{
                            width: "100%",
                            textAlign: "left",
                            border: `1px solid ${selectedTestId === test.id ? C.accent : C.border}`,
                            background: selectedTestId === test.id ? C.accentSoft : "transparent",
                            color: C.text,
                            padding: "0.75rem",
                            borderRadius: 10,
                            cursor: "pointer",
                            fontFamily: "inherit",
                            marginLeft: "0.4rem",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
                            <strong style={{ fontSize: "0.88rem" }}>{test.title}</strong>
                            <span style={{ border: `1px solid ${statusTone(result.status)}`, color: statusTone(result.status), borderRadius: 999, padding: "0.15rem 0.45rem", fontSize: "0.68rem", fontWeight: 700 }}>{result.status}</span>
                          </div>
                          <div style={{ marginTop: "0.3rem", color: C.muted, fontSize: "0.76rem" }}>{test.id}</div>
                          {invalid ? <div style={{ marginTop: "0.25rem", color: C.warning, fontSize: "0.72rem" }}>Definition needs attention</div> : null}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </aside>

            <section style={{ minHeight: 0, overflowY: "auto", background: C.panel2, padding: "1rem 1.1rem 1.2rem" }}>
              {!definition ? (
                <div style={{ color: C.muted, lineHeight: 1.7 }}>Upload a YAML definition to start evaluating runtime behavior and report export.</div>
              ) : !selectedTest || !activeRun || !selectedResult ? (
                <div style={{ color: C.muted }}>Choose a test from the left.</div>
              ) : (
                <div style={{ display: "grid", gap: "1rem" }}>
                  <section style={{ ...cardStyle(), overflow: "hidden", padding: 0 }}>
                    <div style={{ padding: "1rem 1.1rem", borderBottom: `1px solid ${C.border}`, background: "rgba(255,255,255,0.03)" }}>
                      <div style={{ color: C.accent, fontSize: "0.72rem", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>{selectedTest.testGroupTitle}</div>
                      <h3 style={{ margin: "0.2rem 0 0", fontSize: "1.25rem" }}>{selectedTest.title}</h3>
                      <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.82rem" }}>{selectedTest.id}</div>
                    </div>
                    <div style={{ padding: "1rem 1.1rem", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.85rem" }}>
                      <label style={labelStyle()}>
                        Execution Status
                        <select value={selectedResult.status} onChange={(event) => updateSelectedResult((current) => ({ ...current, status: event.target.value, inputValues: { ...current.inputValues, status: event.target.value } }))} style={inputStyle()}>
                          {STATUS_OPTIONS.map((status) => <option key={status} value={status}>{humanize(status)}</option>)}
                        </select>
                      </label>
                      <label style={labelStyle()}>
                        Run Label
                        <input value={activeRun.label} onChange={(event) => updateWorkspace((current) => ({
                          ...current,
                          runs: current.runs.map((run) => run.id === activeRun.id ? { ...run, label: event.target.value, updatedAt: nowIso() } : run),
                        }), "Run renamed")} style={inputStyle()} />
                      </label>
                      <label style={labelStyle()}>
                        Started
                        <input value={formatDate(selectedResult.startedAt)} readOnly style={inputStyle()} />
                      </label>
                      <label style={labelStyle()}>
                        Last Updated
                        <input value={formatDate(selectedResult.updatedAt)} readOnly style={inputStyle()} />
                      </label>
                    </div>
                  </section>

                  {(selectedTest.preTestGuidance || selectedTest.preTestAssets.length > 0) ? (
                    <section style={cardStyle()}>
                      <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Pre-Test Guidance</div>
                      <div style={{ marginTop: "0.85rem" }}>
                        {selectedTest.preTestGuidance ? <MarkdownBlock value={selectedTest.preTestGuidance} /> : null}
                        {selectedTest.preTestAssets.length > 0 ? <div style={{ marginTop: selectedTest.preTestGuidance ? "1rem" : 0 }}><PreTestAssetGallery assets={selectedTest.preTestAssets} /></div> : null}
                      </div>
                    </section>
                  ) : null}

                  {(selectedTest.fieldIssues.length > 0 || selectedTest.linkedValueIssues.length > 0) && (
                    <section style={{ border: `1px solid ${C.warning}`, borderRadius: 14, background: "rgba(251,191,36,0.08)", padding: "0.95rem 1rem" }}>
                      <div style={{ fontWeight: 700, color: C.warning, marginBottom: "0.45rem" }}>Definition Issues</div>
                      {[...selectedTest.fieldIssues, ...selectedTest.linkedValueIssues].map((issue) => (
                        <div key={issue} style={{ color: C.text, fontSize: "0.88rem", lineHeight: 1.6 }}>{issue}</div>
                      ))}
                    </section>
                  )}

                  <section style={cardStyle()}>
                    <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Test Definitions</div>
                    <div style={{ marginTop: "0.85rem", display: "grid", gap: "0.45rem" }}>
                      {definition.testDefinedFields.filter((field) => !["pre_test_guidance", "pre_test_assets", "equipment_runtime"].includes(field.id)).map((field) => {
                        const value = selectedTest.definedValues[field.id];
                        const linkedLabel = getLinkedValueLabel(definition, field, value);
                        return (
                          <div key={field.id} style={{ borderBottom: `1px solid ${C.border}`, paddingBottom: "0.45rem" }}>
                            <span style={{ color: C.muted, fontSize: "0.82rem", fontWeight: 700 }}>{field.label}:</span>{" "}
                            <span style={{ color: C.text }}>{valueDisplay(value)}</span>
                            {linkedLabel && linkedLabel !== String(value) ? <span style={{ color: C.accent, fontSize: "0.82rem" }}> ({linkedLabel})</span> : null}
                          </div>
                        );
                      })}
                    </div>
                  </section>

                  <section style={cardStyle()}>
                    <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Runtime Inputs</div>
                    {selectedTest.equipmentRuntime.length > 0 ? (
                      <div style={{ marginTop: "0.85rem" }}>
                        <EquipmentRuntimePanel specs={selectedTest.equipmentRuntime} />
                      </div>
                    ) : null}
                    <div style={{ marginTop: "0.85rem", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "0.9rem" }}>
                      {scalarInputFields.length === 0 ? (
                        <div style={{ color: C.muted }}>No runtime input fields were defined in the YAML file yet.</div>
                      ) : scalarInputFields.map((field) => (
                        <FieldInput
                          key={field.id}
                          field={field}
                          value={field.id === "status" ? selectedResult.status : selectedResult.inputValues[field.id] ?? null}
                          definition={definition}
                          onChange={(nextValue) => updateSelectedResult((current) => ({
                            ...current,
                            status: field.id === "status" ? String(nextValue ?? "not-run") : current.status,
                            inputValues: {
                              ...current.inputValues,
                              [field.id]: coerceRuntimeValue(nextValue, field.type.toLowerCase()),
                            },
                          }))}
                        />
                      ))}
                    </div>
                    <div style={{ marginTop: "1rem" }}>
                      <div style={{ display: "grid", gap: "1rem" }}>
                        {artifactInputFields.map((field) => (
                          <ArtifactField key={field.id} field={field} artifacts={selectedResult.typedArtifacts[field.id] ?? []} onUpload={(files) => void uploadArtifacts(files, selectedTest.id, field.id)} />
                        ))}
                      </div>
                    </div>
                    <div style={{ marginTop: "1rem" }}>
                      <label style={labelStyle()}>
                        {operatorNotesField?.label ?? "Operator Notes"}
                        <textarea value={selectedResult.notes} onChange={(event) => updateSelectedResult((current) => ({ ...current, notes: event.target.value }))} rows={6} style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.55 }} />
                      </label>
                    </div>
                    <div style={{ marginTop: "1rem" }}>
                      <ArtifactField
                        field={{ id: "supporting_files", label: "Supporting Files", type: "file_list", required: false }}
                        artifacts={selectedResult.supportingArtifacts}
                        supporting
                        onUpload={(files) => void uploadArtifacts(files, selectedTest.id, null)}
                      />
                    </div>
                  </section>
                </div>
              )}
            </section>
          </>
        ) : (
          <section style={{ minHeight: 0, overflowY: "auto", background: C.panel2, padding: "1rem 1.1rem 1.2rem" }}>
            <div style={{ display: "grid", gap: "1rem" }}>
                <section style={cardStyle()}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Summary Page Preview</div>
                      <div style={{ marginTop: "0.35rem", color: C.muted, fontSize: "0.84rem" }}>The report exports as a summary page with links to separate per-test detail pages.</div>
                    </div>
                    <button onClick={() => reportPages && downloadText("report.md", reportPages.summary, "text/markdown;charset=utf-8")} style={buttonStyle("primary")} disabled={!reportPages}>Download Summary</button>
                  </div>
                  <div style={{ margin: "0.95rem 0 0", padding: "0.95rem", borderRadius: 12, background: "#07111e", border: `1px solid ${C.border}` }}>
                    <MarkdownBlock value={reportPages?.summary || "Upload a YAML definition to generate the report preview."} />
                  </div>
              </section>

              {selectedTest && reportPages?.details[selectedTest.id] ? (
                <section style={cardStyle()}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Selected Test Detail Preview</div>
                      <div style={{ marginTop: "0.35rem", color: C.muted, fontSize: "0.84rem" }}>Typed runtime files and ad hoc supporting files are linked from the test page.</div>
                    </div>
                    <button onClick={() => downloadText(`${selectedTest.id}.md`, reportPages.details[selectedTest.id], "text/markdown;charset=utf-8")} style={buttonStyle()} disabled={!reportPages?.details[selectedTest.id]}>Download Selected Test Page</button>
                  </div>
                  <div style={{ margin: "0.95rem 0 0", padding: "0.95rem", borderRadius: 12, background: "#07111e", border: `1px solid ${C.border}` }}>
                    <MarkdownBlock value={reportPages.details[selectedTest.id]} />
                  </div>
                </section>
              ) : null}

              <section style={cardStyle()}>
                <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Included Materials</div>
                <div style={{ marginTop: "0.85rem", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.8rem" }}>
                  <MetricCard label="Resolved Tests" value={String(resolvedTests.length)} />
                  <MetricCard label="Validation Issues" value={String(validationIssues.length)} />
                  <MetricCard label="Typed File Fields" value={String(definition?.inputFields.filter(isArtifactField).length ?? 0)} />
                  <MetricCard label="Current Run" value={activeRun?.label ?? "-"} />
                </div>
              </section>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

export async function onExport(ctx: ExportContext): Promise<void> {
  const storage = getStorageInfo(ctx.config);
  const [definitionText, workspaceText] = await Promise.all([
    readOptionalText(ctx.s3Client as S3Client, storage.bucket, storage.definitionKey),
    readOptionalText(ctx.s3Client as S3Client, storage.bucket, storage.resultsKey),
  ]);

  if (definitionText) {
    await writeText(ctx.s3Client as S3Client, storage.bucket, `${ctx.projectPrefix}${ctx.config.id}/export/definition.yaml`, definitionText, "text/yaml;charset=utf-8");
  }
  if (workspaceText) {
    await writeText(ctx.s3Client as S3Client, storage.bucket, `${ctx.projectPrefix}${ctx.config.id}/export/workspace.json`, workspaceText, "application/json");
  }

  if (definitionText && workspaceText) {
    const definition = parseDefinition(definitionText);
    const workspace = normalizeWorkspaceState(JSON.parse(workspaceText), storage.projectId);
    const activeRun = getActiveRun(workspace);
    const tests = buildResolvedTests(definition);
    const pages = generateReportPages(definition, activeRun, tests);
    await writeText(ctx.s3Client as S3Client, storage.bucket, `${ctx.projectPrefix}${ctx.config.id}/export/report.md`, pages.summary, "text/markdown;charset=utf-8");
    for (const [testId, detail] of Object.entries(pages.details)) {
      await writeText(ctx.s3Client as S3Client, storage.bucket, `${ctx.projectPrefix}${ctx.config.id}/export/tests/${testId}.md`, detail, "text/markdown;charset=utf-8");
    }
  }
}
