import React, { useState, useCallback } from "react";
import type { ModuleProps } from "module-core";
import { useUserProfile } from "module-core";
import { TopBar } from "./TopBar.tsx";
import { ProjectTabs } from "./ProjectTabs.tsx";
import { ProjectDetails } from "./ProjectDetails.tsx";
import { NewProjectDialog } from "./NewProjectDialog.tsx";
import { useMyProjects, useSharedProjects, useCreateProject } from "./useProjects.ts";
import type { ProjectRecord } from "./types.ts";

/**
 * Jeffspace — the default organizational project launcher.
 *
 * Loaded by auth-shell when no ?bucket=&config= URL params are present.
 * Full-screen layout with a persistent top bar (Jeffspace-specific chrome).
 *
 * config.meta is expected to carry:
 *   projectsBucket  — bucket where project config.json files live
 */
export default function JeffspaceApp({ config }: ModuleProps) {
  const userProfile = useUserProfile();
  const createProject = useCreateProject();

  const userId = userProfile?.email ?? "";
  const projectsBucket = (config.meta?.projectsBucket as string | undefined) ?? config.app.bucket;

  const { projects: myProjects, loading: myLoading, error: myError, reload: reloadMine } = useMyProjects(userId);
  const { projects: sharedProjects, loading: sharedLoading, error: sharedError } = useSharedProjects(userId);

  const [activeTab, setActiveTab] = useState<"mine" | "shared">("mine");
  const [selectedProject, setSelectedProject] = useState<ProjectRecord | undefined>();
  const [showNewDialog, setShowNewDialog] = useState(false);

  const handleSelectProject = useCallback((project: ProjectRecord) => {
    setSelectedProject((prev) =>
      prev?.projectId === project.projectId ? undefined : project
    );
  }, []);

  const navigateTo = useCallback((bucket: string, configPath: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("bucket", bucket);
    url.searchParams.set("config", configPath);
    history.pushState(null, "", url.toString());
    // Tell the shell to re-read the URL and swap the loaded module
    window.dispatchEvent(new Event("shell:navigate"));
  }, []);

  const handleOpenProject = useCallback((project: ProjectRecord) => {
    navigateTo(project.rootBucket, project.rootConfigPath);
  }, [navigateTo]);

  const handleCreateProject = useCallback(async (displayName: string, description: string) => {
    const created = await createProject({
      userId,
      displayName,
      description: description || undefined,
      projectsBucket,
      registryBucket: config.app.bucket,
    });
    setShowNewDialog(false);
    reloadMine();
    navigateTo(created.rootBucket, created.rootConfigPath);
  }, [userId, projectsBucket, config.app.bucket, createProject, reloadMine, navigateTo]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#080f1c",
        color: "#e5e7eb",
        fontFamily: "system-ui, -apple-system, sans-serif",
        overflow: "hidden",
      }}
    >
      <TopBar
        userProfile={userProfile}
        onNewProject={() => setShowNewDialog(true)}
      />

      {/* Content area — tabs + optional details panel */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <ProjectTabs
          activeTab={activeTab}
          onTabChange={(tab) => {
            setActiveTab(tab);
            setSelectedProject(undefined);
          }}
          myProjects={myProjects}
          myLoading={myLoading}
          myError={myError}
          sharedProjects={sharedProjects}
          sharedLoading={sharedLoading}
          sharedError={sharedError}
          selectedProject={selectedProject}
          onSelectProject={handleSelectProject}
        />

        {selectedProject && (
          <ProjectDetails
            project={selectedProject}
            onOpen={handleOpenProject}
            onClose={() => setSelectedProject(undefined)}
          />
        )}
      </div>

      {showNewDialog && (
        <NewProjectDialog
          onConfirm={handleCreateProject}
          onCancel={() => setShowNewDialog(false)}
        />
      )}
    </div>
  );
}
