import { useEffect, useRef, useState, useCallback } from "react";
import { QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { useAwsDdbClient, useTableNames } from "module-core";
import type { ProjectRecord } from "./types.ts";

// ---------------------------------------------------------------------------
// My Projects — query by userId PK, sort in memory by updatedAt desc
// ---------------------------------------------------------------------------

export function useMyProjects(userId: string | undefined) {
  const getDdbClient = useAwsDdbClient();
  const getDdbClientRef = useRef(getDdbClient);
  useEffect(() => { getDdbClientRef.current = getDdbClient; });
  const { projects: projectsTable } = useTableNames();

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(() => {
    if (!userId) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);

    getDdbClientRef.current()
      .then((ddb) =>
        ddb.send(new QueryCommand({
          TableName: projectsTable,
          KeyConditionExpression: "userId = :uid",
          FilterExpression: "#role = :owner",
          ExpressionAttributeNames: { "#role": "role" },
          ExpressionAttributeValues: { ":uid": userId, ":owner": "owner" },
        }))
      )
      .then((result) => {
        if (cancelled) return;
        const items = (result.Items ?? []) as ProjectRecord[];
        // Sort by updatedAt descending — table SK is projectId so can't rely on DDB ordering
        items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        setProjects(items);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError((err as Error).message);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [userId, projectsTable]);

  useEffect(() => { return load(); }, [load]);

  return { projects, loading, error, reload: load };
}

// ---------------------------------------------------------------------------
// Shared Projects — query via sharedWithUserId GSI, already sorted by updatedAt
// ---------------------------------------------------------------------------

export function useSharedProjects(userId: string | undefined) {
  const getDdbClient = useAwsDdbClient();
  const getDdbClientRef = useRef(getDdbClient);
  useEffect(() => { getDdbClientRef.current = getDdbClient; });
  const { projects: projectsTable } = useTableNames();

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);

    getDdbClientRef.current()
      .then((ddb) =>
        ddb.send(new QueryCommand({
          TableName: projectsTable,
          IndexName: "sharedWithUserId-updatedAt-index",
          KeyConditionExpression: "sharedWithUserId = :uid",
          ExpressionAttributeValues: { ":uid": userId },
          ScanIndexForward: false, // most recent first via GSI SK (updatedAt)
        }))
      )
      .then((result) => {
        if (cancelled) return;
        setProjects((result.Items ?? []) as ProjectRecord[]);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError((err as Error).message);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [userId, projectsTable]);

  return { projects, loading, error };
}

// ---------------------------------------------------------------------------
// Create project — writes only the DynamoDB record.
// The caller (Jeffspace) shows the module picker after this returns, then
// writes the S3 config.json once the user has selected a root module.
// ---------------------------------------------------------------------------

export type CreateProjectArgs = {
  userId: string;
  displayName: string;
  description?: string;
  projectsBucket: string;
};

export type CreatedProject = Pick<
  ProjectRecord,
  "userId" | "projectId" | "rootBucket" | "rootConfigPath" | "displayName" | "description" | "createdAt" | "updatedAt" | "role"
>;

export function useCreateProject() {
  const getDdbClient = useAwsDdbClient();
  const getDdbClientRef = useRef(getDdbClient);
  useEffect(() => { getDdbClientRef.current = getDdbClient; });
  const { projects: projectsTable } = useTableNames();

  return useCallback(async (args: CreateProjectArgs): Promise<CreatedProject> => {
    const { userId, displayName, description, projectsBucket } = args;

    const slug = displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    const projectId = `${slug}-${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const rootConfigPath = `projects/${projectId}/config.json`;

    const record: CreatedProject = {
      userId,
      projectId,
      role: "owner",
      rootBucket: projectsBucket,
      rootConfigPath,
      displayName,
      description,
      createdAt: now,
      updatedAt: now,
    };

    const ddb = await getDdbClientRef.current();
    try {
      await ddb.send(new PutCommand({ TableName: projectsTable, Item: record }));
    } catch (err: unknown) {
      throw new Error(`Failed to create project: ${(err as Error).message}`);
    }

    return record;
  }, [projectsTable]);
}
