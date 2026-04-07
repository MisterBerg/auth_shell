import { useState, useCallback, useRef } from "react";
import type { ModuleProps, ModuleRegistryEntry } from "module-core";
import { useUserProfile, useAwsS3Client, ModulePicker } from "module-core";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { TopBar } from "./TopBar.tsx";
import { ProjectTabs } from "./ProjectTabs.tsx";
import { ProjectDetails } from "./ProjectDetails.tsx";
import { NewProjectDialog } from "./NewProjectDialog.tsx";
import { useMyProjects, useSharedProjects, useCreateProject } from "./useProjects.ts";
import type { CreatedProject } from "./useProjects.ts";
import type { ProjectRecord } from "./types.ts";

/**
 * Jeffspace — the default organizational project launcher.
 *
 * config.meta is expected to carry:
 *   projectsBucket  — bucket where project config.json files live
 */
export default function JeffspaceApp({ config }: ModuleProps) {
  const userProfile = useUserProfile();
  const createProject = useCreateProject();
  const getS3Client = useAwsS3Client();
  const getS3ClientRef = useRef(getS3Client);
  getS3ClientRef.current = getS3Client;

  const userId = userProfile?.email ?? "";
  const projectsBucket = (config.meta?.projectsBucket as string | undefined) ?? config.app.bucket;

  const { projects: myProjects, loading: myLoading, error: myError, reload: reloadMine } = useMyProjects(userId);
  const { projects: sharedProjects, loading: sharedLoading, error: sharedError } = useSharedProjects(userId);

  const [activeTab, setActiveTab] = useState<"mine" | "shared">("mine");
  const [selectedProject, setSelectedProject] = useState<ProjectRecord | undefined>();

  // New project flow: step 1 = name/description dialog, step 2 = module picker
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [pendingProject, setPendingProject] = useState<CreatedProject | undefined>();
  const [assignError, setAssignError] = useState<string | undefined>();

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
    window.dispatchEvent(new Event("shell:navigate"));
  }, []);

  const handleOpenProject = useCallback((project: ProjectRecord) => {
    navigateTo(project.rootBucket, project.rootConfigPath);
  }, [navigateTo]);

  // Step 1: user fills in name + description → create DDB record → show picker
  const handleNewProjectConfirm = useCallback(async (displayName: string, description: string) => {
    const created = await createProject({
      userId,
      displayName,
      description: description || undefined,
      projectsBucket,
    });
    setShowNewDialog(false);
    setPendingProject(created);
    setAssignError(undefined);
  }, [userId, projectsBucket, createProject]);

  // Step 2: user picks a root module → write config.json → navigate
  const handleModuleSelected = useCallback(async (entry: ModuleRegistryEntry) => {
    if (!pendingProject) return;
    setAssignError(undefined);

    const rootConfig = {
      id: pendingProject.projectId,
      app: { bucket: entry.bundleBucket, key: entry.bundlePath },
      meta: { title: pendingProject.displayName },
      resources: [],
      children: [],
    };

    try {
      const s3 = await getS3ClientRef.current(pendingProject.rootBucket);
      await s3.send(new PutObjectCommand({
        Bucket: pendingProject.rootBucket,
        Key: pendingProject.rootConfigPath,
        Body: JSON.stringify(rootConfig, null, 2),
        ContentType: "application/json",
      }));
    } catch (err: unknown) {
      setAssignError(`Failed to save project config: ${(err as Error).message}`);
      return;
    }

    reloadMine();
    setPendingProject(undefined);
    navigateTo(pendingProject.rootBucket, pendingProject.rootConfigPath);
  }, [pendingProject, reloadMine, navigateTo]);

  const handlePickerCancel = useCallback(() => {
    // Project DDB record exists but has no config — user can retry by clicking the project
    // if they want, or we just leave it. For now, dismiss without navigating.
    setPendingProject(undefined);
    setAssignError(undefined);
    reloadMine();
  }, [reloadMine]);

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
          onConfirm={handleNewProjectConfirm}
          onCancel={() => setShowNewDialog(false)}
        />
      )}

      {/* Step 2: module picker shown after project record is created */}
      {pendingProject && (
        <ModulePicker
          onSelect={handleModuleSelected}
          onCancel={handlePickerCancel}
          headerOverride={{
            title: "Choose a starting module",
            subtitle: `For "${pendingProject.displayName}" — pick the root module for this project`,
          }}
          errorMessage={assignError}
        />
      )}
    </div>
  );
}
