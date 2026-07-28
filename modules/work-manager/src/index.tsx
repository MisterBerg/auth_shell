import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExportContext, ModuleProps } from "module-core";
import { useAuthContext, useAwsDdbClient, useAwsS3Client, useUserProfile } from "module-core";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";

type WorkKind = "task" | "event" | "task-event" | "milestone";
type WorkStatus = "open" | "in-progress" | "blocked" | "done" | "archived";
type WorkPriority = "low" | "normal" | "high" | "urgent";
type ViewMode = "planner" | "tasks" | "gantt";
type SplitOrientation = "horizontal" | "vertical";
type ScaleMode = "days" | "months" | "years";

type WorkAttachment = {
  id: string;
  name: string;
  bucket: string;
  key: string;
  size: number;
  contentType?: string;
  uploadedAt: string;
  uploadedBy?: string;
};

type WorkItem = {
  id: string;
  kind: WorkKind;
  title: string;
  description: string;
  notes: string;
  status: WorkStatus;
  priority: WorkPriority;
  assignee?: string;
  tags: string[];
  repeatable: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  attachments: WorkAttachment[];
  startAt?: string;
  durationDays?: number;
  allDay: boolean;
  location?: string;
  progress: number;
  dependencies: string[];
  lane?: string;
};

type WorkStore = {
  version: 1;
  projectId: string;
  items: WorkItem[];
};

type Filters = {
  query: string;
  status: "all" | WorkStatus;
  assignee: "all" | "unassigned" | string;
  tag: string;
  repeatable: "all" | "yes" | "no";
  kind: "all" | WorkKind;
  viewMode: ViewMode;
  orientation: SplitOrientation;
};

type ProjectMember = {
  email: string;
  role?: string;
};

type ChartRow = {
  item: WorkItem;
  start: Date;
  end: Date;
  lane: string;
  isMilestone: boolean;
};

type ChartSpec = {
  rows: ChartRow[];
  startDate: Date;
  dayCount: number;
  labelWidth: number;
  rowHeight: number;
  headerHeight: number;
};

type EditorState = {
  draft: WorkItem;
  isNew: boolean;
};

const STATUSES: WorkStatus[] = ["open", "in-progress", "blocked", "done", "archived"];
const PRIORITIES: WorkPriority[] = ["low", "normal", "high", "urgent"];
const KINDS: WorkKind[] = ["task", "event", "task-event", "milestone"];
const LAYOUT_KEY = "work-manager-layout";
const DEFAULT_SPLIT_PCT = 38;
const MIN_SPLIT_PCT = 22;
const MAX_SPLIT_PCT = 78;

const C = {
  bg: "var(--hep-bg, var(--color-bg, #080f1c))",
  panel: "var(--hep-surface, var(--color-surface, #0b1525))",
  panel2: "var(--hep-surface-raised, var(--color-surface-raised, #0d1a2e))",
  input: "var(--hep-input-bg, #0a1525)",
  border: "var(--hep-border, var(--color-border, #1a2a42))",
  text: "var(--hep-text, var(--color-text, #e5e7eb))",
  muted: "var(--hep-muted, var(--color-muted, #6b7280))",
  accent: "var(--hep-accent, var(--color-primary, #3b82f6))",
  accentText: "var(--hep-accent-text, var(--color-primary-contrast, #ffffff))",
  warning: "var(--hep-warning, #f59e0b)",
  danger: "var(--hep-danger, #ef4444)",
  ok: "var(--hep-success, #22c55e)",
  archived: "var(--hep-surface-subtle, #08111d)",
  header: "linear-gradient(135deg, var(--hep-bg, var(--color-bg, #080f1c)), var(--hep-surface-raised, var(--color-surface-raised, #0d1a2e)))",
};

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  const cryptoId = globalThis.crypto?.randomUUID?.();
  return cryptoId ? `${prefix}-${cryptoId}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx) : "";
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addCalendarDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addBusinessDays(date: Date, days: number): Date {
  let next = new Date(date);
  if (days === 0) return next;
  let remaining = Math.abs(days);
  const direction = days > 0 ? 1 : -1;
  while (remaining > 0) {
    next = new Date(next);
    next.setDate(next.getDate() + direction);
    const day = next.getDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return next;
}

function calendarDaysBetween(start: Date, end: Date): number {
  return Math.round((startOfDay(end).getTime() - startOfDay(start).getTime()) / 86_400_000);
}

function businessDaysBetween(start: Date, end: Date): number {
  const a = startOfDay(start);
  const b = startOfDay(end);
  if (b < a) return 0;
  let count = 0;
  let cursor = new Date(a);
  while (cursor <= b) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

function formatDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

function formatDateInput(value?: string): string {
  return value ? value.slice(0, 10) : "";
}

function toIsoDate(value: string): string | undefined {
  return value ? new Date(`${value}T00:00:00`).toISOString() : undefined;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeCsv(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function sanitizePlantName(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\[/g, "(").replace(/\]/g, ")").trim();
}

function downloadText(filename: string, content: string, contentType = "text/plain;charset=utf-8"): void {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadJson(filename: string, value: unknown): void {
  downloadText(filename, JSON.stringify(value, null, 2), "application/json");
}

function getProjectInfo(config: ModuleProps["config"]) {
  const params = new URLSearchParams(window.location.search);
  const configPath = params.get("config") ?? "";
  const projectDir = dirname(configPath);
  const projectIdFromPath = configPath.match(/projects\/([^/]+)\//)?.[1];
  const projectId = projectIdFromPath ?? config.id;
  const bucket = params.get("bucket") ?? config.app.bucket;
  const basePrefix = projectDir ? `${projectDir}/work/${config.id}` : `work/${config.id}`;
  return {
    bucket,
    projectId,
    basePrefix,
    storeKey: `${basePrefix}/store.json`,
    attachmentsPrefix: `${basePrefix}/attachments`,
  };
}

async function readOptionalJson<T>(s3: S3Client, bucket: string, key: string): Promise<T | null> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await response.Body!.transformToString("utf-8")) as T;
  } catch (error: unknown) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === "NoSuchKey" || err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

async function writeStore(s3: S3Client, bucket: string, key: string, store: WorkStore): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(store, null, 2),
    ContentType: "application/json",
    CacheControl: "no-store",
  }));
}

function defaultItem(userEmail?: string, kind: WorkKind = "task"): WorkItem {
  const at = nowIso();
  return {
    id: makeId("work"),
    kind,
    title: kind === "milestone" ? "New milestone" : "New task",
    description: "",
    notes: "",
    status: "open",
    priority: kind === "milestone" ? "high" : "normal",
    assignee: undefined,
    tags: [],
    repeatable: false,
    createdAt: at,
    updatedAt: at,
    createdBy: userEmail,
    attachments: [],
    startAt: undefined,
    durationDays: 0,
    allDay: true,
    location: undefined,
    progress: 0,
    dependencies: [],
    lane: "",
  };
}

function normalizeLoadedStore(store: WorkStore | null, projectId: string): WorkStore {
  const next = store ?? { version: 1, projectId, items: [] };
  return {
    version: 1,
    projectId: next.projectId || projectId,
    items: (next.items ?? []).map((item) => ({
      ...defaultItem(undefined, item.kind ?? "task"),
      ...item,
      progress: typeof item.progress === "number" ? Math.max(0, Math.min(100, item.progress)) : 0,
      durationDays: item.kind === "milestone" ? 0 : Math.max(0, item.durationDays ?? 0),
      dependencies: Array.isArray(item.dependencies) ? item.dependencies.filter(Boolean) : [],
      lane: item.lane ?? "",
    })),
  };
}

function matchesFilters(item: WorkItem, filters: Filters): boolean {
  const query = filters.query.trim().toLowerCase();
  if (query) {
    const haystack = [item.title, item.description, item.notes, item.assignee, item.tags.join(" "), item.location, item.lane].join(" ").toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  if (filters.status !== "all" && item.status !== filters.status) return false;
  if (filters.assignee === "unassigned" && item.assignee) return false;
  if (filters.assignee !== "all" && filters.assignee !== "unassigned" && item.assignee !== filters.assignee) return false;
  if (filters.tag && !item.tags.some((tag) => tag.toLowerCase().includes(filters.tag.toLowerCase()))) return false;
  if (filters.repeatable === "yes" && !item.repeatable) return false;
  if (filters.repeatable === "no" && item.repeatable) return false;
  if (filters.kind !== "all" && item.kind !== filters.kind) return false;
  return true;
}

function isScheduledItem(item: WorkItem): boolean {
  if (item.kind !== "milestone" && Math.max(0, item.durationDays ?? 0) === 0) return false;
  return Boolean(item.startAt || item.dependencies.length);
}

function itemTimeLabel(item: WorkItem): string {
  if (item.kind !== "milestone" && Math.max(0, item.durationDays ?? 0) === 0) return "Task list only";
  if (item.startAt && item.durationDays && item.durationDays > 0) return `${formatDate(item.startAt)} · ${item.durationDays}d`;
  if (item.startAt) return `Starts ${formatDate(item.startAt)}`;
  if (item.dependencies.length && item.durationDays && item.durationDays > 0) return `From dependencies · ${item.durationDays}d`;
  return "Unscheduled";
}

function laneRank(lane?: string): string {
  return lane?.trim().toLowerCase() || "zzz-default";
}

function kindRank(kind: WorkKind): number {
  return kind === "task-event" ? 0 : kind === "event" ? 1 : kind === "task" ? 2 : 3;
}

function sortByTimeline(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => {
    const laneCompare = laneRank(a.lane).localeCompare(laneRank(b.lane));
    if (laneCompare) return laneCompare;
    const kindCompare = kindRank(a.kind) - kindRank(b.kind);
    if (kindCompare) return kindCompare;
    const aTime = a.startAt ?? a.createdAt;
    const bTime = b.startAt ?? b.createdAt;
    return aTime.localeCompare(bTime) || a.title.localeCompare(b.title);
  });
}

function compareChartRows(a: ChartRow, b: ChartRow): number {
  const endCompare = startOfDay(a.end).getTime() - startOfDay(b.end).getTime();
  if (endCompare) return endCompare;

  const startCompare = startOfDay(a.start).getTime() - startOfDay(b.start).getTime();
  if (startCompare) return startCompare;

  const kindCompare = kindRank(a.item.kind) - kindRank(b.item.kind);
  if (kindCompare) return kindCompare;

  return a.item.title.localeCompare(b.item.title);
}

function sortLaneChartRows(rows: ChartRow[]): ChartRow[] {
  const rowsById = new Map(rows.map((row) => [row.item.id, row]));
  const predecessorsById = new Map<string, Set<string>>();
  const dependentsById = new Map<string, Set<string>>();

  for (const row of rows) {
    const predecessors = new Set(row.item.dependencies.filter((depId) => rowsById.has(depId)));
    predecessorsById.set(row.item.id, predecessors);
    for (const depId of predecessors) {
      if (!dependentsById.has(depId)) dependentsById.set(depId, new Set());
      dependentsById.get(depId)!.add(row.item.id);
    }
  }

  const emitted = new Set<string>();
  const ready = rows.filter((row) => (predecessorsById.get(row.item.id)?.size ?? 0) === 0).sort(compareChartRows);
  const result: ChartRow[] = [];
  let previousId: string | null = null;

  const takeNextReady = (): ChartRow | undefined => {
    if (previousId) {
      const dependencyId = previousId;
      const continuation = ready
        .filter((row) => predecessorsById.get(row.item.id)?.has(dependencyId))
        .sort(compareChartRows)[0];
      if (continuation) {
        ready.splice(ready.findIndex((row) => row.item.id === continuation.item.id), 1);
        return continuation;
      }
    }

    ready.sort(compareChartRows);
    return ready.shift();
  };

  while (ready.length) {
    const next = takeNextReady();
    if (!next) break;
    result.push(next);
    emitted.add(next.item.id);
    previousId = next.item.id;

    for (const dependentId of dependentsById.get(next.item.id) ?? []) {
      if (emitted.has(dependentId) || ready.some((row) => row.item.id === dependentId)) continue;
      const predecessors = predecessorsById.get(dependentId) ?? new Set<string>();
      if ([...predecessors].every((predecessorId) => emitted.has(predecessorId))) {
        const dependent = rowsById.get(dependentId);
        if (dependent) ready.push(dependent);
      }
    }
  }

  const unresolved = rows.filter((row) => !emitted.has(row.item.id)).sort(compareChartRows);
  return [...result, ...unresolved];
}

function sortChartRows(rows: ChartRow[]): ChartRow[] {
  const lanes = new Map<string, ChartRow[]>();
  for (const row of rows) {
    const key = laneRank(row.item.lane);
    lanes.set(key, [...(lanes.get(key) ?? []), row]);
  }

  return [...lanes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, laneRows]) => sortLaneChartRows(laneRows));
}

function deriveWindow(item: WorkItem, itemsById: Map<string, WorkItem>, stack = new Set<string>()): { start: Date | null; end: Date | null; isMilestone: boolean } {
  const isMilestone = item.kind === "milestone";
  const durationDays = isMilestone ? 0 : Math.max(0, item.durationDays ?? 0);
  if (!isMilestone && durationDays === 0) return { start: null, end: null, isMilestone };
  if (stack.has(item.id)) return { start: null, end: null, isMilestone };
  let startDate: Date | null = null;
  if (item.startAt) {
    const parsed = new Date(item.startAt);
    if (!Number.isNaN(parsed.getTime())) startDate = parsed;
  } else if (item.dependencies.length) {
    const nextStack = new Set(stack);
    nextStack.add(item.id);
    let latestEnd: Date | null = null;
    for (const depId of item.dependencies) {
      const dep = itemsById.get(depId);
      if (!dep) continue;
      const depWindow = deriveWindow(dep, itemsById, nextStack);
      if (depWindow.end && (!latestEnd || depWindow.end > latestEnd)) latestEnd = depWindow.end;
    }
    if (latestEnd) startDate = addBusinessDays(startOfDay(latestEnd), 1);
  }
  if (!startDate) return { start: null, end: null, isMilestone };
  if (isMilestone) return { start: startDate, end: startDate, isMilestone };
  return { start: startDate, end: addBusinessDays(startDate, durationDays - 1), isMilestone: false };
}

function buildChartSpec(items: WorkItem[]): ChartSpec | null {
  const scheduled = items.filter(isScheduledItem);
  if (scheduled.length === 0) return null;
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const rows = sortChartRows(scheduled.flatMap((item) => {
    const { start, end, isMilestone } = deriveWindow(item, itemsById);
    if (!start || !end) return [];
    return {
      item,
      start,
      end,
      lane: item.lane?.trim() || "Default",
      isMilestone,
    };
  }));
  if (rows.length === 0) return null;
  const today = startOfDay(new Date());
  const minRowDate = rows.reduce((min, row) => row.start < min ? row.start : min, rows[0]!.start);
  const maxRowDate = rows.reduce((max, row) => row.end > max ? row.end : max, rows[0]!.end);
  const minDate = today < minRowDate ? today : minRowDate;
  const maxDate = today > maxRowDate ? today : maxRowDate;
  const startDate = addCalendarDays(startOfDay(minDate), -1);
  const endDate = addCalendarDays(startOfDay(maxDate), 2);
  return {
    rows,
    startDate,
    dayCount: Math.max(1, calendarDaysBetween(startDate, endDate)),
    labelWidth: 250,
    rowHeight: 42,
    headerHeight: 44,
  };
}

function chooseScaleMode(dayWidth: number, totalDays: number): ScaleMode {
  if (dayWidth >= 20) return "days";
  if (totalDays > 720 || dayWidth < 6) return "years";
  return "months";
}

function buildChartSvg(spec: ChartSpec, selectedItemId: string | undefined, zoom: number, includeLabels = false): string {
  const dayWidth = Math.max(3, Math.min(120, 28 * zoom));
  const scaleMode = chooseScaleMode(dayWidth, spec.dayCount);
  const chartWidth = spec.dayCount * dayWidth + 20;
  const labelWidth = includeLabels ? Math.max(320, spec.labelWidth) : 0;
  const svgWidth = labelWidth + chartWidth;
  const svgHeight = spec.headerHeight + spec.rows.length * spec.rowHeight + 20;
  const lines: string[] = [];

  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}" role="img" aria-label="Work manager gantt chart">`);
  lines.push(`<rect width="${svgWidth}" height="${svgHeight}" fill="#0b1525"/>`);
  if (includeLabels) {
    lines.push(`<clipPath id="work-label-task-clip"><rect x="111" y="0" width="${labelWidth - 122}" height="${svgHeight}"/></clipPath>`);
    lines.push(`<rect x="0" y="0" width="${labelWidth}" height="${svgHeight}" fill="#0d1a2e"/>`);
    lines.push(`<rect x="0" y="0" width="${labelWidth}" height="${spec.headerHeight}" fill="#0d1a2e"/>`);
    lines.push(`<text x="12" y="27" font-size="11" font-weight="700" fill="#9ca3af">GROUP</text>`);
    lines.push(`<text x="122" y="27" font-size="11" font-weight="700" fill="#9ca3af">TASK</text>`);
    lines.push(`<line x1="${labelWidth}" y1="0" x2="${labelWidth}" y2="${svgHeight}" stroke="#1a2a42" stroke-width="1"/>`);
    lines.push(`<line x1="110" y1="0" x2="110" y2="${svgHeight}" stroke="#1a2a42" stroke-width="1"/>`);
  }

  for (let i = 0; i < spec.dayCount; i += 1) {
    const date = addCalendarDays(spec.startDate, i);
    const x = labelWidth + i * dayWidth;
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    lines.push(`<rect x="${x}" y="0" width="${dayWidth}" height="${svgHeight}" fill="${weekend ? "#0d1a2e" : "#0b1525"}"/>`);
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${svgHeight}" stroke="#1a2a42" stroke-width="1"/>`);
    if (scaleMode === "days") {
      lines.push(`<text x="${x + dayWidth / 2}" y="17" text-anchor="middle" font-size="10" fill="#9ca3af">${escapeXml(date.toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</text>`);
    }
  }
  lines.push(`<line x1="${labelWidth + spec.dayCount * dayWidth}" y1="0" x2="${labelWidth + spec.dayCount * dayWidth}" y2="${svgHeight}" stroke="#1a2a42" stroke-width="1"/>`);

  if (scaleMode !== "days") {
    let cursor = 0;
    while (cursor < spec.dayCount) {
      const date = addCalendarDays(spec.startDate, cursor);
      const label = scaleMode === "years"
        ? String(date.getFullYear())
        : date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
      let span = 1;
      while (cursor + span < spec.dayCount) {
        const next = addCalendarDays(spec.startDate, cursor + span);
        const same = scaleMode === "years"
          ? next.getFullYear() === date.getFullYear()
          : next.getFullYear() === date.getFullYear() && next.getMonth() === date.getMonth();
        if (!same) break;
        span += 1;
      }
      const x = labelWidth + cursor * dayWidth;
      lines.push(`<text x="${x + span * dayWidth / 2}" y="17" text-anchor="middle" font-size="10" fill="#9ca3af">${escapeXml(label)}</text>`);
      cursor += span;
    }
  }

  spec.rows.forEach((row, index) => {
    const y = spec.headerHeight + index * spec.rowHeight;
    const selected = row.item.id === selectedItemId;
    const previous = spec.rows[index - 1];
    const firstInGroup = !previous || previous.lane !== row.lane;
    const startOffset = calendarDaysBetween(spec.startDate, row.start);
    const duration = row.isMilestone ? 0 : Math.max(1, calendarDaysBetween(startOfDay(row.start), startOfDay(row.end)) + 1);
    const barX = labelWidth + startOffset * dayWidth + 4;
    const barY = y + 10;
    const barWidth = row.isMilestone ? 16 : Math.max(18, duration * dayWidth - 8);
    const barColor = kindColor(row.item.kind);
    lines.push(`<rect x="${labelWidth}" y="${y}" width="${chartWidth}" height="${spec.rowHeight}" fill="${index % 2 === 0 ? "#0b1525" : "#0a1322"}"/>`);
    if (includeLabels) {
      lines.push(`<rect x="0" y="${y}" width="${labelWidth}" height="${spec.rowHeight}" fill="${selected ? "rgba(59,130,246,0.12)" : index % 2 === 0 ? "#0b1525" : "#0a1322"}"/>`);
      if (firstInGroup) lines.push(`<line x1="0" y1="${y}" x2="${labelWidth}" y2="${y}" stroke="#28415f" stroke-width="2"/>`);
      lines.push(`<text x="12" y="${y + 25}" font-size="12" font-weight="700" fill="${firstInGroup ? "#cbd5e1" : "transparent"}">${firstInGroup ? escapeXml(row.lane) : ""}</text>`);
      lines.push(`<text x="122" y="${y + 18}" font-size="13" font-weight="700" fill="#e5e7eb" clip-path="url(#work-label-task-clip)">${escapeXml(row.item.title)}</text>`);
      lines.push(`<text x="122" y="${y + 34}" font-size="11" fill="#6b7280" clip-path="url(#work-label-task-clip)">${escapeXml(`${row.item.kind} · ${row.item.status}`)}</text>`);
    }
    if (selected) lines.push(`<rect x="${labelWidth}" y="${y}" width="${chartWidth}" height="${spec.rowHeight}" fill="rgba(59,130,246,0.12)"/>`);
    lines.push(`<line x1="0" y1="${y + spec.rowHeight}" x2="${svgWidth}" y2="${y + spec.rowHeight}" stroke="#1a2a42" stroke-width="1"/>`);

    if (row.isMilestone) {
      const cx = barX + 8;
      const cy = barY + 10;
      lines.push(`<polygon points="${cx},${cy - 8} ${cx + 8},${cy} ${cx},${cy + 8} ${cx - 8},${cy}" fill="${barColor}" stroke="#08111d" stroke-width="1.5"/>`);
    } else {
      lines.push(`<rect x="${barX}" y="${barY}" width="${barWidth}" height="20" rx="7" ry="7" fill="${barColor}" opacity="0.96"/>`);
      if (row.item.progress > 0) {
        lines.push(`<rect x="${barX}" y="${barY}" width="${Math.max(10, barWidth * (row.item.progress / 100))}" height="20" rx="7" ry="7" fill="rgba(8,17,29,0.28)"/>`);
      }
    }
  });

  const byId = new Map(spec.rows.map((row, index) => [row.item.id, { row, index }]));
  spec.rows.forEach((row, index) => {
    const dependentStartX = labelWidth + calendarDaysBetween(spec.startDate, row.start) * dayWidth + 4;
    const dependentY = spec.headerHeight + index * spec.rowHeight + 20;
    row.item.dependencies.forEach((depId) => {
      const dependency = byId.get(depId);
      if (!dependency) return;
      const dependencyWidth = dependency.row.isMilestone ? 16 : Math.max(18, (calendarDaysBetween(startOfDay(dependency.row.start), startOfDay(dependency.row.end)) + 1) * dayWidth - 8);
      const sourceX = labelWidth + calendarDaysBetween(spec.startDate, dependency.row.start) * dayWidth + 4 + dependencyWidth;
      const sourceY = spec.headerHeight + dependency.index * spec.rowHeight + 20;
      const bendX = sourceX + 10;
      lines.push(`<path d="M ${sourceX} ${sourceY} L ${bendX} ${sourceY} L ${bendX} ${dependentY} L ${dependentStartX} ${dependentY}" fill="none" stroke="#93c5fd" stroke-width="1.5"/>`);
      lines.push(`<polygon points="${dependentStartX},${dependentY} ${dependentStartX - 6},${dependentY - 4} ${dependentStartX - 6},${dependentY + 4}" fill="#93c5fd"/>`);
    });
  });

  const todayOffset = calendarDaysBetween(spec.startDate, startOfDay(new Date()));
  if (todayOffset >= 0 && todayOffset <= spec.dayCount) {
    const todayX = labelWidth + todayOffset * dayWidth + dayWidth / 2;
    lines.push(`<line x1="${todayX}" y1="0" x2="${todayX}" y2="${svgHeight}" stroke="#ef4444" stroke-width="2" stroke-dasharray="6 5"/>`);
  }

  lines.push(`</svg>`);
  return lines.join("");
}

function chartSpecToCsv(spec: ChartSpec): string {
  const header = ["id", "title", "kind", "status", "priority", "assignee", "lane", "startAt", "durationDays", "progress", "dependencies"];
  const rows = spec.rows.map(({ item }) => [
    item.id,
    item.title,
    item.kind,
    item.status,
    item.priority,
    item.assignee ?? "",
    item.lane ?? "",
    item.startAt ?? "",
    String(item.durationDays ?? ""),
    String(item.progress),
    item.dependencies.join("|"),
  ]);
  return [header, ...rows].map((row) => row.map((cell) => escapeCsv(cell)).join(",")).join("\n");
}

function chartSpecToPlantUml(spec: ChartSpec): string {
  const lines = ["@startgantt", `Project starts ${spec.startDate.toISOString().slice(0, 10)}`];
  for (const { item, start, end, isMilestone } of spec.rows) {
    const title = sanitizePlantName(item.title || item.id);
    if (isMilestone) lines.push(`[${title}] happens at ${start.toISOString().slice(0, 10)}`);
    else {
      lines.push(`[${title}] starts ${start.toISOString().slice(0, 10)}`);
      lines.push(`[${title}] ends ${end.toISOString().slice(0, 10)}`);
    }
    if (item.progress > 0) lines.push(`[${title}] is ${Math.round(item.progress)}% complete`);
  }
  lines.push("@endgantt");
  return lines.join("\n");
}

async function exportSvgAsPng(svgMarkup: string, filename: string): Promise<void> {
  const blob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Unable to load SVG for PNG export."));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.width || 1600;
    canvas.height = image.height || 900;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas context unavailable.");
    ctx.fillStyle = "#0b1525";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    const link = document.createElement("a");
    link.href = canvas.toDataURL("image/png");
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function clampSplitPct(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPLIT_PCT;
  return Math.max(MIN_SPLIT_PCT, Math.min(MAX_SPLIT_PCT, value));
}

function readSavedLayout(): Pick<Filters, "viewMode" | "orientation"> & { splitPct: number } {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { viewMode: "planner", orientation: "horizontal", splitPct: DEFAULT_SPLIT_PCT };
    const parsed = JSON.parse(raw) as Partial<Pick<Filters, "viewMode" | "orientation">> & { splitPct?: number };
    return {
      viewMode: parsed.viewMode === "tasks" || parsed.viewMode === "gantt" || parsed.viewMode === "planner" ? parsed.viewMode : "planner",
      orientation: parsed.orientation === "vertical" ? "vertical" : "horizontal",
      splitPct: clampSplitPct(Number(parsed.splitPct ?? DEFAULT_SPLIT_PCT)),
    };
  } catch {
    return { viewMode: "planner", orientation: "horizontal", splitPct: DEFAULT_SPLIT_PCT };
  }
}

export default function WorkManager({ config }: ModuleProps) {
  const user = useUserProfile();
  const auth = useAuthContext();
  const getS3Client = useAwsS3Client();
  const getDdbClient = useAwsDdbClient();
  const project = useMemo(() => getProjectInfo(config), [config]);
  const savedLayout = useMemo(() => readSavedLayout(), []);

  const [store, setStore] = useState<WorkStore>({ version: 1, projectId: project.projectId, items: [] });
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [filters, setFilters] = useState<Filters>({
    query: "",
    status: "all",
    assignee: "all",
    tag: "",
    repeatable: "all",
    kind: "all",
    viewMode: savedLayout.viewMode,
    orientation: savedLayout.orientation,
  });
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [zoom, setZoom] = useState(1);
  const [splitPct, setSplitPct] = useState(savedLayout.splitPct);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const importRef = useRef<HTMLInputElement>(null);

  const currentUserEmail = user?.email?.toLowerCase();
  const items = store.items;
  const filteredItems = useMemo(() => items.filter((item) => matchesFilters(item, filters)), [filters, items]);
  const allTags = useMemo(() => [...new Set(items.flatMap((item) => item.tags))].sort(), [items]);
  const ganttSpec = useMemo(() => buildChartSpec(filteredItems), [filteredItems]);
  const ganttSvg = useMemo(() => ganttSpec ? buildChartSvg(ganttSpec, selectedItemId ?? undefined, zoom) : null, [ganttSpec, selectedItemId, zoom]);
  const taskListItems = useMemo(() => sortByTimeline(filteredItems), [filteredItems]);

  const persist = useCallback(async (nextStore: WorkStore) => {
    setSaving(true);
    setError(undefined);
    try {
      const s3 = await getS3Client(project.bucket);
      await writeStore(s3, project.bucket, project.storeKey, nextStore);
      setStore(nextStore);
      setMessage("Saved");
    } catch (persistError: unknown) {
      setError((persistError as Error).message);
    } finally {
      setSaving(false);
    }
  }, [getS3Client, project.bucket, project.storeKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    getS3Client(project.bucket)
      .then((s3) => readOptionalJson<WorkStore>(s3, project.bucket, project.storeKey))
      .then((loaded) => {
        if (cancelled) return;
        setStore(normalizeLoadedStore(loaded, project.projectId));
        setLoading(false);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError((loadError as Error).message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [getS3Client, project.bucket, project.projectId, project.storeKey]);

  useEffect(() => {
    let cancelled = false;
    const tableName = auth.tables?.projects ?? "org-projects";
    getDdbClient()
      .then((ddb) => ddb.send(new ScanCommand({
        TableName: tableName,
        FilterExpression: "projectId = :projectId",
        ExpressionAttributeValues: { ":projectId": project.projectId },
      })))
      .then((result) => {
        if (cancelled) return;
        const byEmail = new Map<string, ProjectMember>();
        if (currentUserEmail) byEmail.set(currentUserEmail, { email: currentUserEmail, role: "current user" });
        for (const item of result.Items ?? []) {
          const email = String(item.sharedWithUserId ?? item.userId ?? "").toLowerCase();
          if (email) byEmail.set(email, { email, role: String(item.role ?? "") || undefined });
          const sharedBy = String(item.sharedByUserId ?? "").toLowerCase();
          if (sharedBy && !byEmail.has(sharedBy)) byEmail.set(sharedBy, { email: sharedBy, role: "owner" });
        }
        setMembers([...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email)));
      })
      .catch(() => {
        if (currentUserEmail) setMembers([{ email: currentUserEmail, role: "current user" }]);
      });
    return () => { cancelled = true; };
  }, [auth.tables?.projects, currentUserEmail, getDdbClient, project.projectId]);

  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ viewMode: filters.viewMode, orientation: filters.orientation, splitPct }));
  }, [filters.orientation, filters.viewMode, splitPct]);

  const saveDraft = useCallback(async (draft: WorkItem, isNew: boolean) => {
    const normalized: WorkItem = {
      ...draft,
      title: draft.title.trim() || "Untitled task",
      updatedAt: nowIso(),
      progress: Math.max(0, Math.min(100, Number(draft.progress) || 0)),
      durationDays: draft.kind === "milestone" ? 0 : Math.max(0, Number(draft.durationDays) || 0),
      dependencies: [...new Set(draft.dependencies.filter(Boolean))],
      lane: draft.lane?.trim() || "",
    };
    const nextStore = isNew
      ? { ...store, items: [normalized, ...store.items] }
      : { ...store, items: store.items.map((item) => item.id === normalized.id ? normalized : item) };
    await persist(nextStore);
    setSelectedItemId(normalized.id);
    return normalized;
  }, [persist, store]);

  const openExisting = useCallback((itemId: string) => {
    const item = store.items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    setSelectedItemId(item.id);
    setEditorState({ draft: { ...item, tags: [...item.tags], dependencies: [...item.dependencies], attachments: [...item.attachments] }, isNew: false });
  }, [store.items]);

  const openNew = useCallback((kind: WorkKind, seed?: Partial<WorkItem>) => {
    const draft = { ...defaultItem(currentUserEmail, kind), ...seed };
    setEditorState({ draft, isNew: true });
    setSelectedItemId(null);
  }, [currentUserEmail]);

  const duplicateItem = useCallback((item: WorkItem) => {
    const at = nowIso();
    openNew(item.kind, {
      ...item,
      id: makeId("work"),
      title: `${item.title} copy`,
      status: "open",
      attachments: [],
      createdAt: at,
      updatedAt: at,
      createdBy: currentUserEmail,
    });
  }, [currentUserEmail, openNew]);

  const deleteItem = useCallback(async (item: WorkItem) => {
    if (!window.confirm(`Delete "${item.title}"? Attachments will be removed from S3.`)) return;
    setSaving(true);
    try {
      const s3 = await getS3Client(project.bucket);
      await Promise.all(item.attachments.map((attachment) =>
        s3.send(new DeleteObjectCommand({ Bucket: attachment.bucket, Key: attachment.key })).catch(() => undefined)
      ));
      const nextStore = { ...store, items: store.items.filter((candidate) => candidate.id !== item.id) };
      await writeStore(s3, project.bucket, project.storeKey, nextStore);
      setStore(nextStore);
      setEditorState(null);
      setSelectedItemId(null);
      setMessage("Item deleted");
    } catch (deleteError: unknown) {
      setError((deleteError as Error).message);
    } finally {
      setSaving(false);
    }
  }, [getS3Client, project.bucket, project.storeKey, store]);

  const uploadAttachments = useCallback(async (item: WorkItem, files: FileList | null) => {
    if (!files?.length) return item;
    const s3 = await getS3Client(project.bucket);
    const uploaded: WorkAttachment[] = [];
    for (const file of Array.from(files)) {
      const attachmentId = makeId("att");
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
      const key = `${project.attachmentsPrefix}/${item.id}/${attachmentId}-${safeName}`;
      await s3.send(new PutObjectCommand({
        Bucket: project.bucket,
        Key: key,
        Body: new Uint8Array(await file.arrayBuffer()),
        ContentType: file.type || "application/octet-stream",
        CacheControl: "no-store",
      }));
      uploaded.push({ id: attachmentId, name: file.name, bucket: project.bucket, key, size: file.size, contentType: file.type || undefined, uploadedAt: nowIso(), uploadedBy: currentUserEmail });
    }
    return { ...item, attachments: [...item.attachments, ...uploaded], updatedAt: nowIso() };
  }, [currentUserEmail, getS3Client, project.attachmentsPrefix, project.bucket]);

  const downloadAttachment = useCallback(async (attachment: WorkAttachment) => {
    const s3 = await getS3Client(attachment.bucket);
    const response = await s3.send(new GetObjectCommand({ Bucket: attachment.bucket, Key: attachment.key }));
    const bytes = await response.Body!.transformToByteArray();
    const blobPart = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([blobPart], { type: attachment.contentType }));
    const link = document.createElement("a");
    link.href = url;
    link.download = attachment.name;
    link.click();
    URL.revokeObjectURL(url);
  }, [getS3Client]);

  const removeAttachment = useCallback(async (draft: WorkItem, attachment: WorkAttachment) => {
    const s3 = await getS3Client(attachment.bucket);
    await s3.send(new DeleteObjectCommand({ Bucket: attachment.bucket, Key: attachment.key })).catch(() => undefined);
    return { ...draft, attachments: draft.attachments.filter((candidate) => candidate.id !== attachment.id), updatedAt: nowIso() };
  }, [getS3Client]);

  const exportFiltered = useCallback(() => {
    downloadJson(`work-${project.projectId}-${new Date().toISOString().slice(0, 10)}.json`, { version: 1, sourceProjectId: project.projectId, exportedAt: nowIso(), items: filteredItems });
  }, [filteredItems, project.projectId]);

  const exportCsv = useCallback(() => {
    if (!ganttSpec) return;
    downloadText(`work-${project.projectId}-${new Date().toISOString().slice(0, 10)}.csv`, chartSpecToCsv(ganttSpec), "text/csv;charset=utf-8");
  }, [ganttSpec, project.projectId]);

  const exportPlantUml = useCallback(() => {
    if (!ganttSpec) return;
    downloadText(`work-${project.projectId}-${new Date().toISOString().slice(0, 10)}.puml`, chartSpecToPlantUml(ganttSpec));
  }, [ganttSpec, project.projectId]);

  const exportSvg = useCallback(() => {
    if (!ganttSpec) return;
    const labeledSvg = buildChartSvg(ganttSpec, selectedItemId ?? undefined, zoom, true);
    downloadText(`work-${project.projectId}-${new Date().toISOString().slice(0, 10)}.svg`, labeledSvg, "image/svg+xml;charset=utf-8");
  }, [ganttSpec, project.projectId, selectedItemId, zoom]);

  const exportPng = useCallback(async () => {
    if (!ganttSpec) return;
    try {
      const labeledSvg = buildChartSvg(ganttSpec, selectedItemId ?? undefined, zoom, true);
      await exportSvgAsPng(labeledSvg, `work-${project.projectId}-${new Date().toISOString().slice(0, 10)}.png`);
    } catch (pngError: unknown) {
      setError((pngError as Error).message);
    }
  }, [ganttSpec, project.projectId, selectedItemId, zoom]);

  const importItems = useCallback(async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as { items?: WorkItem[] };
      const imported = (parsed.items ?? []).map((item) => {
        const at = nowIso();
        return {
          ...defaultItem(currentUserEmail, item.kind ?? "task"),
          ...item,
          id: makeId("work"),
          attachments: [],
          createdAt: at,
          updatedAt: at,
          createdBy: currentUserEmail,
          durationDays: item.kind === "milestone" ? 0 : Math.max(0, item.durationDays ?? 0),
          dependencies: Array.isArray(item.dependencies) ? item.dependencies.filter(Boolean) : [],
          progress: typeof item.progress === "number" ? Math.max(0, Math.min(100, item.progress)) : 0,
        };
      });
      await persist({ ...store, items: [...imported, ...store.items] });
      setMessage(`Imported ${imported.length} item${imported.length === 1 ? "" : "s"}`);
    } catch (importError: unknown) {
      setError((importError as Error).message);
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  }, [currentUserEmail, persist, store]);

  if (loading) return <Centered>Loading work manager...</Centered>;

  return (
    <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", background: C.bg, color: C.text, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <header style={{ padding: "1rem 1.1rem", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", background: C.header }}>
        <div>
          <div style={{ fontSize: "0.72rem", color: C.accent, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>Work Manager</div>
          <h2 style={{ margin: "0.15rem 0 0", fontSize: "1.25rem" }}>{(config.meta?.["title"] as string | undefined) ?? "Project Work"}</h2>
          <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.78rem" }}>{filteredItems.length} of {items.length} shown · {project.projectId}</div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => openNew("task")} style={primaryButton()}>+ Task</button>
          <button onClick={() => openNew("task-event")} style={ghostButton()}>+ Task/Event</button>
          <button onClick={() => openNew("milestone")} style={ghostButton()}>+ Milestone</button>
          <button onClick={() => importRef.current?.click()} style={ghostButton()}>Import</button>
          <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => void importItems(event.target.files?.[0])} />
        </div>
      </header>

      <section style={{ padding: "0.75rem 1rem", borderBottom: `1px solid ${C.border}`, display: "grid", gridTemplateColumns: "minmax(180px, 2fr) repeat(6, minmax(110px, 1fr))", gap: "0.55rem", background: C.panel }}>
        <input value={filters.query} onChange={(e) => setFilters((current) => ({ ...current, query: e.target.value }))} placeholder="Search title, notes, tags..." style={inputStyle()} />
        <select value={filters.viewMode} onChange={(e) => setFilters((current) => ({ ...current, viewMode: e.target.value as ViewMode }))} style={inputStyle()}>
          <option value="planner">Planner</option>
          <option value="tasks">Tasks only</option>
          <option value="gantt">Gantt only</option>
        </select>
        <select value={filters.orientation} onChange={(e) => setFilters((current) => ({ ...current, orientation: e.target.value as SplitOrientation }))} style={inputStyle()}>
          <option value="horizontal">Split left/right</option>
          <option value="vertical">Split top/bottom</option>
        </select>
        <select value={filters.kind} onChange={(e) => setFilters((current) => ({ ...current, kind: e.target.value as Filters["kind"] }))} style={inputStyle()}>
          <option value="all">All kinds</option>
          {KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </select>
        <select value={filters.status} onChange={(e) => setFilters((current) => ({ ...current, status: e.target.value as Filters["status"] }))} style={inputStyle()}>
          <option value="all">All status</option>
          {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
        <select value={filters.assignee} onChange={(e) => setFilters((current) => ({ ...current, assignee: e.target.value }))} style={inputStyle()}>
          <option value="all">All assignees</option>
          <option value="unassigned">Unassigned</option>
          {members.map((member) => <option key={member.email} value={member.email}>{member.email}</option>)}
        </select>
        <input value={filters.tag} onChange={(e) => setFilters((current) => ({ ...current, tag: e.target.value }))} placeholder={allTags.length ? `Tags: ${allTags.slice(0, 3).join(", ")}` : "Filter tag"} style={inputStyle()} />
      </section>

      <section style={{ padding: "0.6rem 1rem", borderBottom: `1px solid ${C.border}`, display: "flex", gap: "0.45rem", flexWrap: "wrap", background: C.panel2 }}>
        <button onClick={exportFiltered} style={ghostButton()}>Export JSON</button>
        <button onClick={exportCsv} style={ghostButton()} disabled={!ganttSpec}>Export CSV</button>
        <button onClick={exportSvg} style={ghostButton()} disabled={!ganttSvg}>Export SVG</button>
        <button onClick={() => void exportPng()} style={ghostButton()} disabled={!ganttSvg}>Export PNG</button>
        <button onClick={exportPlantUml} style={ghostButton()} disabled={!ganttSpec}>Export PlantUML</button>
      </section>

      {(error || message || saving) && (
        <div style={{ padding: "0.45rem 1rem", borderBottom: `1px solid ${C.border}`, color: error ? C.danger : saving ? C.warning : C.ok, fontSize: "0.78rem" }}>
          {error ?? (saving ? "Saving..." : message)}
        </div>
      )}

      <main style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: "0.85rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {filteredItems.length === 0 ? (
          <Centered>No items match the current filters.</Centered>
        ) : filters.viewMode === "tasks" ? (
          <TaskPanel items={taskListItems} selectedItemId={selectedItemId} onSelect={openExisting} />
        ) : filters.viewMode === "gantt" ? (
          <GanttPanel spec={ganttSpec} svgMarkup={ganttSvg} selectedItemId={selectedItemId} onSelect={openExisting} zoom={zoom} onZoom={setZoom} />
        ) : (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: filters.orientation === "horizontal" ? "row" : "column",
              gap: 0,
            }}
          >
            <div style={{ flex: `0 0 ${splitPct}%`, minHeight: 0, minWidth: 0 }}>
              <TaskPanel items={taskListItems} selectedItemId={selectedItemId} onSelect={openExisting} />
            </div>
            <PlannerSplitter
              orientation={filters.orientation}
              value={splitPct}
              onChange={setSplitPct}
            />
            <div style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
              <GanttPanel spec={ganttSpec} svgMarkup={ganttSvg} selectedItemId={selectedItemId} onSelect={openExisting} zoom={zoom} onZoom={setZoom} />
            </div>
          </div>
        )}
      </main>

      {editorState && (
        <WorkDetail
          item={editorState.draft}
          isNew={editorState.isNew}
          allItems={items}
          members={members}
          onClose={() => setEditorState(null)}
          onSave={async (draft) => {
            const saved = await saveDraft(draft, editorState.isNew);
            setEditorState(null);
            setSelectedItemId(saved.id);
          }}
          onSaveAndCreateDependency={async (draft) => {
            const saved = await saveDraft(draft, editorState.isNew);
            const dependency = {
              ...defaultItem(currentUserEmail, "task"),
              id: makeId("work"),
              title: `Dependency for ${saved.title}`,
              lane: saved.lane || "",
            };
            const updatedSaved = {
              ...saved,
              dependencies: [...new Set([dependency.id, ...saved.dependencies])],
              updatedAt: nowIso(),
            };
            const nextStore = {
              ...store,
              items: [
                dependency,
                updatedSaved,
                ...store.items.filter((item) => item.id !== saved.id),
              ],
            };
            await persist(nextStore);
            setSelectedItemId(dependency.id);
            setEditorState({ draft: { ...dependency, tags: [...dependency.tags], dependencies: [...dependency.dependencies], attachments: [...dependency.attachments] }, isNew: false });
          }}
          onSaveAndCreateDependent={async (draft) => {
            const saved = await saveDraft(draft, editorState.isNew);
            openNew("task", { lane: saved.lane || "", dependencies: [saved.id] });
          }}
          onDelete={editorState.isNew ? undefined : async (draft) => { await deleteItem(draft); }}
          onDuplicate={() => duplicateItem(editorState.draft)}
          onUpload={async (draft, files) => {
            const nextDraft = await uploadAttachments(draft, files);
            setEditorState((current) => current ? { ...current, draft: nextDraft } : current);
          }}
          onDownload={downloadAttachment}
          onRemoveAttachment={async (draft, attachment) => {
            const nextDraft = await removeAttachment(draft, attachment);
            setEditorState((current) => current ? { ...current, draft: nextDraft } : current);
          }}
        />
      )}
    </div>
  );
}

function TaskPanel({
  items,
  selectedItemId,
  onSelect,
}: {
  items: WorkItem[];
  selectedItemId: string | null;
  onSelect: (itemId: string) => void;
}) {
  const itemIdsKey = useMemo(() => items.map((item) => item.id).sort().join("|"), [items]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => buildTaskLaneGroups(items), [items]);

  useEffect(() => {
    setExpandedIds((current) => {
      const next = new Set(current);
      for (const group of groups) next.add(group.id);
      return next;
    });
  }, [groups, itemIdsKey]);

  const toggleExpanded = useCallback((groupId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const renderItem = useCallback((item: WorkItem): React.ReactNode => {
    return (
      <button key={item.id} onClick={() => onSelect(item.id)} style={itemRowStyle(item, item.id === selectedItemId)}>
        <span style={{ width: 8, height: 62, borderRadius: 99, background: priorityColor(item.priority), flexShrink: 0 }} />
        <span style={{ minWidth: 0, flex: 1, textAlign: "left" }}>
          <span style={{ display: "flex", alignItems: "center", gap: "0.45rem", flexWrap: "wrap" }}>
            <strong style={{ fontSize: "0.95rem" }}>{item.title}</strong>
            <Badge color={kindColor(item.kind)}>{item.kind}</Badge>
            <Badge color={statusColor(item.status)}>{item.status}</Badge>
            {item.kind !== "milestone" && Math.max(0, item.durationDays ?? 0) === 0 && <Badge color="#93c5fd">task list</Badge>}
          </span>
          <span style={{ display: "block", marginTop: "0.25rem", color: C.muted, fontSize: "0.78rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.description || item.notes || "No description yet"}
          </span>
          <span style={{ display: "block", marginTop: "0.3rem", color: C.muted, fontSize: "0.73rem" }}>
            {itemTimeLabel(item)} · {item.progress}% · {item.dependencies.length} deps
          </span>
        </span>
      </button>
    );
  }, [onSelect, selectedItemId]);

  const renderGroup = useCallback((group: TaskLaneGroup): React.ReactNode => {
    const expanded = expandedIds.has(group.id);
    return (
      <React.Fragment key={group.id}>
        <div style={{ display: "flex", alignItems: "stretch", gap: "0.35rem" }}>
          <button
            type="button"
            aria-label={expanded ? "Collapse task group" : "Expand task group"}
            onClick={() => toggleExpanded(group.id)}
            style={{
              width: 24,
              alignSelf: "stretch",
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              background: C.panel2,
              color: C.text,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {expanded ? "-" : "+"}
          </button>
          <div style={{
            flex: 1,
            minWidth: 0,
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            background: C.panel2,
            color: C.text,
            padding: "0.8rem 0.95rem",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
              <strong style={{ fontSize: "0.95rem" }}>{group.title}</strong>
              <span style={{ color: C.muted, fontSize: "0.76rem" }}>{group.items.length} item{group.items.length === 1 ? "" : "s"}</span>
            </div>
          </div>
        </div>
        {expanded && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
            {group.items.length ? group.items.map((item) => (
              <div key={item.id} style={{ marginLeft: 30 }}>
                {renderItem(item)}
              </div>
            )) : (
              <div style={{ color: C.muted, fontSize: "0.78rem", padding: "0.25rem 0.3rem" }}>No tasks in this group.</div>
            )}
          </div>
        )}
      </React.Fragment>
    );
  }, [expandedIds, renderItem, toggleExpanded]);

  return (
    <section style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", border: `1px solid ${C.border}`, borderRadius: 14, background: C.panel, overflow: "hidden" }}>
      <header style={{ padding: "0.9rem 1rem", borderBottom: `1px solid ${C.border}`, background: C.panel2, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 700 }}>Tasks</div>
          <div style={{ marginTop: "0.15rem", color: C.muted, fontSize: "0.78rem" }}>Lane-based task groups ordered by dependency flow.</div>
        </div>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <button onClick={() => setExpandedIds(new Set(groups.map((group) => group.id)))} style={miniButton()}>Expand</button>
          <button onClick={() => setExpandedIds(new Set())} style={miniButton()}>Collapse</button>
        </div>
      </header>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0.7rem", display: "flex", flexDirection: "column", gap: "0.55rem" }}>
        {groups.length ? groups.map((group) => renderGroup(group)) : (
          <div style={{ color: C.muted, fontSize: "0.82rem", padding: "0.3rem" }}>Add work items to create grouped task lanes.</div>
        )}
      </div>
    </section>
  );
}

type TaskLaneGroup = {
  id: string;
  title: string;
  items: WorkItem[];
};

function isTaskListOnly(item: WorkItem): boolean {
  return item.kind !== "milestone" && Math.max(0, item.durationDays ?? 0) === 0;
}

function compareTaskPanelItems(a: WorkItem, b: WorkItem): number {
  const aTaskListOnly = isTaskListOnly(a) ? 1 : 0;
  const bTaskListOnly = isTaskListOnly(b) ? 1 : 0;
  if (aTaskListOnly !== bTaskListOnly) return aTaskListOnly - bTaskListOnly;
  const kindCompare = kindRank(a.kind) - kindRank(b.kind);
  if (kindCompare) return kindCompare;
  const aTime = a.startAt ?? a.createdAt;
  const bTime = b.startAt ?? b.createdAt;
  return aTime.localeCompare(bTime) || a.title.localeCompare(b.title);
}

function sortLaneItems(items: WorkItem[]): WorkItem[] {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const predecessorsById = new Map<string, Set<string>>();
  const dependentsById = new Map<string, Set<string>>();

  for (const item of items) {
    const predecessors = new Set(
      item.dependencies.filter((depId) => {
        const dep = itemsById.get(depId);
        return Boolean(dep && (dep.lane?.trim() || "") === (item.lane?.trim() || ""));
      })
    );
    predecessorsById.set(item.id, predecessors);
    for (const depId of predecessors) {
      if (!dependentsById.has(depId)) dependentsById.set(depId, new Set());
      dependentsById.get(depId)!.add(item.id);
    }
  }

  const emitted = new Set<string>();
  const ready = items.filter((item) => (predecessorsById.get(item.id)?.size ?? 0) === 0).sort(compareTaskPanelItems);
  const result: WorkItem[] = [];
  let previousId: string | null = null;

  const takeNextReady = (): WorkItem | undefined => {
    if (previousId) {
      const dependencyId = previousId;
      const continuation = ready
        .filter((item) => predecessorsById.get(item.id)?.has(dependencyId))
        .sort(compareTaskPanelItems)[0];
      if (continuation) {
        ready.splice(ready.findIndex((item) => item.id === continuation.id), 1);
        return continuation;
      }
    }

    ready.sort(compareTaskPanelItems);
    return ready.shift();
  };

  while (ready.length) {
    const next = takeNextReady();
    if (!next) break;
    result.push(next);
    emitted.add(next.id);
    previousId = next.id;

    for (const dependentId of dependentsById.get(next.id) ?? []) {
      if (emitted.has(dependentId) || ready.some((item) => item.id === dependentId)) continue;
      const predecessors = predecessorsById.get(dependentId) ?? new Set<string>();
      if ([...predecessors].every((predecessorId) => emitted.has(predecessorId))) {
        const dependent = itemsById.get(dependentId);
        if (dependent) ready.push(dependent);
      }
    }
  }

  const unresolved = items.filter((item) => !emitted.has(item.id)).sort(compareTaskPanelItems);
  return [...result, ...unresolved];
}

function buildTaskLaneGroups(items: WorkItem[]): TaskLaneGroup[] {
  const lanes = new Map<string, WorkItem[]>();
  for (const item of items) {
    const lane = item.lane?.trim() || "Ungrouped";
    if (!lanes.has(lane)) lanes.set(lane, []);
    lanes.get(lane)!.push(item);
  }

  return [...lanes.entries()]
    .sort(([a], [b]) => laneRank(a).localeCompare(laneRank(b)))
    .map(([lane, laneItems]) => ({
      id: `lane:${lane}`,
      title: lane,
      items: sortLaneItems(laneItems),
    }));
}

function PlannerSplitter({
  orientation,
  value,
  onChange,
}: {
  orientation: SplitOrientation;
  value: number;
  onChange: React.Dispatch<React.SetStateAction<number>>;
}) {
  const dragRef = useRef<{
    pointerId: number;
    startClient: number;
    startValue: number;
    totalSize: number;
  } | null>(null);
  const isHorizontal = orientation === "horizontal";

  const startDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const totalSize = isHorizontal ? rect.width : rect.height;
    if (totalSize <= 0) return;

    dragRef.current = {
      pointerId: event.pointerId,
      startClient: isHorizontal ? event.clientX : event.clientY,
      startValue: value,
      totalSize,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [isHorizontal, value]);

  const updateDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const currentClient = isHorizontal ? event.clientX : event.clientY;
    const deltaPct = ((currentClient - drag.startClient) / drag.totalSize) * 100;
    onChange(clampSplitPct(Math.round((drag.startValue + deltaPct) * 10) / 10));
  }, [isHorizontal, onChange]);

  const stopDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  }, []);

  return (
    <button
      type="button"
      aria-label={isHorizontal ? "Resize task and Gantt columns" : "Resize task and Gantt rows"}
      title={isHorizontal ? "Drag to resize task and Gantt columns" : "Drag to resize task and Gantt rows"}
      onPointerDown={startDrag}
      onPointerMove={updateDrag}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      onDoubleClick={() => onChange(DEFAULT_SPLIT_PCT)}
      style={{
        flex: "0 0 auto",
        width: isHorizontal ? 14 : "100%",
        height: isHorizontal ? "100%" : 14,
        border: "none",
        padding: 0,
        margin: isHorizontal ? "0 0.5rem" : "0.5rem 0",
        background: "transparent",
        cursor: isHorizontal ? "col-resize" : "row-resize",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        touchAction: "none",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "block",
          width: isHorizontal ? 4 : 52,
          height: isHorizontal ? 52 : 4,
          borderRadius: 999,
          background: C.border,
          boxShadow: `0 0 0 1px ${C.panel2}`,
        }}
      />
    </button>
  );
}

function GanttPanel({
  spec,
  svgMarkup,
  selectedItemId,
  onSelect,
  zoom,
  onZoom,
}: {
  spec: ChartSpec | null;
  svgMarkup: string | null;
  selectedItemId: string | null;
  onSelect: (itemId: string) => void;
  zoom: number;
  onZoom: React.Dispatch<React.SetStateAction<number>>;
}) {
  const labelsRef = useRef<HTMLDivElement>(null);

  const onTimelineScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (!labelsRef.current) return;
    labelsRef.current.scrollTop = event.currentTarget.scrollTop;
  }, []);

  const groupMeta = useMemo(() => {
    if (!spec) return [];
    return spec.rows.map((row, index) => {
      const previous = spec.rows[index - 1];
      const next = spec.rows[index + 1];
      return {
        row,
        firstInGroup: !previous || previous.lane !== row.lane,
        lastInGroup: !next || next.lane !== row.lane,
      };
    });
  }, [spec]);

  return (
    <section style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", border: `1px solid ${C.border}`, borderRadius: 14, background: C.panel, overflow: "hidden" }}>
      <header style={{ padding: "0.9rem 1rem", borderBottom: `1px solid ${C.border}`, background: C.panel2, display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 700 }}>Gantt Schedule</div>
          <div style={{ marginTop: "0.15rem", color: C.muted, fontSize: "0.78rem" }}>Scroll the chart normally; use the controls to zoom the time scale.</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", color: C.muted, fontSize: "0.78rem" }}>
          <button onClick={() => onZoom((current) => Math.max(0.1, Number((current - 0.12).toFixed(2))))} style={miniButton()}>-</button>
          <input
            aria-label="Gantt zoom"
            type="range"
            min={0.1}
            max={4}
            step={0.05}
            value={zoom}
            onChange={(event) => onZoom(Number(event.target.value))}
            style={{ width: 150 }}
          />
          <button onClick={() => onZoom((current) => Math.min(4, Number((current + 0.12).toFixed(2))))} style={miniButton()}>+</button>
          <span style={{ minWidth: 48, textAlign: "right" }}>{Math.round(zoom * 100)}%</span>
        </div>
      </header>
      <div style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
        {!spec || !svgMarkup ? (
          <EmptyInline text="Tasks without dates stay out of the gantt. Add a start or end date to schedule them." />
        ) : (
          <>
            <div style={{ width: 320, flexShrink: 0, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", background: C.panel2 }}>
              <div style={{ height: spec.headerHeight, display: "grid", gridTemplateColumns: "110px 1fr", alignItems: "center", borderBottom: `1px solid ${C.border}`, fontSize: "0.76rem", fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                <div style={{ padding: "0 0.75rem" }}>Group</div>
                <div style={{ padding: "0 0.75rem" }}>Task</div>
              </div>
              <div ref={labelsRef} style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                {groupMeta.map(({ row, firstInGroup, lastInGroup }, index) => (
                  <div
                    key={row.item.id}
                    onClick={() => onSelect(row.item.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(row.item.id);
                      }
                    }}
                    style={{
                      height: spec.rowHeight,
                      display: "grid",
                      gridTemplateColumns: "110px 1fr",
                      alignItems: "stretch",
                      borderBottom: `1px solid ${C.border}`,
                      borderTop: firstInGroup ? `2px solid ${row.item.id === selectedItemId ? C.accent : "#28415f"}` : undefined,
                      background: row.item.id === selectedItemId ? "rgba(59,130,246,0.12)" : index % 2 === 0 ? C.panel : "#0a1322",
                      color: C.text,
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ padding: "0.55rem 0.6rem", borderRight: `1px solid ${C.border}`, display: "flex", alignItems: "center", color: firstInGroup ? "#cbd5e1" : "transparent", fontSize: "0.78rem", fontWeight: firstInGroup ? 700 : 500, background: firstInGroup ? "rgba(148,163,184,0.06)" : "transparent" }}>
                      {firstInGroup ? row.lane : ""}
                    </div>
                    <div style={{ padding: "0.45rem 0.7rem", display: "flex", flexDirection: "column", justifyContent: "center", textAlign: "left" }}>
                      <strong style={{ fontSize: "0.86rem" }}>{row.item.title}</strong>
                      <span style={{ color: C.muted, fontSize: "0.72rem" }}>{row.item.kind} · {row.item.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "auto" }} onScroll={onTimelineScroll}>
              <div style={{ minWidth: "fit-content" }} dangerouslySetInnerHTML={{ __html: svgMarkup }} />
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function buildDependencyCandidates(current: WorkItem, allItems: WorkItem[], query: string): WorkItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  return [...allItems]
    .filter((candidate) => candidate.id !== current.id && !current.dependencies.includes(candidate.id))
    .filter((candidate) => {
      if (!normalizedQuery) return true;
      return [candidate.title, candidate.id, candidate.lane, candidate.description].join(" ").toLowerCase().includes(normalizedQuery);
    })
    .sort((a, b) => {
      const aSameLane = (a.lane || "") === (current.lane || "");
      const bSameLane = (b.lane || "") === (current.lane || "");
      if (aSameLane !== bSameLane) return aSameLane ? -1 : 1;
      const aMilestoneBonus = current.kind === "milestone" && a.kind === "milestone";
      const bMilestoneBonus = current.kind === "milestone" && b.kind === "milestone";
      if (aMilestoneBonus !== bMilestoneBonus) return aMilestoneBonus ? -1 : 1;
      const laneCompare = laneRank(a.lane).localeCompare(laneRank(b.lane));
      if (laneCompare) return laneCompare;
      const kindCompare = kindRank(a.kind) - kindRank(b.kind);
      if (kindCompare) return kindCompare;
      return a.title.localeCompare(b.title);
    });
}

function WorkDetail({
  item,
  isNew,
  allItems,
  members,
  onClose,
  onSave,
  onSaveAndCreateDependency,
  onSaveAndCreateDependent,
  onDelete,
  onDuplicate,
  onUpload,
  onDownload,
  onRemoveAttachment,
}: {
  item: WorkItem;
  isNew: boolean;
  allItems: WorkItem[];
  members: ProjectMember[];
  onClose: () => void;
  onSave: (draft: WorkItem) => Promise<void>;
  onSaveAndCreateDependency: (draft: WorkItem) => Promise<void>;
  onSaveAndCreateDependent: (draft: WorkItem) => Promise<void>;
  onDelete?: (draft: WorkItem) => Promise<void>;
  onDuplicate: () => void;
  onUpload: (draft: WorkItem, files: FileList | null) => Promise<void>;
  onDownload: (attachment: WorkAttachment) => Promise<void>;
  onRemoveAttachment: (draft: WorkItem, attachment: WorkAttachment) => Promise<void>;
}) {
  const [draft, setDraft] = useState<WorkItem>({ ...item, tags: [...item.tags], dependencies: [...item.dependencies], attachments: [...item.attachments] });
  const [tagDraft, setTagDraft] = useState(item.tags.join(", "));
  const [dependencyQuery, setDependencyQuery] = useState("");

  useEffect(() => {
    setDraft({ ...item, tags: [...item.tags], dependencies: [...item.dependencies], attachments: [...item.attachments] });
    setTagDraft(item.tags.join(", "));
    setDependencyQuery("");
  }, [item]);

  const dependencyCandidates = useMemo(() => buildDependencyCandidates(draft, allItems, dependencyQuery), [allItems, dependencyQuery, draft]);
  const selectedDependencies = useMemo(() => draft.dependencies.map((id) => allItems.find((candidate) => candidate.id === id)).filter(Boolean) as WorkItem[], [allItems, draft.dependencies]);

  const setField = useCallback(<K extends keyof WorkItem>(key: K, value: WorkItem[K]) => {
    setDraft((current) => ({ ...current, [key]: value, updatedAt: nowIso() }));
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 950, background: "rgba(3,8,15,0.62)", display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem" }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section style={{ width: "min(1120px, 96vw)", maxHeight: "92vh", display: "flex", flexDirection: "column", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 18, boxShadow: "0 24px 80px rgba(0,0,0,0.55)", overflow: "hidden" }}>
        <header style={{ padding: "1rem 1.15rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", borderBottom: `1px solid ${C.border}`, background: C.panel2 }}>
          <input value={draft.title} onChange={(e) => setField("title", e.target.value)} style={{ ...inputStyle(), fontSize: "1.2rem", fontWeight: 700, border: "none", background: "transparent", padding: 0 }} />
          <div style={{ display: "flex", gap: "0.45rem", alignItems: "center" }}>
            <button onClick={() => void onSave(draft)} style={primaryButton()}>Save</button>
            <button onClick={onClose} style={iconButton()}>x</button>
          </div>
        </header>

        <div style={{ padding: "1rem 1.15rem", overflowY: "auto", display: "grid", gridTemplateColumns: "1fr 360px", gap: "1rem" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
            <label style={labelStyle()}>Description
              <textarea value={draft.description} onChange={(e) => setField("description", e.target.value)} rows={5} style={textAreaStyle()} />
            </label>
            <label style={labelStyle()}>Notes
              <textarea value={draft.notes} onChange={(e) => setField("notes", e.target.value)} rows={7} style={textAreaStyle()} />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
              <label style={labelStyle()}>Start date
                <input type="date" value={formatDateInput(draft.startAt)} onChange={(e) => setField("startAt", toIsoDate(e.target.value))} style={inputStyle()} />
              </label>
              <label style={labelStyle()}>Duration (days)
                <input type="number" min={0} value={draft.kind === "milestone" ? 0 : (draft.durationDays ?? 0)} onChange={(e) => setField("durationDays", draft.kind === "milestone" ? 0 : Math.max(0, Number(e.target.value) || 0))} style={inputStyle()} />
              </label>
              <label style={labelStyle()}>Location
                <input value={draft.location ?? ""} onChange={(e) => setField("location", e.target.value || undefined)} placeholder="Lab, vehicle bay, remote..." style={inputStyle()} />
              </label>
              <label style={labelStyle()}>Lane / group
                <input value={draft.lane ?? ""} onChange={(e) => setField("lane", e.target.value || undefined)} placeholder="Validation, field, build..." style={inputStyle()} />
              </label>
              <label style={labelStyle()}>Progress %
                <input type="number" min={0} max={100} value={draft.progress} onChange={(e) => setField("progress", Math.max(0, Math.min(100, Number(e.target.value) || 0)))} style={inputStyle()} />
              </label>
            </div>
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, padding: "0.8rem", background: C.panel2 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
                <div style={{ color: C.text, fontWeight: 700 }}>Dependencies</div>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <button onClick={() => void onSaveAndCreateDependency(draft)} style={ghostButton()}>Add New Dependency</button>
                  <button onClick={() => void onSaveAndCreateDependent(draft)} style={ghostButton()}>Add Dependent Task</button>
                </div>
              </div>
              <input value={dependencyQuery} onChange={(e) => setDependencyQuery(e.target.value)} placeholder="Search tasks, milestones, lanes..." style={{ ...inputStyle(), marginTop: "0.65rem" }} />
              <div style={{ marginTop: "0.7rem", display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                {selectedDependencies.length === 0 ? <span style={{ color: C.muted, fontSize: "0.82rem" }}>No dependencies yet.</span> : selectedDependencies.map((dependency) => (
                  <button key={dependency.id} onClick={() => setField("dependencies", draft.dependencies.filter((id) => id !== dependency.id))} style={miniChip(true)}>
                    {dependency.title} x
                  </button>
                ))}
              </div>
              <div style={{ marginTop: "0.7rem", maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                {dependencyCandidates.slice(0, 20).map((candidate) => (
                  <button key={candidate.id} onClick={() => setField("dependencies", [...draft.dependencies, candidate.id])} style={candidateRowStyle()}>
                    <strong>{candidate.title}</strong>
                    <span style={{ color: C.muted, fontSize: "0.74rem" }}>{candidate.kind} · {candidate.lane || "Default"} · {candidate.id}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ marginBottom: "0.45rem", color: C.muted, fontSize: "0.78rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>Attachments</div>
              <input type="file" multiple onChange={(e) => void onUpload(draft, e.target.files)} style={{ ...inputStyle(), marginBottom: "0.6rem" }} />
              {draft.attachments.length === 0 ? (
                <p style={{ margin: 0, color: C.muted, fontSize: "0.82rem" }}>No attachments yet.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                  {draft.attachments.map((attachment) => (
                    <div key={attachment.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", border: `1px solid ${C.border}`, borderRadius: 8, padding: "0.45rem 0.6rem" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.82rem" }}>{attachment.name}</span>
                      <span style={{ display: "flex", gap: "0.35rem", flexShrink: 0 }}>
                        <button onClick={() => void onDownload(attachment)} style={miniButton()}>Download</button>
                        <button onClick={() => void onRemoveAttachment(draft, attachment)} style={miniButton(C.danger)}>Remove</button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <aside style={{ display: "flex", flexDirection: "column", gap: "0.8rem" }}>
            <label style={labelStyle()}>Kind
              <select value={draft.kind} onChange={(e) => setField("kind", e.target.value as WorkKind)} style={inputStyle()}>
                {KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
            </label>
            <label style={labelStyle()}>Status
              <select value={draft.status} onChange={(e) => setField("status", e.target.value as WorkStatus)} style={inputStyle()}>
                {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
            <label style={labelStyle()}>Priority
              <select value={draft.priority} onChange={(e) => setField("priority", e.target.value as WorkPriority)} style={inputStyle()}>
                {PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
              </select>
            </label>
            <label style={labelStyle()}>Assignee
              <select value={draft.assignee ?? ""} onChange={(e) => setField("assignee", e.target.value || undefined)} style={inputStyle()}>
                <option value="">Unassigned</option>
                {members.map((member) => <option key={member.email} value={member.email}>{member.email}{member.role ? ` (${member.role})` : ""}</option>)}
              </select>
            </label>
            <label style={labelStyle()}>Tags
              <input value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} onBlur={() => setField("tags", tagDraft.split(",").map((tag) => tag.trim()).filter(Boolean))} placeholder="test, hardware, release" style={inputStyle()} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: C.text, fontSize: "0.86rem" }}>
              <input type="checkbox" checked={draft.repeatable} onChange={(e) => setField("repeatable", e.target.checked)} />
              Repeatable / reusable item
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: C.text, fontSize: "0.86rem" }}>
              <input type="checkbox" checked={draft.allDay} onChange={(e) => setField("allDay", e.target.checked)} />
              All day
            </label>
            <div style={{ color: C.muted, fontSize: "0.75rem", lineHeight: 1.6 }}>
              Created {new Date(draft.createdAt).toLocaleString()}<br />
              Updated {new Date(draft.updatedAt).toLocaleString()}<br />
              {draft.createdBy && <>By {draft.createdBy}</>}
            </div>
            {onDelete && <button onClick={() => void onDelete(draft)} style={dangerButton()}>Delete</button>}
            <button onClick={onDuplicate} style={ghostButton()}>Duplicate</button>
          </aside>
        </div>
      </section>
    </div>
  );
}

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return <span style={{ border: `1px solid ${color}`, color, borderRadius: 999, padding: "0.1rem 0.45rem", fontSize: "0.68rem", fontWeight: 700 }}>{children}</span>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: C.muted }}>{children}</div>;
}

function EmptyInline({ text }: { text: string }) {
  return <div style={{ padding: "1rem", color: C.muted, fontSize: "0.82rem" }}>{text}</div>;
}

function priorityColor(priority: WorkPriority): string {
  return priority === "urgent" ? C.danger : priority === "high" ? C.warning : priority === "low" ? C.muted : C.accent;
}

function statusColor(status: WorkStatus): string {
  return status === "done" ? C.ok : status === "blocked" ? C.danger : status === "archived" ? C.muted : C.accent;
}

function kindColor(kind: WorkKind): string {
  return kind === "event" ? "#38bdf8" : kind === "milestone" ? "#c084fc" : kind === "task-event" ? "#34d399" : C.accent;
}

function itemRowStyle(item: WorkItem, selected = false): React.CSSProperties {
  return {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.85rem",
    border: `1px solid ${selected ? C.accent : C.border}`,
    borderRadius: 10,
    background: item.status === "archived" ? C.archived : selected ? "rgba(59,130,246,0.12)" : C.panel,
    color: C.text,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

function miniChip(removable = false): React.CSSProperties {
  return {
    border: `1px solid ${C.accent}`,
    borderRadius: 999,
    background: removable ? "rgba(59,130,246,0.1)" : "transparent",
    color: C.text,
    padding: "0.28rem 0.55rem",
    cursor: "pointer",
    fontSize: "0.78rem",
  };
}

function candidateRowStyle(): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "0.15rem",
    textAlign: "left",
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    background: "transparent",
    color: C.text,
    padding: "0.5rem 0.6rem",
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

function inputStyle(): React.CSSProperties {
  return { width: "100%", boxSizing: "border-box", background: C.input, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, padding: "0.5rem 0.65rem", outline: "none", font: "inherit" };
}

function textAreaStyle(): React.CSSProperties {
  return { ...inputStyle(), resize: "vertical", lineHeight: 1.55 };
}

function labelStyle(): React.CSSProperties {
  return { display: "flex", flexDirection: "column", gap: "0.4rem", color: C.muted, fontSize: "0.78rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" };
}

function primaryButton(): React.CSSProperties {
  return { border: `1px solid ${C.accent}`, borderRadius: 6, background: C.accent, color: C.accentText, padding: "0.5rem 0.85rem", cursor: "pointer", fontWeight: 600, fontFamily: "inherit" };
}

function ghostButton(): React.CSSProperties {
  return { border: `1px solid ${C.border}`, borderRadius: 6, background: "transparent", color: C.text, padding: "0.5rem 0.75rem", cursor: "pointer", fontFamily: "inherit" };
}

function dangerButton(): React.CSSProperties {
  return { ...ghostButton(), borderColor: C.danger, color: C.danger };
}

function miniButton(color = C.text): React.CSSProperties {
  return { border: `1px solid ${C.border}`, borderRadius: 6, background: "transparent", color, padding: "0.25rem 0.45rem", cursor: "pointer", fontSize: "0.72rem" };
}

function iconButton(): React.CSSProperties {
  return { border: `1px solid ${C.border}`, borderRadius: 8, background: "transparent", color: C.muted, cursor: "pointer", fontSize: "1rem", width: 34, height: 34 };
}

export async function onExport(ctx: ExportContext): Promise<void> {
  const storage = getProjectInfo(ctx.config);
  const store = await readOptionalJson<WorkStore>(ctx.s3Client as S3Client, storage.bucket, storage.storeKey);
  if (!store) return;
  await writeStore(ctx.s3Client as S3Client, storage.bucket, `${ctx.projectPrefix}${ctx.config.id}/export/store.json`, store);
}
