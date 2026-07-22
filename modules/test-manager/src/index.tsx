import React, { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { parse as parseYaml } from "yaml";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ExportContext, ModuleProps } from "module-core";
import { useAwsS3Client, useUserProfile } from "module-core";

type Scalar = string | number | boolean | null;
type ValueMap = Record<string, unknown>;
type AppSection = "overview" | "run" | "report";

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
  programAssets: PreTestAsset[];
  diagrams: Record<string, DiagramDefinition>;
  steps: Record<string, ProcedureStep>;
  procedures: Record<string, ProcedureDefinition>;
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
  procedureIssues: string[];
  procedureSteps: ProcedureStep[];
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

type ProcedureStep = {
  id: string;
  title: string;
  instruction: string;
  expected?: string;
  requiresEvidence: boolean;
  safetyCritical: boolean;
};

type ProcedureEntry = {
  ref?: string;
  step?: ProcedureStep;
};

type ProcedureDefinition = {
  id: string;
  title: string;
  description?: string;
  steps: ProcedureEntry[];
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

type StepResult = {
  status: "not-run" | "done" | "skipped" | "failed" | "blocked";
  notes: string;
  checkedAt?: string;
  checkedBy?: string;
};

type ResultRecord = {
  status: string;
  inputValues: Record<string, Scalar>;
  notes: string;
  stepResultsById: Record<string, StepResult>;
  typedArtifacts: Record<string, ArtifactRef[]>;
  supportingArtifacts: ArtifactRef[];
  startedAt?: string;
  updatedAt: string;
  updatedBy?: string;
  inputFingerprint?: string;
};

type TestRun = {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  resultsByTestId: Record<string, ResultRecord>;
  excludedTestIds?: string[];
  excludedTestReasons?: Record<string, string>;
  definitionSnapshot?: string;
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
  assets: Record<string, { content: string; contentType: string }>;
};

type ReportArtifactContext = {
  test: ResolvedTest;
  fieldId: string | null;
  artifact: ArtifactRef;
};

type ReportGenerationOptions = {
  detailHref?: (test: ResolvedTest) => string;
  backToSummaryHref?: string;
  artifactHref?: (context: ReportArtifactContext) => string;
  notes?: string[];
};

type ZipFileContent = string | Uint8Array;

class TestManagerBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[test-manager] render failed:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ height: "100%", padding: "1.25rem", background: C.bg, color: C.danger, fontFamily: "\"Segoe UI\", \"Aptos\", sans-serif" }}>
          <strong>Test Manager failed to render</strong>
          <pre style={{ marginTop: "0.75rem", whiteSpace: "pre-wrap", color: C.text }}>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

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
const FINGERPRINT_EXCLUDED_KEYS = new Set([
  "test_group_id", "test_group_title", "test_id", "title", "description",
  "pre_test_guidance", "pre_test_assets", "equipment_runtime",
  "procedure", "test_steps", "preconditions", "expected_hazard_focus",
]);
const TERMINAL_STATUSES = new Set(["pass", "fail", "blocked"]);
const STATUS_OPTIONS = ["not-run", "in-progress", "pass", "fail", "blocked"];
const SECTION_LABELS: Record<AppSection, string> = { overview: "Overview", run: "Run", report: "Report" };

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

async function readOptionalBytes(s3: S3Client, bucket: string, key: string): Promise<Uint8Array | null> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return response.Body ? await response.Body.transformToByteArray() : null;
  } catch (error: unknown) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === "NoSuchKey" || err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
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

async function writeBytes(s3: S3Client, bucket: string, key: string, body: Uint8Array, contentType: string): Promise<void> {
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

function truncateSvgText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

function wrapSvgText(value: string, maxChars: number, maxLines: number): string[] {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const remainingLines = maxLines - lines.length;
    if (remainingLines <= 0) break;
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = word;
    } else {
      lines.push(truncateSvgText(word, maxChars));
      current = "";
    }
  }

  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[lines.length - 1] = truncateSvgText(lines[lines.length - 1], Math.max(1, maxChars - 3));
  }
  return lines.length ? lines : [""];
}

function renderWrappedSvgText(args: {
  value: string;
  x: number;
  y: number;
  maxChars: number;
  maxLines: number;
  lineHeight: number;
  fill: string;
  fontSize: number;
  fontWeight?: number;
}): string {
  const lines = wrapSvgText(args.value, args.maxChars, args.maxLines);
  const tspans = lines.map((line, index) =>
    `<tspan x="${args.x}" dy="${index === 0 ? 0 : args.lineHeight}">${escapeXml(line)}</tspan>`
  ).join("");
  return `<text x="${args.x}" y="${args.y}" text-anchor="middle" fill="${args.fill}" font-size="${args.fontSize}"${args.fontWeight ? ` font-weight="${args.fontWeight}"` : ""}>${tspans}</text>`;
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

function normalizeProcedureStep(id: string, value: unknown): ProcedureStep {
  const record = toRecord(value);
  return {
    id,
    title: toStringValue(record.title ?? record.label ?? record.name, humanize(id)),
    instruction: toStringValue(record.instruction ?? record.action ?? record.description, ""),
    expected: toStringValue(record.expected ?? record.expected_result ?? record.acceptance, "") || undefined,
    requiresEvidence: Boolean(record.requires_evidence ?? record.requiresEvidence),
    safetyCritical: Boolean(record.safety_critical ?? record.safetyCritical),
  };
}

function normalizeProcedureEntry(value: unknown, index: number): ProcedureEntry | null {
  if (typeof value === "string") return { ref: value };
  const record = toRecord(value);
  const ref = toStringValue(record.ref ?? record.step_ref ?? record.procedure_ref, "");
  if (ref) return { ref };
  const id = toStringValue(record.id, `step-${index + 1}`);
  const step = normalizeProcedureStep(id, record);
  return step.instruction || step.title ? { step } : null;
}

function normalizeProcedureEntries(value: unknown): ProcedureEntry[] {
  return Array.isArray(value)
    ? value.flatMap((entry, index) => {
        const normalized = normalizeProcedureEntry(entry, index);
        return normalized ? [normalized] : [];
      })
    : [];
}

function normalizeProcedureDefinitions(value: unknown): Record<string, ProcedureDefinition> {
  return Object.fromEntries(
    Object.entries(toRecord(value)).map(([id, procedure]) => {
      const record = toRecord(procedure);
      return [id, {
        id,
        title: toStringValue(record.title ?? record.label ?? record.name, humanize(id)),
        description: toStringValue(record.description, "") || undefined,
        steps: normalizeProcedureEntries(record.steps),
      }];
    })
  );
}

function normalizeProcedureStepDefinitions(value: unknown): Record<string, ProcedureStep> {
  return Object.fromEntries(
    Object.entries(toRecord(value)).map(([id, step]) => [id, normalizeProcedureStep(id, step)])
  );
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
  const nodeHeight = 104;
  const xGap = 72;
  const yGap = 32;
  const topPad = diagram.title ? 92 : 42;
  const maxLevel = Math.max(0, ...byLevel.keys());
  const maxRows = Math.max(1, ...[...byLevel.values()].map((items) => items.length));
  const width = Math.max(620, 48 + (maxLevel + 1) * nodeWidth + maxLevel * xGap + 48);
  const height = Math.max(260, topPad + maxRows * nodeHeight + (maxRows - 1) * yGap + 118);
  const nodeOrder = new Map(nodes.map((node, i) => [node.id, i]));
  const positions = new Map<string, { x: number; y: number; cx: number; cy: number }>();

  for (const [level, levelNodes] of byLevel.entries()) {
    const columnHeight = levelNodes.length * nodeHeight + (levelNodes.length - 1) * yGap;
    const startY = topPad + Math.max(0, ((height - topPad - 96) - columnHeight) / 2);
    levelNodes
      .sort((a, b) => (nodeOrder.get(a.id) ?? 0) - (nodeOrder.get(b.id) ?? 0))
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
    const label = renderWrappedSvgText({
      value: node.label,
      x: pos.cx,
      y: pos.y + 28,
      maxChars: 17,
      maxLines: 2,
      lineHeight: 18,
      fill: tone.text,
      fontSize: 15,
      fontWeight: 700,
    });
    const note = node.note ? renderWrappedSvgText({
      value: node.note,
      x: pos.cx,
      y: pos.y + 65,
      maxChars: 22,
      maxLines: node.badge ? 1 : 2,
      lineHeight: 15,
      fill: "#94a3b8",
      fontSize: 12,
    }) : "";
    const badge = node.badge ? `<rect x="${pos.x + 12}" y="${pos.y + nodeHeight - 23}" width="${nodeWidth - 24}" height="19" rx="9.5" fill="${tone.stroke}" opacity="0.22"/>${renderWrappedSvgText({
      value: node.badge,
      x: pos.cx,
      y: pos.y + nodeHeight - 10,
      maxChars: 17,
      maxLines: 1,
      lineHeight: 12,
      fill: tone.text,
      fontSize: 11,
      fontWeight: 700,
    })}` : "";
    return `<rect x="${pos.x}" y="${pos.y}" width="${nodeWidth}" height="${nodeHeight}" rx="12" fill="${tone.fill}" stroke="${tone.stroke}" stroke-width="2"/>
      ${label}
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
  const diagrams = normalizeDiagramDefinitions(parsed.diagrams);
  const program = toRecord(parsed.program);
  return {
    program,
    programAssets: normalizePreTestAssets(program.pre_test_assets, diagrams),
    diagrams,
    steps: normalizeProcedureStepDefinitions(parsed.steps),
    procedures: normalizeProcedureDefinitions(parsed.procedures),
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
    stepResultsById: Object.fromEntries(
      Object.entries(toRecord(record.stepResultsById)).map(([stepId, result]) => {
        const stepResult = toRecord(result);
        const status = toStringValue(stepResult.status, "not-run");
        return [stepId, {
          status: status === "done" || status === "skipped" || status === "failed" || status === "blocked" ? status : "not-run",
          notes: toStringValue(stepResult.notes, ""),
          checkedAt: toStringValue(stepResult.checkedAt, "") || undefined,
          checkedBy: toStringValue(stepResult.checkedBy, "") || undefined,
        } satisfies StepResult];
      })
    ),
    typedArtifacts: Object.fromEntries(Object.entries(toRecord(record.typedArtifacts)).map(([key, artifacts]) => [key, Array.isArray(artifacts) ? artifacts as ArtifactRef[] : []])),
    supportingArtifacts: Array.isArray(record.supportingArtifacts) ? record.supportingArtifacts as ArtifactRef[] : [],
    startedAt: toStringValue(record.startedAt, "") || undefined,
    updatedAt: toStringValue(record.updatedAt, nowIso()),
    updatedBy: toStringValue(record.updatedBy, "") || undefined,
    inputFingerprint: toStringValue(record.inputFingerprint, "") || undefined,
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

function resolveProcedureSteps(definition: TestDefinition, value: unknown): { steps: ProcedureStep[]; issues: string[] } {
  const issues: string[] = [];
  const resolved: ProcedureStep[] = [];
  const seenProcedureIds = new Set<string>();

  const addStep = (step: ProcedureStep) => {
    const sameIdCount = resolved.filter((candidate) => candidate.id === step.id || candidate.id.startsWith(`${step.id}-`)).length;
    resolved.push(sameIdCount === 0 ? step : { ...step, id: `${step.id}-${sameIdCount + 1}` });
  };

  const resolveEntries = (entries: ProcedureEntry[], source: string) => {
    for (const entry of entries) {
      if (entry.step) {
        addStep(entry.step);
        continue;
      }
      if (!entry.ref) continue;

      const step = definition.steps[entry.ref];
      if (step) {
        addStep(step);
        continue;
      }

      const procedure = definition.procedures[entry.ref];
      if (procedure) {
        if (seenProcedureIds.has(procedure.id)) {
          issues.push(`${source} references procedure "${procedure.id}" recursively.`);
          continue;
        }
        seenProcedureIds.add(procedure.id);
        resolveEntries(procedure.steps, procedure.title);
        seenProcedureIds.delete(procedure.id);
        continue;
      }

      issues.push(`${source} references unknown step or procedure "${entry.ref}".`);
    }
  };

  resolveEntries(normalizeProcedureEntries(value), "Test procedure");
  return { steps: resolved, issues };
}

function buildResolvedTests(definition: TestDefinition): ResolvedTest[] {
  return definition.testGroups.flatMap((group) =>
    group.tests.map((test) => {
      const preTestGuidance = toStringValue(test.values.pre_test_guidance ?? group.values.pre_test_guidance, "") || undefined;
      const preTestAssets = normalizePreTestAssets(test.values.pre_test_assets ?? group.values.pre_test_assets, definition.diagrams);
      const equipmentRuntime = normalizeEquipmentRuntime(test.values.equipment_runtime ?? group.values.equipment_runtime);
      const procedure = resolveProcedureSteps(definition, test.values.test_steps ?? test.values.procedure ?? group.values.test_steps ?? group.values.procedure);
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
        procedureIssues: procedure.issues,
        procedureSteps: procedure.steps,
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

function computeTestInputFingerprint(test: ResolvedTest): string {
  const encoder = new TextEncoder();
  const content = JSON.stringify({
    id: test.id,
    title: test.title,
    testGroupId: test.testGroupId,
    testGroupTitle: test.testGroupTitle,
    steps: test.procedureSteps.map((step) => ({
      id: step.id,
      title: step.title,
      instruction: step.instruction,
      expected: step.expected ?? null,
      requiresEvidence: step.requiresEvidence,
      safetyCritical: step.safetyCritical,
    })),
    definedValues: Object.fromEntries(
      Object.entries(test.definedValues)
        .filter(([key]) => !FINGERPRINT_EXCLUDED_KEYS.has(key))
        .sort(([a], [b]) => a.localeCompare(b))
    ),
  });
  return crc32(encoder.encode(content)).toString(16).padStart(8, "0");
}

function getProgramDescription(definition: TestDefinition | null): string {
  return definition ? toStringValue(definition.program.description, "") : "";
}

function formatDate(value?: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 || unitIndex === 0 ? Math.round(size) : size.toFixed(1)} ${units[unitIndex]}`;
}

function getActiveRun(store: WorkspaceState): TestRun {
  return store.runs.find((run) => run.id === store.activeRunId) ?? store.runs[0]!;
}

function ensureResult(run: TestRun, test: ResolvedTest, userEmail?: string): ResultRecord {
  return run.resultsByTestId[test.id] ?? {
    status: "not-run",
    inputValues: Object.fromEntries(Object.entries(test.runtimeDefaults).map(([key, value]) => [key, value as Scalar])),
    notes: "",
    stepResultsById: {},
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

function DraftTextInput({
  value,
  onCommit,
  multiline = false,
  rows = 4,
  placeholder,
  type = "text",
  style,
}: {
  value: string;
  onCommit: (nextValue: string) => void;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  type?: "text" | "number";
  style?: React.CSSProperties;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = useCallback(() => {
    if (draft !== value) {
      onCommit(draft);
    }
  }, [draft, onCommit, value]);

  if (multiline) {
    return (
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        rows={rows}
        placeholder={placeholder}
        style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.5, ...style }}
      />
    );
  }

  return (
    <input
      type={type}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      placeholder={placeholder}
      style={{ ...inputStyle(), ...style }}
    />
  );
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

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function artifactArchivePath(testId: string, artifact: ArtifactRef, fieldId?: string | null): string {
  const area = fieldId ? `typed/${safeFileSegment(fieldId)}` : "supporting";
  return `evidence/${safeFileSegment(testId)}/${area}/${safeFileSegment(artifact.id)}-${safeFileSegment(artifact.name)}`;
}

function markdownArtifactLink(label: string, href: string): string {
  return `[${label}](${href})`;
}

function stepStatusLabel(result: StepResult | undefined): string {
  return humanize(result?.status ?? "not-run");
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
}

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function u16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function createZipBlob(files: Record<string, ZipFileContent>): Blob {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const stamp = dosDateTime();

  for (const [path, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(path.replace(/^\/+/, ""));
    const data = typeof content === "string" ? encoder.encode(content) : content;
    const crc = crc32(data);
    const localHeader = concatBytes([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(stamp.time), u16(stamp.date),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes,
    ]);
    localParts.push(localHeader, data);

    centralParts.push(concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(stamp.time), u16(stamp.date),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBytes,
    ]));
    offset += localHeader.length + data.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const end = concatBytes([
    u32(0x06054b50), u16(0), u16(0), u16(centralParts.length), u16(centralParts.length),
    u32(centralDirectory.length), u32(offset), u16(0),
  ]);

  const bytes = concatBytes([...localParts, centralDirectory, end]);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: "application/zip" });
}

function generateReportPages(
  definition: TestDefinition,
  run: TestRun,
  tests: ResolvedTest[],
  options: ReportGenerationOptions = {},
): ReportPages {
  const title = getProgramTitle(definition, { id: "", app: { bucket: "" } } as ModuleProps["config"]);
  const summary: string[] = [];
  const details: Record<string, string> = {};
  const assets: Record<string, { content: string; contentType: string }> = {};
  const detailHref = options.detailHref ?? ((test: ResolvedTest) => `tests/${safeFileSegment(test.id)}.md`);
  const artifactHref = options.artifactHref ?? ((context: ReportArtifactContext) => `s3://${context.artifact.bucket}/${context.artifact.key}`);
  const backToSummaryHref = options.backToSummaryHref ?? "../report.md";

  summary.push(`# ${title} Report`);
  summary.push("");
  summary.push("## Report Summary");
  summary.push("");
  summary.push(`- Program: ${escapeMarkdownCell(title)}`);
  summary.push(`- Run: ${escapeMarkdownCell(run.label)}`);
  summary.push(`- Generated On: ${escapeMarkdownCell(formatDate(nowIso()))}`);
  summary.push(`- Tests in Scope: ${tests.length}`);
  if (options.notes?.length) {
    for (const note of options.notes) {
      summary.push(`- Note: ${escapeMarkdownCell(note)}`);
    }
  }
  summary.push("");
  if (definition.programAssets.length > 0) {
    summary.push("## Program Overview");
    summary.push("");
    for (const [index, asset] of definition.programAssets.entries()) {
      if (asset.type === "image_url") {
        summary.push(`![${escapeMarkdownCell(asset.label)}](${asset.content})`);
      } else {
        const assetPath = `assets/program-${String(index + 1)}-${safeFileSegment(asset.id)}.svg`;
        assets[assetPath] = { content: asset.content, contentType: "image/svg+xml" };
        summary.push(`![${escapeMarkdownCell(asset.label)}](${assetPath})`);
      }
      summary.push("");
    }
  }
  summary.push("## Results Summary");
  summary.push("");
  summary.push("| Test ID | Test Group | Status | Failure Mode | Target Module | Detail |");
  summary.push("|---|---|---|---|---|---|");

  for (const test of tests) {
    const result = ensureResult(run, test);
    summary.push(`| ${escapeMarkdownCell(test.id)} | ${escapeMarkdownCell(test.testGroupId)} | ${escapeMarkdownCell(result.status)} | ${escapeMarkdownCell(valueDisplay(test.definedValues.failure_mode))} | ${escapeMarkdownCell(valueDisplay(test.definedValues.target_module))} | [View](${detailHref(test)}) |`);

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
      detail.push("## Diagrams and Pre-Test Assets");
      detail.push("");
      for (const asset of test.preTestAssets) {
        if (asset.type === "image_url") {
          detail.push(`![${escapeMarkdownCell(asset.label)}](${asset.content})`);
        } else {
          const assetPath = `assets/${safeFileSegment(test.id)}-${safeFileSegment(asset.id)}.svg`;
          assets[assetPath] = { content: asset.content, contentType: "image/svg+xml" };
          detail.push(`![${escapeMarkdownCell(asset.label)}](../${assetPath})`);
        }
        detail.push("");
      }
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
    if (test.procedureSteps.length > 0) {
      detail.push("## Procedure");
      detail.push("");
      detail.push("| Step | Instruction | Expected | Status | Notes |");
      detail.push("|---|---|---|---|---|");
      for (const [index, step] of test.procedureSteps.entries()) {
        const stepResult = result.stepResultsById[step.id];
        detail.push(`| ${index + 1}. ${escapeMarkdownCell(step.title)} | ${escapeMarkdownCell(step.instruction)} | ${escapeMarkdownCell(valueDisplay(step.expected))} | ${escapeMarkdownCell(stepStatusLabel(stepResult))} | ${escapeMarkdownCell(stepResult?.notes ?? "")} |`);
      }
      detail.push("");
    }
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
        for (const artifact of artifacts) {
          detail.push(`- ${markdownArtifactLink(artifact.name, artifactHref({ test, fieldId, artifact }))}`);
        }
        detail.push("");
      }
    }
    if (result.supportingArtifacts.length > 0) {
      detail.push("## Supporting Files");
      detail.push("");
      for (const artifact of result.supportingArtifacts) {
        detail.push(`- ${markdownArtifactLink(artifact.name, artifactHref({ test, fieldId: null, artifact }))}`);
      }
      detail.push("");
    }
    detail.push("## Navigation");
    detail.push("");
    detail.push(`- [Back to Report Summary](${backToSummaryHref})`);
    detail.push("");
    details[test.id] = detail.join("\n");
  }

  return { summary: summary.join("\n"), details, assets };
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
        <DraftTextInput
          value={value == null ? "" : String(value)}
          onCommit={(nextValue) => onChange(nextValue)}
          multiline
          rows={4}
        />
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
      <DraftTextInput
        type={type.includes("number") ? "number" : "text"}
        value={value == null ? "" : String(value)}
        onCommit={(nextValue) => onChange(type.includes("number") ? (nextValue === "" ? null : Number(nextValue)) : nextValue)}
      />
    </label>
  );
}

function ArtifactField({
  field,
  artifacts,
  supporting = false,
  onUpload,
  onDelete,
}: {
  field: FieldDefinition;
  artifacts: ArtifactRef[];
  supporting?: boolean;
  onUpload: (files: File[]) => boolean | Promise<boolean>;
  onDelete: (artifact: ArtifactRef) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const accept = artifactAccept(field);
  const queueFiles = useCallback((files: FileList | null) => {
    if (!files?.length) return;
    setPendingFiles((current) => [...current, ...Array.from(files)]);
  }, []);

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
          queueFiles(event.dataTransfer.files);
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
          {supporting ? "Review files before uploading; accepted files are stored for this test and linked from the detail page." : "Review files before uploading; accepted files are stored as a list for this input."}
        </div>
        <input
          ref={inputRef}
          type="file"
          hidden
          multiple
          accept={accept}
          onChange={(event) => {
            queueFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>
      {pendingFiles.length > 0 ? (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.panel2, padding: "0.75rem", display: "grid", gap: "0.55rem" }}>
          <div style={{ color: C.text, fontSize: "0.86rem", fontWeight: 700 }}>Review {pendingFiles.length} file{pendingFiles.length === 1 ? "" : "s"} before upload</div>
          <div style={{ display: "grid", gap: "0.35rem" }}>
            {pendingFiles.map((file, index) => (
              <div key={`${file.name}-${file.size}-${file.lastModified}-${index}`} style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", color: C.muted, fontSize: "0.8rem" }}>
                <span style={{ color: C.text, overflowWrap: "anywhere" }}>{file.name}</span>
                <span style={{ flexShrink: 0 }}>{formatBytes(file.size)}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  const uploaded = await onUpload(pendingFiles);
                  if (uploaded !== false) setPendingFiles([]);
                })();
              }}
              style={buttonStyle("primary")}
            >
              Upload
            </button>
            <button type="button" onClick={() => setPendingFiles([])} style={buttonStyle("ghost")}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {artifacts.length === 0 ? (
        <div style={{ color: C.muted, fontSize: "0.82rem" }}>No files uploaded yet.</div>
      ) : (
        <div style={{ display: "grid", gap: "0.45rem" }}>
          {artifacts.map((artifact) => (
            <div key={artifact.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.panel2, padding: "0.65rem 0.75rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: C.text, fontSize: "0.86rem", fontWeight: 600, overflowWrap: "anywhere" }}>{artifact.name}</div>
                  <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.78rem" }}>{artifact.contentType || "file"} · {formatBytes(artifact.sizeBytes)} · {formatDate(artifact.uploadedAt)}</div>
                </div>
                <button type="button" onClick={() => onDelete(artifact)} style={{ ...buttonStyle("danger"), padding: "0.35rem 0.55rem", flexShrink: 0 }}>
                  Delete
                </button>
              </div>
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

function reportAnchorForLink(href: string | undefined): string | undefined {
  if (!href) return href;
  if (href === "report.md" || href === "./report.md" || href === "../report.md") return "#report-summary";

  const match = href.match(/(?:^|\/)tests\/([^/#?]+)\.md(?:[?#].*)?$/);
  if (match) return `#test-${safeFileSegment(decodeURIComponent(match[1]))}`;

  return href;
}

function PrintMarkdownBlock({ value, assets }: { value: string; assets: ReportPages["assets"] }) {
  const assetUrls = useMemo(() => {
    const urls = new Map<string, string>();
    for (const [path, asset] of Object.entries(assets)) {
      const encoded = btoa(unescape(encodeURIComponent(asset.content)));
      urls.set(`../${path}`, `data:${asset.contentType};base64,${encoded}`);
      urls.set(path, `data:${asset.contentType};base64,${encoded}`);
    }
    return urls;
  }, [assets]);

  return (
    <div style={{ color: "#111827", lineHeight: 1.68, fontSize: "1.06rem" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 style={{ margin: "0 0 0.75rem", fontSize: "1.9rem", color: "#0f172a" }}>{children}</h1>,
          h2: ({ children }) => <h2 style={{ margin: "1.15rem 0 0.6rem", fontSize: "1.45rem", color: "#0f172a" }}>{children}</h2>,
          h3: ({ children }) => <h3 style={{ margin: "0.9rem 0 0.45rem", fontSize: "1.18rem", color: "#0f172a" }}>{children}</h3>,
          p: ({ children }) => <p style={{ margin: "0.45rem 0", color: "#111827" }}>{children}</p>,
          ul: ({ children }) => <ul style={{ margin: "0.45rem 0", paddingLeft: "1.2rem", color: "#111827" }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: "0.45rem 0", paddingLeft: "1.2rem", color: "#111827" }}>{children}</ol>,
          li: ({ children }) => <li style={{ margin: "0.2rem 0", color: "#111827" }}>{children}</li>,
          code: ({ children }) => <code style={{ background: "#f1f5f9", color: "#0f172a", padding: "0.1rem 0.25rem", borderRadius: 4, fontSize: "0.98em" }}>{children}</code>,
          pre: ({ children }) => <pre style={{ background: "#f8fafc", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 8, padding: "0.95rem 1rem", overflowX: "auto", fontSize: "0.98rem", lineHeight: 1.6 }}>{children}</pre>,
          img: ({ src, alt }) => <img src={assetUrls.get(src ?? "") ?? src ?? ""} alt={alt ?? ""} style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid #cbd5e1", background: "#f8fafc", padding: "0.35rem" }} />,
          table: ({ children }) => <table style={{ width: "100%", borderCollapse: "collapse", margin: "0.7rem 0", color: "#111827" }}>{children}</table>,
          th: ({ children }) => <th style={{ textAlign: "left", borderBottom: "1px solid #94a3b8", padding: "0.55rem 0.6rem", color: "#0f172a", fontSize: "0.98rem" }}>{children}</th>,
          td: ({ children }) => <td style={{ borderBottom: "1px solid #cbd5e1", padding: "0.55rem 0.6rem", verticalAlign: "top", color: "#111827", fontSize: "0.98rem" }}>{children}</td>,
          a: ({ href, children }) => <a href={reportAnchorForLink(href)} style={{ color: "#0f766e" }}>{children}</a>,
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

export default function TestManager(props: ModuleProps) {
  return (
    <TestManagerBoundary>
      <TestManagerInner {...props} />
    </TestManagerBoundary>
  );
}

function TestManagerInner({ config }: ModuleProps) {
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
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [printReportOpen, setPrintReportOpen] = useState(false);
  const [reportArtifactLinks, setReportArtifactLinks] = useState<Record<string, string>>({});

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
  const activeExcludedIds = useMemo(() => new Set(activeRun?.excludedTestIds ?? []), [activeRun]);
  const includedTests = useMemo(() => resolvedTests.filter((test) => !activeExcludedIds.has(test.id)), [resolvedTests, activeExcludedIds]);
  const staleTestIds = useMemo(() => {
    const stale = new Set<string>();
    if (!activeRun) return stale;
    for (const test of resolvedTests) {
      const result = activeRun.resultsByTestId[test.id];
      if (!result?.inputFingerprint || !TERMINAL_STATUSES.has(result.status)) continue;
      if (result.inputFingerprint !== computeTestInputFingerprint(test)) stale.add(test.id);
    }
    return stale;
  }, [activeRun, resolvedTests]);

  const createRun = useCallback(() => {
    if (!workspace) return;
    const nextRun = createDefaultRun(user?.email, `Run ${workspace.runs.length + 1}`);
    const snapshotYaml = definition?.sourceText;
    updateWorkspace((current) => ({
      ...current,
      activeRunId: nextRun.id,
      runs: [
        nextRun,
        ...current.runs.map((run) =>
          run.id === current.activeRunId && !run.definitionSnapshot
            ? { ...run, definitionSnapshot: snapshotYaml }
            : run
        ),
      ],
    }), "New run created");
  }, [definition, updateWorkspace, user?.email, workspace]);

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

  const toggleTestExclusion = useCallback((testId: string) => {
    if (!workspace || !activeRun) return;
    updateWorkspace((current) => {
      const run = current.runs.find((r) => r.id === current.activeRunId);
      if (!run) return current;
      const excluded = new Set(run.excludedTestIds ?? []);
      const wasExcluded = excluded.has(testId);
      if (wasExcluded) excluded.delete(testId);
      else excluded.add(testId);
      const reasons = { ...(run.excludedTestReasons ?? {}) };
      if (wasExcluded) delete reasons[testId];
      return {
        ...current,
        runs: current.runs.map((r) => r.id !== run.id ? r : { ...r, excludedTestIds: [...excluded], excludedTestReasons: reasons, updatedAt: nowIso() }),
      };
    }, "Run scope updated");
  }, [activeRun, updateWorkspace, workspace]);

  const setExclusionReason = useCallback((testId: string, reason: string) => {
    if (!workspace || !activeRun) return;
    updateWorkspace((current) => {
      const run = current.runs.find((r) => r.id === current.activeRunId);
      if (!run) return current;
      return {
        ...current,
        runs: current.runs.map((r) => r.id !== run.id ? r : {
          ...r,
          excludedTestReasons: { ...(r.excludedTestReasons ?? {}), [testId]: reason },
          updatedAt: nowIso(),
        }),
      };
    }, "Exclusion reason updated");
  }, [activeRun, updateWorkspace, workspace]);

  const uploadArtifacts = useCallback(async (files: File[], testId: string, fieldId: string | null): Promise<boolean> => {
    if (!files.length || !activeRun) return false;
    const test = testsById.get(testId);
    if (!test) return false;
    setSaving(true);
    setError("");
    try {
      const s3 = await getS3Client(storage.bucket);
      const uploaded: ArtifactRef[] = [];
      for (const file of files) {
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
      return true;
    } catch (uploadError: unknown) {
      setError((uploadError as Error).message);
      setSaving(false);
      return false;
    }
  }, [activeRun, getS3Client, storage, testsById, updateWorkspace, user?.email]);

  const deleteArtifact = useCallback(async (testId: string, fieldId: string | null, artifact: ArtifactRef) => {
    if (!activeRun) return;
    const test = testsById.get(testId);
    if (!test) return;
    const confirmed = window.confirm(
      `Delete "${artifact.name}" from this test and permanently remove it from S3?\n\nThis cannot be undone.`
    );
    if (!confirmed) return;

    setSaving(true);
    setError("");
    try {
      const s3 = await getS3Client(artifact.bucket);
      await s3.send(new DeleteObjectCommand({
        Bucket: artifact.bucket,
        Key: artifact.key,
      }));

      updateWorkspace((currentWorkspace) => ({
        ...currentWorkspace,
        runs: currentWorkspace.runs.map((run) => {
          if (run.id !== activeRun.id) return run;
          const currentResult = ensureResult(run, test, user?.email);
          const typedArtifacts = { ...currentResult.typedArtifacts };
          let supportingArtifacts = currentResult.supportingArtifacts;
          if (fieldId) {
            typedArtifacts[fieldId] = (typedArtifacts[fieldId] ?? []).filter((candidate) => candidate.id !== artifact.id);
            if (typedArtifacts[fieldId].length === 0) delete typedArtifacts[fieldId];
          } else {
            supportingArtifacts = supportingArtifacts.filter((candidate) => candidate.id !== artifact.id);
          }
          return {
            ...run,
            updatedAt: nowIso(),
            resultsByTestId: {
              ...run.resultsByTestId,
              [testId]: {
                ...currentResult,
                typedArtifacts,
                supportingArtifacts,
                updatedAt: nowIso(),
                updatedBy: user?.email,
                startedAt: currentResult.startedAt ?? nowIso(),
              },
            },
          };
        }),
      }), "Artifact deleted from test and S3");
    } catch (deleteError: unknown) {
      setError((deleteError as Error).message);
      setSaving(false);
    }
  }, [activeRun, getS3Client, testsById, updateWorkspace, user?.email]);

  const validationIssues = useMemo(() => {
    if (!definition || !activeRun) return [];
    return includedTests.flatMap((test) => {
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
        ...test.procedureIssues.map((issue) => `${test.id}: ${issue}`),
        ...runtimeIssues,
      ];
    });
  }, [activeRun, definition, includedTests, user?.email]);

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const status of STATUS_OPTIONS) counts.set(status, 0);
    if (!activeRun) return counts;
    for (const test of includedTests) {
      const status = ensureResult(activeRun, test, user?.email).status;
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return counts;
  }, [activeRun, includedTests, user?.email]);

  const completion = useMemo(() => {
    if (!activeRun || includedTests.length === 0) return 0;
    const doneCount = includedTests.filter((test) => {
      const status = ensureResult(activeRun, test, user?.email).status;
      return status === "pass" || status === "fail" || status === "blocked";
    }).length;
    return Math.round((doneCount / includedTests.length) * 100);
  }, [activeRun, includedTests, user?.email]);

  const reportArtifacts = useMemo(() => {
    if (!activeRun) return [] as ArtifactRef[];
    const deduped = new Map<string, ArtifactRef>();
    for (const test of includedTests) {
      const result = ensureResult(activeRun, test, user?.email);
      for (const artifacts of Object.values(result.typedArtifacts)) {
        for (const artifact of artifacts) deduped.set(artifact.id, artifact);
      }
      for (const artifact of result.supportingArtifacts) deduped.set(artifact.id, artifact);
    }
    return [...deduped.values()];
  }, [activeRun, includedTests, user?.email]);

  useEffect(() => {
    let cancelled = false;
    if (reportArtifacts.length === 0) {
      setReportArtifactLinks({});
      return;
    }

    void (async () => {
      try {
        const s3 = await getS3Client(storage.bucket);
        const entries = await Promise.all(reportArtifacts.map(async (artifact) => {
          const href = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: artifact.bucket, Key: artifact.key }),
            { expiresIn: 60 * 60 * 24 * 7 },
          );
          return [artifact.id, href] as const;
        }));
        if (!cancelled) setReportArtifactLinks(Object.fromEntries(entries));
      } catch {
        if (!cancelled) setReportArtifactLinks({});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [getS3Client, reportArtifacts, storage.bucket]);

  const reportPages = useMemo(() => {
    if (!definition || !activeRun) return null;
    return generateReportPages(definition, activeRun, includedTests, {
      artifactHref: ({ artifact }) => reportArtifactLinks[artifact.id] ?? `s3://${artifact.bucket}/${artifact.key}`,
      notes: reportArtifacts.length > 0
        ? ["Evidence links in the live report and PDF are time-limited access URLs and may expire after about 7 days."]
        : undefined,
    });
  }, [activeRun, definition, includedTests, reportArtifactLinks, reportArtifacts.length]);

  const buildReportFiles = useCallback(async (): Promise<Record<string, ZipFileContent> | null> => {
    if (!definition || !activeRun) return null;
    const zipPages = generateReportPages(definition, activeRun, includedTests, {
      artifactHref: ({ test, fieldId, artifact }) => `../${artifactArchivePath(test.id, artifact, fieldId)}`,
    });
    const files: Record<string, ZipFileContent> = {
      "report.md": zipPages.summary,
      ...Object.fromEntries(Object.entries(zipPages.details).map(([testId, content]) => [`tests/${safeFileSegment(testId)}.md`, content])),
      ...Object.fromEntries(Object.entries(zipPages.assets).map(([path, asset]) => [path, asset.content])),
      "definition.yaml": activeRun.definitionSnapshot ?? definition.sourceText,
      "workspace.json": JSON.stringify(workspace, null, 2),
    };

    const manifest: Array<Record<string, string | number | null>> = [];
    const s3 = await getS3Client(storage.bucket);
    for (const test of includedTests) {
      const result = ensureResult(activeRun, test, user?.email);
      for (const [fieldId, artifacts] of Object.entries(result.typedArtifacts)) {
        for (const artifact of artifacts) {
          const archivePath = artifactArchivePath(test.id, artifact, fieldId);
          const bytes = await readOptionalBytes(s3, artifact.bucket, artifact.key);
          if (bytes) files[archivePath] = bytes;
          manifest.push({
            testId: test.id,
            fieldId,
            kind: artifact.kind,
            name: artifact.name,
            archivePath,
            bucket: artifact.bucket,
            key: artifact.key,
            contentType: artifact.contentType ?? null,
            sizeBytes: artifact.sizeBytes,
          });
        }
      }
      for (const artifact of result.supportingArtifacts) {
        const archivePath = artifactArchivePath(test.id, artifact, null);
        const bytes = await readOptionalBytes(s3, artifact.bucket, artifact.key);
        if (bytes) files[archivePath] = bytes;
        manifest.push({
          testId: test.id,
          fieldId: null,
          kind: artifact.kind,
          name: artifact.name,
          archivePath,
          bucket: artifact.bucket,
          key: artifact.key,
          contentType: artifact.contentType ?? null,
          sizeBytes: artifact.sizeBytes,
        });
      }
    }

    files["evidence/manifest.json"] = JSON.stringify(manifest, null, 2);
    return files;
  }, [activeRun, definition, getS3Client, includedTests, storage.bucket, user?.email, workspace]);

  const downloadReportZip = useCallback(() => {
    void (async () => {
      const files = await buildReportFiles();
      if (!files) return;
      downloadBlob(`test-report-${safeFileSegment(storage.projectId)}.zip`, createZipBlob(files));
      setReportDialogOpen(false);
    })();
  }, [buildReportFiles, storage.projectId]);

  const openReportPdf = useCallback(() => {
    if (!definition || !reportPages || !activeRun) return;
    setReportDialogOpen(false);
    setPrintReportOpen(true);
  }, [activeRun, config, definition, reportPages]);

  if (loading || !workspace) {
    return <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, color: C.muted }}>Loading test manager...</div>;
  }

  return (
    <div style={{ height: "100%", minHeight: 0, display: "grid", gridTemplateRows: "auto auto auto 1fr", background: C.bg, color: C.text, fontFamily: "\"Segoe UI\", \"Aptos\", sans-serif" }}>
      <style>{`
        @media print {
          @page {
            size: auto;
            margin: 0.45in;
          }
          body * { visibility: hidden !important; }
          .test-manager-print-root, .test-manager-print-root * { visibility: visible !important; }
          .test-manager-print-root { position: absolute !important; inset: 0 !important; width: auto !important; height: auto !important; overflow: visible !important; background: white !important; color: #111827 !important; padding: 0 !important; margin: 0 !important; }
          .test-manager-print-root * { color-adjust: exact !important; print-color-adjust: exact !important; -webkit-print-color-adjust: exact !important; }
          .test-manager-print-actions { display: none !important; }
          .test-manager-print-page { break-before: page; }
          .test-manager-print-root pre { white-space: pre-wrap !important; }
          .test-manager-print-article {
            max-width: none !important;
            width: 100% !important;
            margin: 0 !important;
            border: none !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            padding: 0 !important;
            background: white !important;
          }
        }
      `}</style>
      <header style={{ padding: "1rem 1.1rem", borderBottom: `1px solid ${C.border}`, background: C.header, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 420px" }}>
          <div style={{ fontSize: "0.72rem", color: C.accent, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>Test Manager</div>
          <h2 style={{ margin: "0.2rem 0 0", fontSize: "1.35rem" }}>{getProgramTitle(definition, config)}</h2>
          <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.82rem" }}>
            {definition ? `${resolvedTests.length} tests across ${definition.testGroups.length} groups` : "No test definition uploaded yet"} · {storage.projectId}
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.55rem", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", flex: "0 1 auto", paddingTop: "0.1rem" }}>
          <button onClick={() => importRef.current?.click()} style={buttonStyle("primary")}>Upload YAML</button>
          <button onClick={() => definition && downloadText(`test-definition-${storage.projectId}.yaml`, definition.sourceText, "text/yaml;charset=utf-8")} style={buttonStyle()} disabled={!definition}>Download YAML</button>
          <button onClick={() => setReportDialogOpen(true)} style={buttonStyle()} disabled={!reportPages}>Generate Report</button>
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
        {(["overview", "run", "report"] as AppSection[]).map((candidate) => (
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
        <label style={{ ...labelStyle(), minWidth: 180 }}>
          Run Label
          <DraftTextInput
            value={activeRun?.label ?? ""}
            onCommit={(nextValue) => updateWorkspace((current) => ({
              ...current,
              runs: current.runs.map((run) => run.id === activeRun?.id ? { ...run, label: nextValue, updatedAt: nowIso() } : run),
            }), "Run renamed")}
          />
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

      <main style={{ minHeight: 0, display: "grid", gridTemplateColumns: section === "run" ? "360px 1fr" : "1fr", gap: "1px", background: C.border, overflow: "hidden" }}>
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
                      const isExcluded = activeExcludedIds.has(test.id);
                      return (
                        <div
                          key={test.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => setSelectedTestId(test.id)}
                          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedTestId(test.id); }}
                          style={{
                            width: "100%",
                            textAlign: "left",
                            border: `1px solid ${selectedTestId === test.id ? C.accent : C.border}`,
                            background: selectedTestId === test.id ? C.accentSoft : "transparent",
                            color: isExcluded ? C.muted : C.text,
                            opacity: isExcluded ? 0.55 : 1,
                            padding: "0.75rem",
                            borderRadius: 10,
                            cursor: "pointer",
                            fontFamily: "inherit",
                            marginLeft: "0.4rem",
                            boxSizing: "border-box",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
                            <strong style={{ fontSize: "0.88rem", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{test.title}</strong>
                            <div style={{ display: "flex", gap: "0.3rem", alignItems: "center", flexShrink: 0 }}>
                              {isExcluded ? (
                                <span style={{ border: `1px solid ${C.idle}`, color: C.idle, borderRadius: 999, padding: "0.15rem 0.45rem", fontSize: "0.68rem", fontWeight: 700, whiteSpace: "nowrap" }}>excluded</span>
                              ) : (
                                <span style={{ border: `1px solid ${statusTone(result.status)}`, color: statusTone(result.status), borderRadius: 999, padding: "0.15rem 0.45rem", fontSize: "0.68rem", fontWeight: 700, whiteSpace: "nowrap" }}>{humanize(result.status)}</span>
                              )}
                              {!isExcluded && staleTestIds.has(test.id) ? (
                                <span title="Spec changed since completion" style={{ color: C.warning, fontSize: "0.75rem", fontWeight: 800, lineHeight: 1, flexShrink: 0 }}>⚠</span>
                              ) : null}
                            </div>
                          </div>
                          <div style={{ marginTop: "0.3rem", color: C.muted, fontSize: "0.76rem" }}>{test.id}</div>
                          {invalid && !isExcluded ? <div style={{ marginTop: "0.25rem", color: C.warning, fontSize: "0.72rem" }}>Definition needs attention</div> : null}
                        </div>
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
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem" }}>
                        <div>
                          <div style={{ color: C.accent, fontSize: "0.72rem", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>{selectedTest.testGroupTitle}</div>
                          <h3 style={{ margin: "0.2rem 0 0", fontSize: "1.25rem" }}>{selectedTest.title}</h3>
                          <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.82rem" }}>{selectedTest.id}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => toggleTestExclusion(selectedTest.id)}
                          style={{ border: `1px solid ${activeExcludedIds.has(selectedTest.id) ? C.accent : C.idle}`, borderRadius: 8, background: "transparent", color: activeExcludedIds.has(selectedTest.id) ? C.accent : C.idle, cursor: "pointer", padding: "0.4rem 0.9rem", fontSize: "0.8rem", fontWeight: 700, fontFamily: "inherit", lineHeight: 1.4, whiteSpace: "nowrap", flexShrink: 0 }}
                        >
                          {activeExcludedIds.has(selectedTest.id) ? "Add to run" : "Remove from run"}
                        </button>
                      </div>
                      {activeExcludedIds.has(selectedTest.id) && (
                        <div style={{ display: "flex", alignItems: "center", gap: "0.65rem", marginTop: "0.75rem", paddingTop: "0.65rem", borderTop: `1px solid ${C.border}` }}>
                          <span style={{ fontSize: "0.7rem", color: C.idle, whiteSpace: "nowrap", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>Exclusion reason</span>
                          <DraftTextInput
                            value={activeRun?.excludedTestReasons?.[selectedTest.id] ?? ""}
                            onCommit={(nextValue) => setExclusionReason(selectedTest.id, nextValue)}
                            placeholder="Why is this test excluded from this run?"
                            style={{ flex: 1, background: "rgba(255,255,255,0.04)", fontSize: "0.82rem", padding: "0.32rem 0.6rem", outline: "none" }}
                          />
                        </div>
                      )}
                    </div>
                    <div style={{ padding: "1rem 1.1rem", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.85rem" }}>
                      <label style={labelStyle()}>
                        Execution Status
                        <select value={selectedResult.status} onChange={(event) => {
                          const newStatus = event.target.value;
                          updateSelectedResult((current) => ({
                            ...current,
                            status: newStatus,
                            inputValues: { ...current.inputValues, status: newStatus },
                            inputFingerprint: TERMINAL_STATUSES.has(newStatus) && selectedTest
                              ? computeTestInputFingerprint(selectedTest)
                              : undefined,
                          }));
                        }} style={inputStyle()}>
                          {STATUS_OPTIONS.map((status) => <option key={status} value={status}>{humanize(status)}</option>)}
                        </select>
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

                  {staleTestIds.has(selectedTest.id) ? (
                    <section style={{ border: `1px solid ${C.warning}`, borderRadius: 14, background: "rgba(251,191,36,0.06)", padding: "0.95rem 1rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                        <div>
                          <div style={{ fontWeight: 700, color: C.warning }}>⚠ Spec Changed Since Completion</div>
                          <div style={{ marginTop: "0.3rem", color: C.text, fontSize: "0.88rem", lineHeight: 1.55 }}>
                            The test definition was updated after this result was recorded. Review the changes and retest, or confirm the result is still valid.
                          </div>
                        </div>
                        <button
                          style={buttonStyle()}
                          onClick={() => selectedTest && updateSelectedResult((current) => ({ ...current, inputFingerprint: computeTestInputFingerprint(selectedTest) }))}
                        >
                          Mark Still Valid
                        </button>
                      </div>
                    </section>
                  ) : null}

                  {(selectedTest.preTestGuidance || selectedTest.preTestAssets.length > 0) ? (
                    <section style={cardStyle()}>
                      <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Pre-Test Guidance</div>
                      <div style={{ marginTop: "0.85rem" }}>
                        {selectedTest.preTestGuidance ? <MarkdownBlock value={selectedTest.preTestGuidance} /> : null}
                        {selectedTest.preTestAssets.length > 0 ? <div style={{ marginTop: selectedTest.preTestGuidance ? "1rem" : 0 }}><PreTestAssetGallery assets={selectedTest.preTestAssets} /></div> : null}
                      </div>
                    </section>
                  ) : null}

                  {(selectedTest.fieldIssues.length > 0 || selectedTest.linkedValueIssues.length > 0 || selectedTest.procedureIssues.length > 0) && (
                    <section style={{ border: `1px solid ${C.warning}`, borderRadius: 14, background: "rgba(251,191,36,0.08)", padding: "0.95rem 1rem" }}>
                      <div style={{ fontWeight: 700, color: C.warning, marginBottom: "0.45rem" }}>Definition Issues</div>
                      {[...selectedTest.fieldIssues, ...selectedTest.linkedValueIssues, ...selectedTest.procedureIssues].map((issue) => (
                        <div key={issue} style={{ color: C.text, fontSize: "0.88rem", lineHeight: 1.6 }}>{issue}</div>
                      ))}
                    </section>
                  )}

                  <section style={cardStyle()}>
                    <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Test Definitions</div>
                    <div style={{ marginTop: "0.85rem", display: "grid", gap: "0.45rem" }}>
                      {definition.testDefinedFields.filter((field) => !["pre_test_guidance", "pre_test_assets", "equipment_runtime", "procedure", "test_steps"].includes(field.id)).map((field) => {
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

                  {selectedTest.procedureSteps.length > 0 ? (
                    <section style={cardStyle()}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                        <div>
                          <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Procedure</div>
                          <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.82rem" }}>Step through the defined test procedure before recording runtime inputs.</div>
                        </div>
                        <div style={{ color: C.muted, fontSize: "0.82rem" }}>
                          {selectedTest.procedureSteps.filter((step) => selectedResult.stepResultsById[step.id]?.status === "done").length} / {selectedTest.procedureSteps.length} done
                        </div>
                      </div>
                      <div style={{ marginTop: "0.9rem", display: "grid", gap: "0.7rem" }}>
                        {selectedTest.procedureSteps.map((step, index) => {
                          const stepResult = selectedResult.stepResultsById[step.id] ?? { status: "not-run", notes: "" };
                          return (
                            <div key={step.id} style={{ border: `1px solid ${stepResult.status === "done" ? C.ok : step.safetyCritical ? C.warning : C.border}`, borderRadius: 12, background: C.panel2, padding: "0.85rem" }}>
                              <div style={{ display: "flex", gap: "0.8rem", alignItems: "flex-start" }}>
                                <input
                                  type="checkbox"
                                  checked={stepResult.status === "done"}
                                  onChange={(event) => updateSelectedResult((current) => ({
                                    ...current,
                                    stepResultsById: {
                                      ...current.stepResultsById,
                                      [step.id]: {
                                        ...stepResult,
                                        status: event.target.checked ? "done" : "not-run",
                                        checkedAt: event.target.checked ? nowIso() : undefined,
                                        checkedBy: event.target.checked ? user?.email : undefined,
                                      },
                                    },
                                  }))}
                                  style={{ marginTop: 4 }}
                                />
                                <div style={{ minWidth: 0, flex: 1 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                                    <strong>{index + 1}. {step.title}</strong>
                                    {step.requiresEvidence ? <span style={{ color: C.accent, fontSize: "0.75rem", fontWeight: 700 }}>evidence</span> : null}
                                    {step.safetyCritical ? <span style={{ color: C.warning, fontSize: "0.75rem", fontWeight: 700 }}>safety</span> : null}
                                  </div>
                                  <div style={{ marginTop: "0.4rem", color: C.text, lineHeight: 1.55 }}>{step.instruction}</div>
                                  {step.expected ? <div style={{ marginTop: "0.35rem", color: C.muted, fontSize: "0.84rem", lineHeight: 1.45 }}>Expected: {step.expected}</div> : null}
                                  <div style={{ marginTop: "0.65rem", display: "grid", gridTemplateColumns: "minmax(130px, 180px) 1fr", gap: "0.6rem" }}>
                                    <select
                                      value={stepResult.status}
                                      onChange={(event) => updateSelectedResult((current) => ({
                                        ...current,
                                        stepResultsById: {
                                          ...current.stepResultsById,
                                          [step.id]: {
                                            ...stepResult,
                                            status: event.target.value as StepResult["status"],
                                            checkedAt: event.target.value === "not-run" ? undefined : nowIso(),
                                            checkedBy: event.target.value === "not-run" ? undefined : user?.email,
                                          },
                                        },
                                      }))}
                                      style={inputStyle()}
                                    >
                                      <option value="not-run">Not Run</option>
                                      <option value="done">Done</option>
                                      <option value="skipped">Skipped</option>
                                      <option value="failed">Failed</option>
                                      <option value="blocked">Blocked</option>
                                    </select>
                                    <DraftTextInput
                                      value={stepResult.notes}
                                      onCommit={(nextValue) => updateSelectedResult((current) => ({
                                        ...current,
                                        stepResultsById: {
                                          ...current.stepResultsById,
                                          [step.id]: {
                                            ...stepResult,
                                            notes: nextValue,
                                          },
                                        },
                                      }))}
                                      placeholder="Step notes"
                                    />
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  ) : null}

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
                          <ArtifactField
                            key={field.id}
                            field={field}
                            artifacts={selectedResult.typedArtifacts[field.id] ?? []}
                            onUpload={(files) => uploadArtifacts(files, selectedTest.id, field.id)}
                            onDelete={(artifact) => void deleteArtifact(selectedTest.id, field.id, artifact)}
                          />
                        ))}
                      </div>
                    </div>
                    <div style={{ marginTop: "1rem" }}>
                      <label style={labelStyle()}>
                        {operatorNotesField?.label ?? "Operator Notes"}
                        <DraftTextInput
                          value={selectedResult.notes}
                          onCommit={(nextValue) => updateSelectedResult((current) => ({ ...current, notes: nextValue }))}
                          multiline
                          rows={6}
                          style={{ lineHeight: 1.55 }}
                        />
                      </label>
                    </div>
                    <div style={{ marginTop: "1rem" }}>
                      <ArtifactField
                        field={{ id: "supporting_files", label: "Supporting Files", type: "file_list", required: false }}
                        artifacts={selectedResult.supportingArtifacts}
                        supporting
                        onUpload={(files) => uploadArtifacts(files, selectedTest.id, null)}
                        onDelete={(artifact) => void deleteArtifact(selectedTest.id, null, artifact)}
                      />
                    </div>
                  </section>
                </div>
              )}
            </section>
          </>
        ) : section === "overview" ? (
          <section style={{ minHeight: 0, overflowY: "auto", background: C.panel2, padding: "1rem 1.1rem 1.2rem" }}>
            <div style={{ display: "grid", gap: "1rem" }}>
              {!definition ? (
                <div style={{ color: C.muted, lineHeight: 1.7 }}>Upload a YAML definition to see the program overview.</div>
              ) : (
                <>
                  {getProgramDescription(definition) ? (
                    <section style={cardStyle()}>
                      <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Program Description</div>
                      <p style={{ margin: "0.85rem 0 0", color: C.text, lineHeight: 1.65 }}>{getProgramDescription(definition)}</p>
                    </section>
                  ) : null}
                  <section style={cardStyle()}>
                    <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>System Diagrams</div>
                    <div style={{ marginTop: "0.85rem" }}>
                      {definition.programAssets.length > 0 ? (
                        <PreTestAssetGallery assets={definition.programAssets} />
                      ) : (
                        <div style={{ color: C.muted, fontSize: "0.84rem" }}>
                          No program diagrams defined. Add <code style={{ background: C.panel, padding: "0.1rem 0.3rem", borderRadius: 4 }}>pre_test_assets:</code> under <code style={{ background: C.panel, padding: "0.1rem 0.3rem", borderRadius: 4 }}>program:</code> in your YAML to display system diagrams here.
                        </div>
                      )}
                    </div>
                  </section>
                </>
              )}
            </div>
          </section>
        ) : (
          <section style={{ minHeight: 0, overflowY: "auto", background: C.panel2, padding: "1rem 1.1rem 1.2rem" }}>
            <div style={{ display: "grid", gap: "1rem" }}>
                <section style={cardStyle()}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontSize: "0.78rem", color: C.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Summary Page Preview</div>
                      <div style={{ marginTop: "0.35rem", color: C.muted, fontSize: "0.84rem" }}>The report exports as a summary page with links to separate per-test detail pages.</div>
                    </div>
                    <button onClick={() => setReportDialogOpen(true)} style={buttonStyle("primary")} disabled={!reportPages}>Generate Report</button>
                  </div>
                  <div style={{ margin: "0.95rem 0 0", padding: "0.95rem", borderRadius: 12, background: "#07111e", border: `1px solid ${C.border}` }}>
                    <MarkdownBlock value={reportPages?.summary || "Upload a YAML definition to generate the report preview."} />
                  </div>
              </section>

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
      {reportDialogOpen ? (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.58)", display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem", zIndex: 50 }}>
          <section style={{ width: "min(520px, 100%)", border: `1px solid ${C.border}`, borderRadius: 16, background: C.panel, boxShadow: "0 24px 80px rgba(0,0,0,0.45)", overflow: "hidden" }}>
            <header style={{ padding: "1rem 1.1rem", borderBottom: `1px solid ${C.border}`, background: C.panel2 }}>
              <div style={{ fontWeight: 800 }}>Generate Report</div>
              <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.84rem" }}>Choose a portable PDF view or the full markdown report structure.</div>
            </header>
            <div style={{ padding: "1rem 1.1rem", display: "grid", gap: "0.8rem" }}>
              <button onClick={openReportPdf} style={{ ...buttonStyle("primary"), textAlign: "left", padding: "0.85rem 1rem" }} disabled={!reportPages}>
                PDF
                <span style={{ display: "block", marginTop: "0.25rem", color: C.accentText, opacity: 0.78, fontWeight: 500 }}>Opens a print-ready report view. Use the browser print dialog to save as PDF.</span>
              </button>
              <button onClick={downloadReportZip} style={{ ...buttonStyle(), textAlign: "left", padding: "0.85rem 1rem" }} disabled={!reportPages}>
                ZIP
                <span style={{ display: "block", marginTop: "0.25rem", color: C.muted, fontWeight: 500 }}>Downloads report.md, tests/*.md, generated SVG assets, evidence files, evidence/manifest.json, definition.yaml, and workspace.json.</span>
              </button>
            </div>
            <footer style={{ padding: "0.85rem 1.1rem", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => setReportDialogOpen(false)} style={buttonStyle()}>Cancel</button>
            </footer>
          </section>
        </div>
      ) : null}
      {printReportOpen && definition && reportPages && activeRun ? (
        <div className="test-manager-print-root" style={{ position: "fixed", inset: 0, zIndex: 60, overflow: "auto", background: "#eef2f7", color: "#111827", padding: "0.2rem" }}>
          <div className="test-manager-print-actions" style={{ position: "sticky", top: 0, zIndex: 2, display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", padding: "0.6rem 0.6rem 0.8rem", background: "#eef2f7" }}>
            <div style={{ fontWeight: 800 }}>Print Report</div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button onClick={() => window.print()} style={{ ...buttonStyle("primary"), borderColor: "#0f766e", background: "#0f766e", color: "white" }}>Print / Save PDF</button>
              <button onClick={() => setPrintReportOpen(false)} style={{ ...buttonStyle(), color: "#111827", borderColor: "#cbd5e1" }}>Close</button>
            </div>
          </div>
          <article className="test-manager-print-article" style={{ width: "calc(100vw - 0.4rem)", maxWidth: "none", margin: "0 auto 0.5rem", background: "white", border: "1px solid #dbe4ee", borderRadius: 8, padding: "1rem 1.1rem", boxShadow: "0 8px 24px rgba(15,23,42,0.06)", boxSizing: "border-box", fontSize: "1.05rem", lineHeight: 1.65 }}>
            <h1 style={{ marginTop: 0, marginBottom: "0.6rem", fontSize: "2rem", lineHeight: 1.2 }}>{getProgramTitle(definition, config)} Report</h1>
            <p style={{ color: "#374151", fontSize: "1rem", lineHeight: 1.6 }}><strong>Run:</strong> {activeRun.label}<br /><strong>Generated:</strong> {formatDate(nowIso())}</p>
            {definition.programAssets.length > 0 ? (
              <section style={{ marginBottom: "1.5rem", paddingBottom: "1.5rem", borderBottom: "1px solid #e5e7eb" }}>
                <h2 style={{ color: "#0f172a", fontSize: "1.45rem", lineHeight: 1.25 }}>Program Overview</h2>
                {getProgramDescription(definition) ? <p style={{ color: "#374151", lineHeight: 1.7, fontSize: "1.02rem" }}>{getProgramDescription(definition)}</p> : null}
                <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", marginTop: "1rem" }}>
                  {definition.programAssets.map((asset) => (
                    <div key={asset.id} style={{ borderRadius: 8, overflow: "hidden", border: "1px solid #e5e7eb" }}>
                      {asset.type === "svg_inline" || asset.type === "diagram_svg" ? (
                        <div dangerouslySetInnerHTML={{ __html: asset.content }} />
                      ) : (
                        <img src={asset.content} alt={asset.label} style={{ maxWidth: "100%", display: "block" }} />
                      )}
                      <div style={{ padding: "0.45rem 0.6rem", background: "#f8fafc", fontSize: "0.9rem", color: "#64748b", textAlign: "center" }}>{asset.label}</div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
            <section id="report-summary">
              <h2>Summary</h2>
              <PrintMarkdownBlock value={reportPages.summary} assets={reportPages.assets} />
            </section>
            {Object.entries(reportPages.details).map(([testId, markdown]) => (
              <section key={testId} id={`test-${safeFileSegment(testId)}`} className="test-manager-print-page">
                <h2>{testId}</h2>
                <PrintMarkdownBlock value={markdown} assets={reportPages.assets} />
              </section>
            ))}
          </article>
        </div>
      ) : null}
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
    const pages = generateReportPages(definition, activeRun, tests, {
      artifactHref: ({ test, fieldId, artifact }) => `../${artifactArchivePath(test.id, artifact, fieldId)}`,
    });
    await writeText(ctx.s3Client as S3Client, storage.bucket, `${ctx.projectPrefix}${ctx.config.id}/export/report.md`, pages.summary, "text/markdown;charset=utf-8");
    for (const [testId, detail] of Object.entries(pages.details)) {
      await writeText(ctx.s3Client as S3Client, storage.bucket, `${ctx.projectPrefix}${ctx.config.id}/export/tests/${testId}.md`, detail, "text/markdown;charset=utf-8");
    }
    for (const [path, asset] of Object.entries(pages.assets)) {
      await writeText(ctx.s3Client as S3Client, storage.bucket, `${ctx.projectPrefix}${ctx.config.id}/export/${path}`, asset.content, asset.contentType);
    }

    const manifest: Array<Record<string, string | number | null>> = [];
    for (const test of tests) {
      const result = ensureResult(activeRun, test);
      for (const [fieldId, artifacts] of Object.entries(result.typedArtifacts)) {
        for (const artifact of artifacts) {
          const exportPath = `${ctx.projectPrefix}${ctx.config.id}/export/${artifactArchivePath(test.id, artifact, fieldId)}`;
          const bytes = await readOptionalBytes(ctx.s3Client as S3Client, artifact.bucket, artifact.key);
          if (bytes) {
            await writeBytes(ctx.s3Client as S3Client, storage.bucket, exportPath, bytes, artifact.contentType || "application/octet-stream");
          }
          manifest.push({
            testId: test.id,
            fieldId,
            kind: artifact.kind,
            name: artifact.name,
            archivePath: artifactArchivePath(test.id, artifact, fieldId),
            bucket: artifact.bucket,
            key: artifact.key,
            contentType: artifact.contentType ?? null,
            sizeBytes: artifact.sizeBytes,
          });
        }
      }
      for (const artifact of result.supportingArtifacts) {
        const exportPath = `${ctx.projectPrefix}${ctx.config.id}/export/${artifactArchivePath(test.id, artifact, null)}`;
        const bytes = await readOptionalBytes(ctx.s3Client as S3Client, artifact.bucket, artifact.key);
        if (bytes) {
          await writeBytes(ctx.s3Client as S3Client, storage.bucket, exportPath, bytes, artifact.contentType || "application/octet-stream");
        }
        manifest.push({
          testId: test.id,
          fieldId: null,
          kind: artifact.kind,
          name: artifact.name,
          archivePath: artifactArchivePath(test.id, artifact, null),
          bucket: artifact.bucket,
          key: artifact.key,
          contentType: artifact.contentType ?? null,
          sizeBytes: artifact.sizeBytes,
        });
      }
    }
    await writeText(ctx.s3Client as S3Client, storage.bucket, `${ctx.projectPrefix}${ctx.config.id}/export/evidence/manifest.json`, JSON.stringify(manifest, null, 2), "application/json");
  }
}
