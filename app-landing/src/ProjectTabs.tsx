import React from "react";
import type { ProjectRecord } from "./types.ts";

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

type Tab = "mine" | "shared";

type ProjectTabsProps = {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  myProjects: ProjectRecord[];
  myLoading: boolean;
  myError?: string;
  sharedProjects: ProjectRecord[];
  sharedLoading: boolean;
  sharedError?: string;
  selectedProject?: ProjectRecord;
  onSelectProject: (project: ProjectRecord) => void;
};

export function ProjectTabs({
  activeTab,
  onTabChange,
  myProjects,
  myLoading,
  myError,
  sharedProjects,
  sharedLoading,
  sharedError,
  selectedProject,
  onSelectProject,
}: ProjectTabsProps) {
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "mine", label: "My Projects", count: myProjects.length > 0 ? myProjects.length : undefined },
    { id: "shared", label: "Shared with Me", count: sharedProjects.length > 0 ? sharedProjects.length : undefined },
  ];

  const activeList = activeTab === "mine" ? myProjects : sharedProjects;
  const activeLoading = activeTab === "mine" ? myLoading : sharedLoading;
  const activeError = activeTab === "mine" ? myError : sharedError;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Tab buttons */}
      <div
        style={{
          display: "flex",
          gap: "0",
          borderBottom: "1px solid #1e2d40",
          padding: "0 1.5rem",
          flexShrink: 0,
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            style={{
              padding: "0.75rem 1rem",
              background: "none",
              border: "none",
              borderBottom: activeTab === tab.id ? "2px solid #3b82f6" : "2px solid transparent",
              color: activeTab === tab.id ? "#e5e7eb" : "#6b7280",
              cursor: "pointer",
              fontSize: "0.875rem",
              fontWeight: activeTab === tab.id ? 500 : 400,
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
              marginBottom: "-1px",
            }}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                style={{
                  fontSize: "0.75rem",
                  background: "#1e2d40",
                  color: "#9ca3af",
                  borderRadius: "10px",
                  padding: "0.1rem 0.45rem",
                  fontWeight: 400,
                }}
              >
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: "auto", padding: "1rem 1.5rem" }}>
        {activeLoading && (
          <p style={{ color: "#6b7280", fontSize: "0.875rem" }}>Loading…</p>
        )}
        {activeError && (
          <p style={{ color: "#fca5a5", fontSize: "0.875rem" }}>Error: {activeError}</p>
        )}
        {!activeLoading && !activeError && activeList.length === 0 && (
          <EmptyState tab={activeTab} />
        )}
        {!activeLoading && activeList.map((project) => (
          <ProjectCard
            key={project.projectId}
            project={project}
            isSelected={selectedProject?.projectId === project.projectId}
            onClick={() => onSelectProject(project)}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual project card
// ---------------------------------------------------------------------------

function ProjectCard({
  project,
  isSelected,
  onClick,
}: {
  project: ProjectRecord;
  isSelected: boolean;
  onClick: () => void;
}) {
  const updatedDate = new Date(project.updatedAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "1rem",
        padding: "0.75rem 1rem",
        marginBottom: "0.375rem",
        borderRadius: "8px",
        border: isSelected ? "1px solid #3b82f6" : "1px solid transparent",
        background: isSelected ? "#0f1f35" : "#0f1929",
        cursor: "pointer",
        transition: "border-color 0.1s, background 0.1s",
      }}
      onMouseEnter={(e) => {
        if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = "#111f33";
      }}
      onMouseLeave={(e) => {
        if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = "#0f1929";
      }}
    >
      {/* Thumbnail or placeholder */}
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: "6px",
          background: "#1e2d40",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "1.25rem",
          color: "#374151",
        }}
      >
        {/* TODO: load thumbnail from project.thumbnailKey when set */}
        &#9632;
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "0.9rem",
            fontWeight: 500,
            color: "#e5e7eb",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {project.displayName}
        </div>
        <div
          style={{
            fontSize: "0.775rem",
            color: "#6b7280",
            marginTop: "0.2rem",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {project.description ?? `Updated ${updatedDate}`}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ tab }: { tab: Tab }) {
  if (tab === "shared") {
    return (
      <div style={{ textAlign: "center", marginTop: "3rem", color: "#6b7280" }}>
        <div style={{ fontSize: "2rem", marginBottom: "0.75rem" }}>&#128101;</div>
        <p style={{ fontSize: "0.9rem" }}>No shared projects yet.</p>
        <p style={{ fontSize: "0.8rem", marginTop: "0.25rem" }}>
          Ask a project owner to add you as a collaborator.
        </p>
      </div>
    );
  }

  return (
    <div style={{ textAlign: "center", marginTop: "3rem", color: "#6b7280" }}>
      <div style={{ fontSize: "2rem", marginBottom: "0.75rem" }}>&#128193;</div>
      <p style={{ fontSize: "0.9rem" }}>No projects yet.</p>
      <p style={{ fontSize: "0.8rem", marginTop: "0.25rem" }}>
        Click <strong style={{ color: "#9ca3af" }}>+ New Project</strong> to get started.
      </p>
    </div>
  );
}
