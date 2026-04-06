import React, { useState, useEffect, useCallback, useRef } from "react";
import type { ModuleProps, ModuleConfig, UserProfile } from "module-core";
import {
  useUserProfile, useSignOut, useEditMode,
  useAwsS3Client, useAwsDdbClient, useUpdateSlotMeta,
} from "module-core";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECTS_TABLE = "org-projects";
const C = {
  bg:      "#0f1929",
  bgDeep:  "#080f1c",
  border:  "#1e2d40",
  text:    "#e5e7eb",
  muted:   "#6b7280",
  accent:  "#3b82f6",
  danger:  "#ef4444",
};

type Panel = "updates" | "notifications" | "settings" | null;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export default function OAuthBadge({ config }: ModuleProps) {
  const userProfile  = useUserProfile();
  const signOut      = useSignOut();
  const { editMode } = useEditMode();
  const getS3Client  = useAwsS3Client();
  const getDdbClient = useAwsDdbClient();
  const updateSlotMeta = useUpdateSlotMeta(); // null when not inside a SlotContainer

  const homeUrl = (config.meta?.homeUrl as string | undefined) ?? "/";

  const [open,  setOpen]  = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [dropPos, setDropPos] = useState({ top: 0, right: 0 });

  // Home URL inline editing (only in edit mode, only when badge is in a slot)
  const [editingHome, setEditingHome] = useState(false);
  const [homeDraft,   setHomeDraft]   = useState(homeUrl);

  const rootRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close dropdown on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  const openDropdown = useCallback(() => {
    if (rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      setDropPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen((v) => !v);
  }, []);

  const openPanel = useCallback((p: Panel) => {
    setOpen(false);
    setPanel(p);
  }, []);

  const navigateHome = useCallback(() => {
    setOpen(false);
    history.pushState(null, "", homeUrl);
    window.dispatchEvent(new Event("shell:navigate"));
  }, [homeUrl]);

  const saveHomeUrl = useCallback(async () => {
    setEditingHome(false);
    if (!updateSlotMeta || homeDraft === homeUrl) return;
    try { await updateSlotMeta({ homeUrl: homeDraft }); } catch { /* non-fatal */ }
  }, [updateSlotMeta, homeDraft, homeUrl]);

  const name     = userProfile?.name ?? userProfile?.email ?? "User";
  const initials = name.split(" ").map((w) => w[0] ?? "").slice(0, 2).join("").toUpperCase();

  return (
    <div ref={rootRef} style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "0 0.5rem", position: "relative" }}>

      {/* Avatar button */}
      <button
        onClick={openDropdown}
        style={{ display: "flex", alignItems: "center", gap: "0.5rem", background: open ? "rgba(59,130,246,0.1)" : "transparent", border: `1px solid ${open ? C.accent : "transparent"}`, borderRadius: 8, padding: "4px 8px", cursor: "pointer", color: C.text, transition: "background 0.1s" }}
      >
        <Avatar picture={userProfile?.picture} initials={initials} />
        <span style={{ fontSize: "0.8rem", maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
        <span style={{ fontSize: "0.55rem", color: C.muted, marginTop: 1 }}>{open ? "▴" : "▾"}</span>
      </button>

      {/* Dropdown */}
      {open && (
        <Dropdown
          pos={dropPos}
          userProfile={userProfile}
          homeUrl={homeUrl}
          editMode={editMode}
          canEditHome={!!updateSlotMeta}
          editingHome={editingHome}
          homeDraft={homeDraft}
          onHomeDraftChange={setHomeDraft}
          onNavigateHome={navigateHome}
          onStartEditHome={() => { setEditingHome(true); setHomeDraft(homeUrl); }}
          onSaveHome={saveHomeUrl}
          onCancelEditHome={() => setEditingHome(false)}
          onUpdates={() => openPanel("updates")}
          onNotifications={() => openPanel("notifications")}
          onSettings={() => openPanel("settings")}
          onSignOut={() => { setOpen(false); signOut(); }}
        />
      )}

      {/* Side panels */}
      {panel === "updates" && (
        <PlaceholderPanel
          title="Updates"
          icon="🔔"
          description="Project and module update notifications will appear here."
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "notifications" && (
        <PlaceholderPanel
          title="Notifications"
          icon="💬"
          description="Mentions, shares, and collaboration notifications will appear here."
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "settings" && (
        <ProjectSettingsPanel
          userProfile={userProfile}
          getS3Client={getS3Client}
          getDdbClient={getDdbClient}
          onClose={() => setPanel(null)}
          onDeleted={() => {
            setPanel(null);
            history.pushState(null, "", "/");
            window.dispatchEvent(new Event("shell:navigate"));
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

function Avatar({ picture, initials }: { picture?: string; initials: string }) {
  const [imgError, setImgError] = useState(false);
  const showImg = picture && !imgError;
  return (
    <div style={{ width: 30, height: 30, borderRadius: "50%", overflow: "hidden", flexShrink: 0, background: "#1e3a5f", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.7rem", fontWeight: 600, color: "#93c5fd" }}>
      {showImg
        ? <img src={picture} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={() => setImgError(true)} />
        : initials
      }
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dropdown
// ---------------------------------------------------------------------------

type DropdownProps = {
  pos: { top: number; right: number };
  userProfile: UserProfile | undefined;
  homeUrl: string;
  editMode: boolean;
  canEditHome: boolean;
  editingHome: boolean;
  homeDraft: string;
  onHomeDraftChange: (v: string) => void;
  onNavigateHome: () => void;
  onStartEditHome: () => void;
  onSaveHome: () => void;
  onCancelEditHome: () => void;
  onUpdates: () => void;
  onNotifications: () => void;
  onSettings: () => void;
  onSignOut: () => void;
};

function Dropdown({ pos, userProfile, homeUrl, editMode, canEditHome, editingHome, homeDraft, onHomeDraftChange, onNavigateHome, onStartEditHome, onSaveHome, onCancelEditHome, onUpdates, onNotifications, onSettings, onSignOut }: DropdownProps) {
  return (
    <div style={{ position: "fixed", top: pos.top, right: pos.right, width: 260, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.5)", zIndex: 900, overflow: "hidden", fontFamily: "system-ui, -apple-system, sans-serif" }}>

      {/* Identity header */}
      <div style={{ padding: "0.875rem 1rem", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontSize: "0.875rem", fontWeight: 600, color: C.text }}>{userProfile?.name ?? "User"}</div>
        {userProfile?.email && <div style={{ fontSize: "0.75rem", color: C.muted, marginTop: "0.15rem" }}>{userProfile.email}</div>}
      </div>

      {/* Menu items */}
      <div style={{ padding: "0.375rem 0" }}>

        {/* Home */}
        <div style={{ position: "relative" }}>
          {editingHome ? (
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", padding: "0.4rem 1rem" }}>
              <input
                value={homeDraft}
                onChange={(e) => onHomeDraftChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") onSaveHome(); if (e.key === "Escape") onCancelEditHome(); }}
                autoFocus
                placeholder="/"
                style={{ flex: 1, background: "#0a1525", border: `1px solid ${C.accent}`, borderRadius: 4, color: C.text, fontSize: "0.8rem", padding: "3px 6px", outline: "none", fontFamily: "monospace" }}
              />
              <button onClick={onSaveHome} style={tinyBtn("#2563eb", "#fff")}>✓</button>
              <button onClick={onCancelEditHome} style={tinyBtn("transparent", C.muted)}>✕</button>
            </div>
          ) : (
            <MenuItem label="Home" detail={homeUrl !== "/" ? homeUrl : undefined} onClick={onNavigateHome}>
              {editMode && canEditHome && (
                <button onClick={(e) => { e.stopPropagation(); onStartEditHome(); }} title="Edit home URL" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: "0.7rem", padding: "2px 4px", borderRadius: 3 }}>✎</button>
              )}
            </MenuItem>
          )}
        </div>

        <MenuItem label="Updates" onClick={onUpdates} />
        <MenuItem label="Notifications" onClick={onNotifications} />

        <Divider />

        <MenuItem label="Project Settings" onClick={onSettings} />

        <Divider />

        <MenuItem label="Sign out" onClick={onSignOut} danger />
      </div>
    </div>
  );
}

function MenuItem({ label, detail, onClick, danger, children }: { label: string; detail?: string; onClick: () => void; danger?: boolean; children?: React.ReactNode }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0 1rem", background: hovered ? "rgba(255,255,255,0.04)" : "transparent", cursor: "pointer", transition: "background 0.1s" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
    >
      <div style={{ flex: 1, padding: "0.5rem 0", fontSize: "0.85rem", color: danger ? C.danger : C.text }}>
        {label}
        {detail && <span style={{ fontSize: "0.7rem", color: C.muted, marginLeft: "0.5rem", fontFamily: "monospace" }}>{detail}</span>}
      </div>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: C.border, margin: "0.25rem 0" }} />;
}

function tinyBtn(bg: string, color: string): React.CSSProperties {
  return { background: bg, border: `1px solid ${C.border}`, borderRadius: 3, color, cursor: "pointer", fontSize: "0.75rem", padding: "2px 6px", lineHeight: 1.4 };
}

// ---------------------------------------------------------------------------
// Side panel wrapper
// ---------------------------------------------------------------------------

function SidePanel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 800 }} />
      {/* Panel */}
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 400, background: C.bg, borderLeft: `1px solid ${C.border}`, zIndex: 801, display: "flex", flexDirection: "column", fontFamily: "system-ui, -apple-system, sans-serif" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "1rem 1.25rem", borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
          <h2 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600, color: C.text }}>{title}</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: "1.1rem", lineHeight: 1, padding: "2px 6px", borderRadius: 4 }}>✕</button>
        </div>
        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {children}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Placeholder panel (Updates / Notifications)
// ---------------------------------------------------------------------------

function PlaceholderPanel({ title, icon, description, onClose }: { title: string; icon: string; description: string; onClose: () => void }) {
  return (
    <SidePanel title={title} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: "1rem", padding: "2rem", color: C.muted, textAlign: "center" }}>
        <span style={{ fontSize: "2.5rem" }}>{icon}</span>
        <p style={{ margin: 0, fontSize: "0.875rem", lineHeight: 1.6 }}>{description}</p>
        <p style={{ margin: 0, fontSize: "0.775rem", color: "#374151" }}>Coming soon</p>
      </div>
    </SidePanel>
  );
}

// ---------------------------------------------------------------------------
// Project Settings Panel
// ---------------------------------------------------------------------------

type SettingsTab = "share" | "appearance" | "danger";

type RootConfig = ModuleConfig & { theme?: { cssKey?: string; cssBucket?: string } };

type SettingsProps = {
  userProfile: UserProfile | undefined;
  getS3Client: (bucket?: string) => Promise<S3Client>;
  getDdbClient: () => Promise<DynamoDBDocumentClient>;
  onClose: () => void;
  onDeleted: () => void;
};

function ProjectSettingsPanel({ userProfile, getS3Client, getDdbClient, onClose, onDeleted }: SettingsProps) {
  const [tab, setTab] = useState<SettingsTab>("share");
  const [rootConfig, setRootConfig] = useState<RootConfig | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();

  const params = new URLSearchParams(window.location.search);
  const configBucket = params.get("bucket");
  const configPath   = params.get("config");
  const inProject    = !!(configBucket && configPath);

  useEffect(() => {
    if (!inProject) return;
    getS3Client(configBucket!).then((s3) =>
      s3.send(new GetObjectCommand({ Bucket: configBucket!, Key: configPath! }))
    ).then((r) => r.Body!.transformToString("utf-8"))
     .then((text) => setRootConfig(JSON.parse(text) as RootConfig))
     .catch((e: unknown) => setLoadError((e as Error).message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const projectTitle = (rootConfig?.meta?.title as string | undefined) ?? rootConfig?.id ?? "Project";

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: "share",      label: "Share" },
    { id: "appearance", label: "Appearance" },
    { id: "danger",     label: "Danger" },
  ];

  return (
    <SidePanel title={`Settings — ${projectTitle}`} onClose={onClose}>
      {!inProject ? (
        <div style={{ padding: "2rem", color: C.muted, fontSize: "0.875rem" }}>
          Project settings are not available outside a project context.
        </div>
      ) : loadError ? (
        <div style={{ padding: "2rem", color: "#fca5a5", fontSize: "0.85rem" }}>Failed to load project config: {loadError}</div>
      ) : !rootConfig ? (
        <div style={{ padding: "2rem", color: C.muted, fontSize: "0.85rem" }}>Loading…</div>
      ) : (
        <>
          {/* Tab bar */}
          <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
            {tabs.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{ flex: 1, padding: "0.75rem", background: "none", border: "none", borderBottom: `2px solid ${tab === t.id ? C.accent : "transparent"}`, color: tab === t.id ? C.text : C.muted, cursor: "pointer", fontSize: "0.825rem", fontWeight: tab === t.id ? 500 : 400, transition: "color 0.1s", fontFamily: "inherit" }}>
                {t.label}
              </button>
            ))}
          </div>

          <div style={{ padding: "1.25rem" }}>
            {tab === "share" && (
              <ShareTab
                projectId={rootConfig.id}
                projectTitle={projectTitle}
                configBucket={configBucket!}
                configPath={configPath!}
                ownerEmail={userProfile?.email}
                getDdbClient={getDdbClient}
              />
            )}
            {tab === "appearance" && (
              <AppearanceTab
                rootConfig={rootConfig}
                configBucket={configBucket!}
                configPath={configPath!}
                getS3Client={getS3Client}
                onSaved={(updated) => setRootConfig(updated as RootConfig)}
              />
            )}
            {tab === "danger" && (
              <DangerTab
                projectId={rootConfig.id}
                projectTitle={projectTitle}
                ownerEmail={userProfile?.email}
                getDdbClient={getDdbClient}
                onDeleted={onDeleted}
              />
            )}
          </div>
        </>
      )}
    </SidePanel>
  );
}

// ---------------------------------------------------------------------------
// Share Tab
// ---------------------------------------------------------------------------

function ShareTab({ projectId, projectTitle, configBucket, configPath, ownerEmail, getDdbClient }: {
  projectId: string; projectTitle: string; configBucket: string; configPath: string;
  ownerEmail?: string; getDdbClient: () => Promise<DynamoDBDocumentClient>;
}) {
  const [email, setEmail] = useState("");
  const [role,  setRole]  = useState<"editor" | "viewer">("editor");
  const [status, setStatus] = useState<{ type: "ok" | "err"; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const handleShare = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !ownerEmail) return;
    if (trimmed === ownerEmail) { setStatus({ type: "err", msg: "You cannot share a project with yourself." }); return; }

    setBusy(true);
    setStatus(null);
    try {
      const ddb = await getDdbClient();
      await ddb.send(new PutCommand({
        TableName: PROJECTS_TABLE,
        Item: {
          userId: trimmed,
          projectId,
          role,
          rootBucket: configBucket,
          rootConfigPath: configPath,
          displayName: projectTitle,
          sharedWithUserId: trimmed,
          sharedByUserId: ownerEmail,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }));
      setStatus({ type: "ok", msg: `Shared with ${trimmed} as ${role}.` });
      setEmail("");
    } catch (err: unknown) {
      setStatus({ type: "err", msg: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <p style={{ margin: 0, fontSize: "0.825rem", color: C.muted, lineHeight: 1.6 }}>
        Share this project with other users. They will see it in their "Shared with Me" tab in Jeffspace.
      </p>
      <form onSubmit={handleShare} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <label style={labelStyle}>
          <span>Email address</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="colleague@example.com" required disabled={busy} style={inputStyle} />
        </label>
        <label style={labelStyle}>
          <span>Access level</span>
          <select value={role} onChange={(e) => setRole(e.target.value as "editor" | "viewer")} disabled={busy} style={{ ...inputStyle, cursor: "pointer" }}>
            <option value="editor">Editor — can view and modify</option>
            <option value="viewer">Viewer — read only</option>
          </select>
        </label>
        {status && (
          <p style={{ margin: 0, fontSize: "0.8rem", color: status.type === "ok" ? "#86efac" : "#fca5a5" }}>{status.msg}</p>
        )}
        <button type="submit" disabled={busy || !email.trim()} style={primaryBtn(busy || !email.trim())}>
          {busy ? "Sharing…" : "Share"}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appearance Tab
// ---------------------------------------------------------------------------

function AppearanceTab({ rootConfig, configBucket, configPath, getS3Client, onSaved }: {
  rootConfig: RootConfig; configBucket: string; configPath: string;
  getS3Client: (bucket?: string) => Promise<S3Client>; onSaved: (c: RootConfig) => void;
}) {
  const [cssKey, setCssKey] = useState(rootConfig.theme?.cssKey ?? "");
  const [cssBucket, setCssBucket] = useState(rootConfig.theme?.cssBucket ?? configBucket);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ type: "ok" | "err"; msg: string } | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const updated: RootConfig = {
        ...rootConfig,
        theme: cssKey.trim() ? { cssKey: cssKey.trim(), cssBucket: cssBucket.trim() || configBucket } : undefined,
      };
      const s3 = await getS3Client(configBucket);
      await s3.send(new PutObjectCommand({
        Bucket: configBucket,
        Key: configPath,
        Body: JSON.stringify(updated, null, 2),
        ContentType: "application/json",
      }));
      onSaved(updated);
      setStatus({ type: "ok", msg: "Saved. Reload the project to apply the stylesheet." });
    } catch (err: unknown) {
      setStatus({ type: "err", msg: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <p style={{ margin: 0, fontSize: "0.825rem", color: C.muted, lineHeight: 1.6 }}>
        Optionally provide an S3 path to a CSS file that will be loaded for this project.
        Use CSS custom properties (e.g. <code style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>--color-primary</code>) to theme modules.
      </p>
      <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <label style={labelStyle}>
          <span>CSS bucket</span>
          <input value={cssBucket} onChange={(e) => setCssBucket(e.target.value)} placeholder={configBucket} disabled={busy} style={inputStyle} />
        </label>
        <label style={labelStyle}>
          <span>CSS S3 key</span>
          <input value={cssKey} onChange={(e) => setCssKey(e.target.value)} placeholder="styles/theme.css" disabled={busy} style={{ ...inputStyle, fontFamily: "monospace" }} />
        </label>
        {status && (
          <p style={{ margin: 0, fontSize: "0.8rem", color: status.type === "ok" ? "#86efac" : "#fca5a5" }}>{status.msg}</p>
        )}
        <button type="submit" disabled={busy} style={primaryBtn(busy)}>
          {busy ? "Saving…" : "Save"}
        </button>
        {cssKey && (
          <button type="button" disabled={busy} onClick={() => { setCssKey(""); }} style={{ ...primaryBtn(busy), background: "transparent", color: C.muted, border: `1px solid ${C.border}` }}>
            Clear stylesheet
          </button>
        )}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Danger Tab
// ---------------------------------------------------------------------------

function DangerTab({ projectId, projectTitle, ownerEmail, getDdbClient, onDeleted }: {
  projectId: string; projectTitle: string; ownerEmail?: string;
  getDdbClient: () => Promise<DynamoDBDocumentClient>; onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const handleDelete = async () => {
    if (!ownerEmail) return;
    setBusy(true);
    setError(undefined);
    try {
      const ddb = await getDdbClient();
      await ddb.send(new DeleteCommand({
        TableName: PROJECTS_TABLE,
        Key: { userId: ownerEmail, projectId },
      }));
      onDeleted();
    } catch (err: unknown) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <div style={{ border: `1px solid #7f1d1d`, borderRadius: 8, padding: "1rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 600, color: C.danger }}>Delete project</h3>
        <p style={{ margin: 0, fontSize: "0.8rem", color: C.muted, lineHeight: 1.6 }}>
          Removes your access record for <strong style={{ color: C.text }}>{projectTitle}</strong> from the registry.
          The project's S3 files will remain and can be re-linked manually.
          This action cannot be undone.
        </p>
        {!confirming ? (
          <button onClick={() => setConfirming(true)} style={{ padding: "0.45rem 1rem", borderRadius: 6, border: `1px solid ${C.danger}`, background: "transparent", color: C.danger, cursor: "pointer", fontSize: "0.825rem", fontWeight: 500, alignSelf: "flex-start" }}>
            Delete project…
          </button>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <p style={{ margin: 0, fontSize: "0.8rem", color: C.text }}>
              Type <strong>{projectId}</strong> to confirm:
            </p>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={projectId}
              disabled={busy}
              style={{ ...inputStyle, fontFamily: "monospace" }}
            />
            {error && <p style={{ margin: 0, fontSize: "0.8rem", color: "#fca5a5" }}>{error}</p>}
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button
                onClick={handleDelete}
                disabled={busy || confirmText !== projectId}
                style={{ padding: "0.45rem 1rem", borderRadius: 6, border: "none", background: confirmText === projectId && !busy ? C.danger : "#7f1d1d", color: confirmText === projectId && !busy ? "#fff" : "#6b7280", cursor: confirmText === projectId && !busy ? "pointer" : "default", fontSize: "0.825rem", fontWeight: 500 }}
              >
                {busy ? "Deleting…" : "Confirm delete"}
              </button>
              <button onClick={() => { setConfirming(false); setConfirmText(""); }} disabled={busy} style={{ padding: "0.45rem 0.75rem", borderRadius: 6, border: `1px solid ${C.border}`, background: "transparent", color: C.muted, cursor: "pointer", fontSize: "0.825rem" }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared style helpers
// ---------------------------------------------------------------------------

const labelStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: "0.35rem",
  fontSize: "0.775rem", color: "#9ca3af",
};

const inputStyle: React.CSSProperties = {
  padding: "0.45rem 0.65rem",
  borderRadius: 6,
  border: "1px solid #1e3a5f",
  background: "#0a1525",
  color: "#e5e7eb",
  fontSize: "0.875rem",
  outline: "none",
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box",
};

function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: "0.5rem 1rem",
    borderRadius: 6,
    border: "none",
    background: disabled ? "#1e3a5f" : "#2563eb",
    color: disabled ? "#4b5563" : "#fff",
    cursor: disabled ? "default" : "pointer",
    fontSize: "0.875rem",
    fontWeight: 500,
    fontFamily: "inherit",
  };
}
