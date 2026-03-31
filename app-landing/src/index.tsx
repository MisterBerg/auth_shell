import React from "react";
import type { ModuleProps } from "module-core";
import { useUserProfile, useAwsDdbClient, useEditMode } from "module-core";

/**
 * app-landing — the default organizational landing page.
 *
 * Loaded by auth-shell when no ?config= URL param is present.
 * Responsibilities:
 *   - Display the authenticated user's profile
 *   - List projects the user owns or has been added to (from DynamoDB org-projects table)
 *   - Each project navigates to ?bucket=...&config=... for that project's root config
 *   - In edit mode, allow creating a new project
 */
export default function LandingApp({ config }: ModuleProps) {
  const userProfile = useUserProfile();
  const getDdbClient = useAwsDdbClient();
  const { editMode } = useEditMode();

  // TODO: fetch projects from DynamoDB org-projects table using getDdbClient()
  // Table: org-projects  PK: userId (OAuth email)  SK: projectId
  void getDdbClient; // will be used when project fetching is implemented
  void config;

  return (
    <div
      style={{
        minHeight: "100vh",
        fontFamily: "system-ui, sans-serif",
        background: "#0b1120",
        color: "#e5e7eb",
        padding: "2rem",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "2rem",
          borderBottom: "1px solid #1e2d40",
          paddingBottom: "1rem",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", margin: 0 }}>Hardware Eval Platform</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {userProfile?.picture && (
            <img
              src={userProfile.picture}
              alt={userProfile.name ?? "User"}
              style={{ width: 36, height: 36, borderRadius: "50%" }}
            />
          )}
          <span style={{ fontSize: "0.9rem", color: "#9ca3af" }}>
            {userProfile?.name ?? userProfile?.email ?? "Signed in"}
          </span>
        </div>
      </div>

      {/* Projects section */}
      <section>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "1rem",
          }}
        >
          <h2 style={{ fontSize: "1.1rem", margin: 0 }}>Projects</h2>
          {editMode && (
            <button
              onClick={() => {
                // TODO: open new-project dialog
                console.info("[landing] new project");
              }}
              style={{
                padding: "0.4rem 0.9rem",
                borderRadius: 6,
                border: "1px solid #3b82f6",
                background: "transparent",
                color: "#3b82f6",
                cursor: "pointer",
                fontSize: "0.85rem",
              }}
            >
              + New Project
            </button>
          )}
        </div>

        {/* Placeholder — replace with fetched project list */}
        <p style={{ color: "#6b7280", fontSize: "0.9rem" }}>
          No projects yet. {editMode ? "Click \"+ New Project\" to get started." : "Ask an owner to add you to a project."}
        </p>
      </section>
    </div>
  );
}
