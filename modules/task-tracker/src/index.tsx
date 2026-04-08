import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExportContext, ModuleProps } from "module-core";
import { useAuthContext, useAwsDdbClient, useAwsS3Client, useUserProfile } from "module-core";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";

type TaskStatus = "open" | "in-progress" | "blocked" | "done" | "archived";
type TaskPriority = "low" | "normal" | "high" | "urgent";

type TaskAttachment = {
  id: string;
  name: string;
  bucket: string;
  key: string;
  size: number;
  contentType?: string;
  uploadedAt: string;
  uploadedBy?: string;
};

type TaskRecord = {
  id: string;
  title: string;
  description: string;
  notes: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee?: string;
  tags: string[];
  repeatable: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  attachments: TaskAttachment[];
};

type TaskStore = {
  version: 1;
  projectId: string;
  tasks: TaskRecord[];
};

type Filters = {
  query: string;
  status: "all" | TaskStatus;
  assignee: "all" | "unassigned" | string;
  tag: string;
  repeatable: "all" | "yes" | "no";
};

type ProjectMember = {
  email: string;
  role?: string;
};

const STATUSES: TaskStatus[] = ["open", "in-progress", "blocked", "done", "archived"];
const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];

const C = {
  bg: "#07111f",
  panel: "#0b1728",
  panel2: "#102035",
  border: "#20324c",
  text: "#e7edf7",
  muted: "#7f8da3",
  accent: "#22a6b3",
  accent2: "#f59e0b",
  danger: "#f87171",
  ok: "#86efac",
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

function getProjectInfo(config: ModuleProps["config"]) {
  const params = new URLSearchParams(window.location.search);
  const configPath = params.get("config") ?? "";
  const projectDir = dirname(configPath);
  const projectIdFromPath = configPath.match(/projects\/([^/]+)\//)?.[1];
  const projectId = projectIdFromPath ?? config.id;
  const bucket = params.get("bucket") ?? config.app.bucket;
  const basePrefix = projectDir ? `${projectDir}/tasks/${config.id}` : `tasks/${config.id}`;
  return {
    bucket,
    projectId,
    basePrefix,
    tasksKey: `${basePrefix}/tasks.json`,
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

async function writeStore(s3: S3Client, bucket: string, key: string, store: TaskStore): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(store, null, 2),
    ContentType: "application/json",
    CacheControl: "no-store",
  }));
}

function defaultTask(userEmail?: string): TaskRecord {
  const at = nowIso();
  return {
    id: makeId("task"),
    title: "New task",
    description: "",
    notes: "",
    status: "open",
    priority: "normal",
    tags: [],
    repeatable: false,
    createdAt: at,
    updatedAt: at,
    createdBy: userEmail,
    attachments: [],
  };
}

function matchesFilters(task: TaskRecord, filters: Filters): boolean {
  const query = filters.query.trim().toLowerCase();
  if (query) {
    const haystack = [task.title, task.description, task.notes, task.assignee, task.tags.join(" ")].join(" ").toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  if (filters.status !== "all" && task.status !== filters.status) return false;
  if (filters.assignee === "unassigned" && task.assignee) return false;
  if (filters.assignee !== "all" && filters.assignee !== "unassigned" && task.assignee !== filters.assignee) return false;
  if (filters.tag && !task.tags.some((tag) => tag.toLowerCase().includes(filters.tag.toLowerCase()))) return false;
  if (filters.repeatable === "yes" && !task.repeatable) return false;
  if (filters.repeatable === "no" && task.repeatable) return false;
  return true;
}

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function TaskTracker({ config }: ModuleProps) {
  const user = useUserProfile();
  const auth = useAuthContext();
  const getS3Client = useAwsS3Client();
  const getDdbClient = useAwsDdbClient();
  const project = useMemo(() => getProjectInfo(config), [config]);

  const [store, setStore] = useState<TaskStore>({ version: 1, projectId: project.projectId, tasks: [] });
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [filters, setFilters] = useState<Filters>({ query: "", status: "all", assignee: "all", tag: "", repeatable: "all" });
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const importRef = useRef<HTMLInputElement>(null);

  const currentUserEmail = user?.email?.toLowerCase();
  const tasks = store.tasks;
  const filteredTasks = useMemo(() => tasks.filter((task) => matchesFilters(task, filters)), [filters, tasks]);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const allTags = useMemo(() => [...new Set(tasks.flatMap((task) => task.tags))].sort(), [tasks]);

  const persist = useCallback(async (nextStore: TaskStore) => {
    setSaving(true);
    setError(undefined);
    try {
      const s3 = await getS3Client(project.bucket);
      await writeStore(s3, project.bucket, project.tasksKey, nextStore);
      setStore(nextStore);
      setMessage("Saved");
    } catch (persistError: unknown) {
      setError((persistError as Error).message);
    } finally {
      setSaving(false);
    }
  }, [getS3Client, project.bucket, project.tasksKey]);

  const patchTask = useCallback((taskId: string, patch: Partial<TaskRecord>) => {
    void persist({
      ...store,
      tasks: store.tasks.map((task) => task.id === taskId ? { ...task, ...patch, updatedAt: nowIso() } : task),
    });
  }, [persist, store]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    getS3Client(project.bucket)
      .then((s3) => readOptionalJson<TaskStore>(s3, project.bucket, project.tasksKey))
      .then((loaded) => {
        if (cancelled) return;
        setStore(loaded ?? { version: 1, projectId: project.projectId, tasks: [] });
        setLoading(false);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError((loadError as Error).message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [getS3Client, project.bucket, project.projectId, project.tasksKey]);

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

  const addTask = useCallback(() => {
    const task = defaultTask(currentUserEmail);
    setSelectedTaskId(task.id);
    void persist({ ...store, tasks: [task, ...store.tasks] });
  }, [currentUserEmail, persist, store]);

  const duplicateTask = useCallback((task: TaskRecord) => {
    const at = nowIso();
    const copy: TaskRecord = { ...task, id: makeId("task"), title: `${task.title} copy`, status: "open", attachments: [], createdAt: at, updatedAt: at, createdBy: currentUserEmail };
    setSelectedTaskId(copy.id);
    void persist({ ...store, tasks: [copy, ...store.tasks] });
  }, [currentUserEmail, persist, store]);

  const deleteTask = useCallback(async (task: TaskRecord) => {
    if (!window.confirm(`Delete "${task.title}"? Attachments will be removed from S3.`)) return;
    setSaving(true);
    try {
      const s3 = await getS3Client(project.bucket);
      await Promise.all(task.attachments.map((attachment) =>
        s3.send(new DeleteObjectCommand({ Bucket: attachment.bucket, Key: attachment.key })).catch(() => undefined)
      ));
      const nextStore = { ...store, tasks: store.tasks.filter((candidate) => candidate.id !== task.id) };
      await writeStore(s3, project.bucket, project.tasksKey, nextStore);
      setStore(nextStore);
      setSelectedTaskId(null);
      setMessage("Task deleted");
    } catch (deleteError: unknown) {
      setError((deleteError as Error).message);
    } finally {
      setSaving(false);
    }
  }, [getS3Client, project.bucket, project.tasksKey, store]);

  const uploadAttachments = useCallback(async (task: TaskRecord, files: FileList | null) => {
    if (!files?.length) return;
    setSaving(true);
    setError(undefined);
    try {
      const s3 = await getS3Client(project.bucket);
      const uploaded: TaskAttachment[] = [];
      for (const file of Array.from(files)) {
        const attachmentId = makeId("att");
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
        const key = `${project.attachmentsPrefix}/${task.id}/${attachmentId}-${safeName}`;
        await s3.send(new PutObjectCommand({
          Bucket: project.bucket,
          Key: key,
          Body: new Uint8Array(await file.arrayBuffer()),
          ContentType: file.type || "application/octet-stream",
          CacheControl: "no-store",
        }));
        uploaded.push({ id: attachmentId, name: file.name, bucket: project.bucket, key, size: file.size, contentType: file.type || undefined, uploadedAt: nowIso(), uploadedBy: currentUserEmail });
      }
      await persist({
        ...store,
        tasks: store.tasks.map((candidate) => candidate.id === task.id ? { ...candidate, attachments: [...candidate.attachments, ...uploaded], updatedAt: nowIso() } : candidate),
      });
    } catch (uploadError: unknown) {
      setError((uploadError as Error).message);
    } finally {
      setSaving(false);
    }
  }, [currentUserEmail, getS3Client, persist, project.attachmentsPrefix, project.bucket, store]);

  const downloadAttachment = useCallback(async (attachment: TaskAttachment) => {
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

  const removeAttachment = useCallback(async (task: TaskRecord, attachment: TaskAttachment) => {
    const s3 = await getS3Client(attachment.bucket);
    await s3.send(new DeleteObjectCommand({ Bucket: attachment.bucket, Key: attachment.key })).catch(() => undefined);
    await persist({
      ...store,
      tasks: store.tasks.map((candidate) => candidate.id === task.id ? { ...candidate, attachments: candidate.attachments.filter((item) => item.id !== attachment.id), updatedAt: nowIso() } : candidate),
    });
  }, [getS3Client, persist, store]);

  const exportFiltered = useCallback(() => {
    downloadJson(`tasks-${project.projectId}-${new Date().toISOString().slice(0, 10)}.json`, { version: 1, sourceProjectId: project.projectId, exportedAt: nowIso(), tasks: filteredTasks });
  }, [filteredTasks, project.projectId]);

  const importTasks = useCallback(async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as { tasks?: TaskRecord[] };
      const imported = (parsed.tasks ?? []).map((task) => {
        const at = nowIso();
        return { ...task, id: makeId("task"), status: "open" as TaskStatus, attachments: [], createdAt: at, updatedAt: at, createdBy: currentUserEmail };
      });
      await persist({ ...store, tasks: [...imported, ...store.tasks] });
      setMessage(`Imported ${imported.length} task${imported.length === 1 ? "" : "s"}`);
    } catch (importError: unknown) {
      setError((importError as Error).message);
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  }, [currentUserEmail, persist, store]);

  if (loading) return <Centered>Loading tasks...</Centered>;

  return (
    <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", background: C.bg, color: C.text, fontFamily: "Aptos, Segoe UI, sans-serif" }}>
      <header style={{ padding: "1rem 1.1rem", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", background: "linear-gradient(135deg,#07111f,#0f2035)" }}>
        <div>
          <div style={{ fontSize: "0.72rem", color: C.accent, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700 }}>Task Tracker</div>
          <h2 style={{ margin: "0.15rem 0 0", fontSize: "1.25rem" }}>{(config.meta?.["title"] as string | undefined) ?? "Project Tasks"}</h2>
          <div style={{ marginTop: "0.25rem", color: C.muted, fontSize: "0.78rem" }}>{filteredTasks.length} of {tasks.length} shown · {project.projectId}</div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={addTask} style={primaryButton()}>+ New Task</button>
          <button onClick={exportFiltered} style={ghostButton()}>Export Filtered</button>
          <button onClick={() => importRef.current?.click()} style={ghostButton()}>Import</button>
          <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => void importTasks(event.target.files?.[0])} />
        </div>
      </header>

      <section style={{ padding: "0.75rem 1rem", borderBottom: `1px solid ${C.border}`, display: "grid", gridTemplateColumns: "minmax(180px, 2fr) repeat(4, minmax(120px, 1fr))", gap: "0.55rem", background: C.panel }}>
        <input value={filters.query} onChange={(e) => setFilters({ ...filters, query: e.target.value })} placeholder="Search title, notes, tags..." style={inputStyle()} />
        <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as Filters["status"] })} style={inputStyle()}>
          <option value="all">All status</option>
          {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
        <select value={filters.assignee} onChange={(e) => setFilters({ ...filters, assignee: e.target.value })} style={inputStyle()}>
          <option value="all">All assignees</option>
          <option value="unassigned">Unassigned</option>
          {members.map((member) => <option key={member.email} value={member.email}>{member.email}</option>)}
        </select>
        <input value={filters.tag} onChange={(e) => setFilters({ ...filters, tag: e.target.value })} placeholder={allTags.length ? `Tags: ${allTags.slice(0, 3).join(", ")}` : "Filter tag"} style={inputStyle()} />
        <select value={filters.repeatable} onChange={(e) => setFilters({ ...filters, repeatable: e.target.value as Filters["repeatable"] })} style={inputStyle()}>
          <option value="all">All task types</option>
          <option value="yes">Repeatable only</option>
          <option value="no">One-off only</option>
        </select>
      </section>

      {(error || message || saving) && (
        <div style={{ padding: "0.45rem 1rem", borderBottom: `1px solid ${C.border}`, color: error ? C.danger : saving ? C.accent2 : C.ok, fontSize: "0.78rem" }}>
          {error ?? (saving ? "Saving..." : message)}
        </div>
      )}

      <main style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0.85rem", display: "flex", flexDirection: "column", gap: "0.55rem" }}>
        {filteredTasks.length === 0 ? (
          <Centered>No tasks match the current filters.</Centered>
        ) : filteredTasks.map((task) => (
          <button key={task.id} onClick={() => setSelectedTaskId(task.id)} style={taskRowStyle(task)}>
            <span style={{ width: 8, height: 48, borderRadius: 99, background: priorityColor(task.priority), flexShrink: 0 }} />
            <span style={{ minWidth: 0, flex: 1, textAlign: "left" }}>
              <span style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <strong style={{ fontSize: "0.95rem" }}>{task.title}</strong>
                {task.repeatable && <Badge color={C.accent}>repeatable</Badge>}
                <Badge color={statusColor(task.status)}>{task.status}</Badge>
              </span>
              <span style={{ marginTop: "0.25rem", display: "block", color: C.muted, fontSize: "0.78rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {task.description || task.notes || "No description yet"}
              </span>
            </span>
            <span style={{ color: C.muted, fontSize: "0.78rem", minWidth: 170, textAlign: "right" }}>
              {task.assignee || "Unassigned"}<br />{task.tags.join(", ") || "no tags"}
            </span>
          </button>
        ))}
      </main>

      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          members={members}
          onClose={() => setSelectedTaskId(null)}
          onPatch={(patch) => patchTask(selectedTask.id, patch)}
          onDuplicate={() => duplicateTask(selectedTask)}
          onDelete={() => void deleteTask(selectedTask)}
          onUpload={(files) => void uploadAttachments(selectedTask, files)}
          onDownload={(attachment) => void downloadAttachment(attachment)}
          onRemoveAttachment={(attachment) => void removeAttachment(selectedTask, attachment)}
        />
      )}
    </div>
  );
}

function TaskDetail({
  task, members, onClose, onPatch, onDuplicate, onDelete, onUpload, onDownload, onRemoveAttachment,
}: {
  task: TaskRecord;
  members: ProjectMember[];
  onClose: () => void;
  onPatch: (patch: Partial<TaskRecord>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onUpload: (files: FileList | null) => void;
  onDownload: (attachment: TaskAttachment) => void;
  onRemoveAttachment: (attachment: TaskAttachment) => void;
}) {
  const [tagDraft, setTagDraft] = useState(task.tags.join(", "));
  useEffect(() => setTagDraft(task.tags.join(", ")), [task.id, task.tags]);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 950, background: "rgba(3,8,15,0.62)", display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem" }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section style={{ width: "min(920px, 96vw)", maxHeight: "92vh", display: "flex", flexDirection: "column", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 18, boxShadow: "0 24px 80px rgba(0,0,0,0.55)", overflow: "hidden" }}>
        <header style={{ padding: "1rem 1.15rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", borderBottom: `1px solid ${C.border}`, background: C.panel2 }}>
          <input value={task.title} onChange={(e) => onPatch({ title: e.target.value })} style={{ ...inputStyle(), fontSize: "1.2rem", fontWeight: 700, border: "none", background: "transparent", padding: 0 }} />
          <button onClick={onClose} style={iconButton()}>x</button>
        </header>

        <div style={{ padding: "1rem 1.15rem", overflowY: "auto", display: "grid", gridTemplateColumns: "1fr 280px", gap: "1rem" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
            <label style={labelStyle()}>Description
              <textarea value={task.description} onChange={(e) => onPatch({ description: e.target.value })} rows={5} style={textAreaStyle()} />
            </label>
            <label style={labelStyle()}>Notes
              <textarea value={task.notes} onChange={(e) => onPatch({ notes: e.target.value })} rows={7} style={textAreaStyle()} />
            </label>
            <div>
              <div style={{ marginBottom: "0.45rem", color: C.muted, fontSize: "0.78rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>Attachments</div>
              <input type="file" multiple onChange={(e) => onUpload(e.target.files)} style={{ ...inputStyle(), marginBottom: "0.6rem" }} />
              {task.attachments.length === 0 ? (
                <p style={{ margin: 0, color: C.muted, fontSize: "0.82rem" }}>No attachments yet.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                  {task.attachments.map((attachment) => (
                    <div key={attachment.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", border: `1px solid ${C.border}`, borderRadius: 8, padding: "0.45rem 0.6rem" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.82rem" }}>{attachment.name}</span>
                      <span style={{ display: "flex", gap: "0.35rem", flexShrink: 0 }}>
                        <button onClick={() => onDownload(attachment)} style={miniButton()}>Download</button>
                        <button onClick={() => onRemoveAttachment(attachment)} style={miniButton(C.danger)}>Remove</button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <aside style={{ display: "flex", flexDirection: "column", gap: "0.8rem" }}>
            <label style={labelStyle()}>Status
              <select value={task.status} onChange={(e) => onPatch({ status: e.target.value as TaskStatus })} style={inputStyle()}>
                {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
            <label style={labelStyle()}>Priority
              <select value={task.priority} onChange={(e) => onPatch({ priority: e.target.value as TaskPriority })} style={inputStyle()}>
                {PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
              </select>
            </label>
            <label style={labelStyle()}>Assignee
              <select value={task.assignee ?? ""} onChange={(e) => onPatch({ assignee: e.target.value || undefined })} style={inputStyle()}>
                <option value="">Unassigned</option>
                {members.map((member) => <option key={member.email} value={member.email}>{member.email}{member.role ? ` (${member.role})` : ""}</option>)}
              </select>
            </label>
            <label style={labelStyle()}>Tags
              <input value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} onBlur={() => onPatch({ tags: tagDraft.split(",").map((tag) => tag.trim()).filter(Boolean) })} placeholder="test, hardware, release" style={inputStyle()} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: C.text, fontSize: "0.86rem" }}>
              <input type="checkbox" checked={task.repeatable} onChange={(e) => onPatch({ repeatable: e.target.checked })} />
              Repeatable / reusable task
            </label>
            <div style={{ color: C.muted, fontSize: "0.75rem", lineHeight: 1.6 }}>
              Created {new Date(task.createdAt).toLocaleString()}<br />
              Updated {new Date(task.updatedAt).toLocaleString()}<br />
              {task.createdBy && <>By {task.createdBy}</>}
            </div>
            <button onClick={onDuplicate} style={ghostButton()}>Duplicate</button>
            <button onClick={onDelete} style={dangerButton()}>Delete Task</button>
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

function priorityColor(priority: TaskPriority): string {
  return priority === "urgent" ? "#ef4444" : priority === "high" ? "#f59e0b" : priority === "low" ? "#64748b" : C.accent;
}

function statusColor(status: TaskStatus): string {
  return status === "done" ? C.ok : status === "blocked" ? C.danger : status === "archived" ? C.muted : C.accent;
}

function taskRowStyle(task: TaskRecord): React.CSSProperties {
  return { width: "100%", display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.85rem", border: `1px solid ${C.border}`, borderRadius: 14, background: task.status === "archived" ? "#08111d" : C.panel, color: C.text, cursor: "pointer" };
}

function inputStyle(): React.CSSProperties {
  return { width: "100%", boxSizing: "border-box", background: "#07111f", border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, padding: "0.5rem 0.65rem", outline: "none", font: "inherit" };
}

function textAreaStyle(): React.CSSProperties {
  return { ...inputStyle(), resize: "vertical", lineHeight: 1.55 };
}

function labelStyle(): React.CSSProperties {
  return { display: "flex", flexDirection: "column", gap: "0.4rem", color: C.muted, fontSize: "0.78rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" };
}

function primaryButton(): React.CSSProperties {
  return { border: "none", borderRadius: 9, background: C.accent, color: "#021015", padding: "0.55rem 0.85rem", cursor: "pointer", fontWeight: 800 };
}

function ghostButton(): React.CSSProperties {
  return { border: `1px solid ${C.border}`, borderRadius: 9, background: "transparent", color: C.text, padding: "0.5rem 0.75rem", cursor: "pointer" };
}

function dangerButton(): React.CSSProperties {
  return { ...ghostButton(), borderColor: "#7f1d1d", color: C.danger };
}

function miniButton(color = C.text): React.CSSProperties {
  return { border: `1px solid ${C.border}`, borderRadius: 6, background: "transparent", color, padding: "0.25rem 0.45rem", cursor: "pointer", fontSize: "0.72rem" };
}

function iconButton(): React.CSSProperties {
  return { border: `1px solid ${C.border}`, borderRadius: 8, background: "transparent", color: C.muted, cursor: "pointer", fontSize: "1rem", width: 34, height: 34 };
}

export async function onExport(ctx: ExportContext): Promise<void> {
  const storage = getProjectInfo(ctx.config);
  const tasks = await readOptionalJson<TaskStore>(ctx.s3Client as S3Client, storage.bucket, storage.tasksKey);
  if (!tasks) return;
  await writeStore(ctx.s3Client as S3Client, storage.bucket, `${ctx.projectPrefix}${ctx.config.id}/export/tasks.json`, tasks);
}
