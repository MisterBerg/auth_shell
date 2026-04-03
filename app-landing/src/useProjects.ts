import { useEffect, useRef, useState, useCallback } from "react";
import { QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { useAwsDdbClient, useAwsS3Client } from "module-core";
import type { ProjectRecord } from "./types.ts";

const PROJECTS_TABLE = "org-projects";

// ---------------------------------------------------------------------------
// My Projects — query by userId PK, sort in memory by updatedAt desc
// ---------------------------------------------------------------------------

export function useMyProjects(userId: string | undefined) {
  const getDdbClient = useAwsDdbClient();
  const getDdbClientRef = useRef(getDdbClient);
  useEffect(() => { getDdbClientRef.current = getDdbClient; });

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
          TableName: PROJECTS_TABLE,
          KeyConditionExpression: "userId = :uid",
          ExpressionAttributeValues: { ":uid": userId },
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
  }, [userId]);

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
          TableName: PROJECTS_TABLE,
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
  }, [userId]);

  return { projects, loading, error };
}

// ---------------------------------------------------------------------------
// Create project — writes config.json to S3 and a DynamoDB record
// ---------------------------------------------------------------------------

export type CreateProjectArgs = {
  userId: string;
  displayName: string;
  description?: string;
  projectsBucket: string;   // from config.meta.projectsBucket
  registryBucket: string;   // from config.app.bucket (where bundles live)
};

export type CreatedProject = Pick<
  ProjectRecord,
  "userId" | "projectId" | "rootBucket" | "rootConfigPath" | "displayName" | "description" | "createdAt" | "updatedAt" | "role"
>;

export function useCreateProject() {
  const getDdbClient = useAwsDdbClient();
  const getS3Client = useAwsS3Client();
  const getDdbClientRef = useRef(getDdbClient);
  const getS3ClientRef = useRef(getS3Client);
  useEffect(() => {
    getDdbClientRef.current = getDdbClient;
    getS3ClientRef.current = getS3Client;
  });

  return useCallback(async (args: CreateProjectArgs): Promise<CreatedProject> => {
    const { userId, displayName, description, projectsBucket, registryBucket } = args;

    // Derive a URL-safe project ID from the name + timestamp
    const slug = displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    const projectId = `${slug}-${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const rootConfigPath = `projects/${projectId}/config.json`;

    // New projects start with app-empty, which shows a centered + button
    // and opens the module picker. Once the user picks a module, app-empty
    // rewrites this config.json to point at the chosen module.
    const initialConfig = {
      id: projectId,
      app: {
        bucket: registryBucket,
        key: "modules/app-empty/bundle.js",
      },
      meta: { title: displayName },
      resources: [],
      children: [],
    };

    const [s3, ddb] = await Promise.all([
      getS3ClientRef.current(projectsBucket),
      getDdbClientRef.current(),
    ]);

    try {
      await s3.send(new PutObjectCommand({
        Bucket: projectsBucket,
        Key: rootConfigPath,
        Body: JSON.stringify(initialConfig, null, 2),
        ContentType: "application/json",
      }));
    } catch (err: unknown) {
      throw new Error(`S3 write failed: ${(err as Error).message}`);
    }

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

    try {
      await ddb.send(new PutCommand({
        TableName: PROJECTS_TABLE,
        Item: record,
      }));
    } catch (err: unknown) {
      throw new Error(`DynamoDB write failed: ${(err as Error).message}`);
    }

    return record;
  }, []);
}
