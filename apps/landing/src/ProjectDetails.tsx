import React from "react";
import type { ProjectRecord } from "./types.ts";

type ProjectDetailsProps = {
  project: ProjectRecord;
  onOpen: (project: ProjectRecord) => void;
  onClose: () => void;
};

export function ProjectDetails({ project, onOpen, onClose }: ProjectDetailsProps) {
  const createdDate = new Date(project.createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const updatedDate = new Date(project.updatedAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div
      style={{
        width: "300px",
        flexShrink: 0,
        borderLeft: "1px solid #1e2d40",
        background: "#0a1525",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "1rem 1.25rem 0.75rem",
          borderBottom: "1px solid #1e2d40",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Details
        </span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "#6b7280",
            cursor: "pointer",
            fontSize: "1rem",
            padding: "0.1rem 0.3rem",
            borderRadius: "4px",
            lineHeight: 1,
          }}
          title="Close"
        >
          &#x2715;
        </button>
      </div>

      {/* Thumbnail */}
      <div
        style={{
          margin: "1.25rem 1.25rem 0",
          height: "140px",
          borderRadius: "8px",
          background: "#1e2d40",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#374151",
          fontSize: "2.5rem",
          flexShrink: 0,
        }}
      >
        {/* TODO: render <img> when project.thumbnailKey is set */}
        &#9632;
      </div>

      {/* Body */}
      <div style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
        {/* Name */}
        <div>
          <div style={{ fontSize: "1rem", fontWeight: 600, color: "#e5e7eb", lineHeight: 1.3 }}>
            {project.displayName}
          </div>
          {project.ownerEmail && project.role !== "owner" && (
            <div style={{ fontSize: "0.775rem", color: "#6b7280", marginTop: "0.25rem" }}>
              Owned by {project.ownerEmail}
            </div>
          )}
        </div>

        {/* Description */}
        {project.description && (
          <p style={{ margin: 0, fontSize: "0.85rem", color: "#9ca3af", lineHeight: 1.5 }}>
            {project.description}
          </p>
        )}

        {/* Meta table */}
        <dl style={{ margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <MetaRow label="Your role" value={capitalize(project.role)} />
          <MetaRow label="Created" value={createdDate} />
          <MetaRow label="Last updated" value={updatedDate} />
        </dl>

        {/* Open button */}
        <button
          onClick={() => onOpen(project)}
          style={{
            marginTop: "0.5rem",
            padding: "0.6rem 1rem",
            borderRadius: "7px",
            border: "none",
            background: "#2563eb",
            color: "#fff",
            cursor: "pointer",
            fontSize: "0.875rem",
            fontWeight: 500,
            width: "100%",
          }}
        >
          Open Project
        </button>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
      <dt style={{ fontSize: "0.775rem", color: "#6b7280", fontWeight: 400, margin: 0 }}>{label}</dt>
      <dd style={{ fontSize: "0.775rem", color: "#9ca3af", margin: 0, textAlign: "right" }}>{value}</dd>
    </div>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
