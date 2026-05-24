import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { AssetRecord, AssetVersionRef } from "./types.ts";

export const MAX_EMBEDDED_ASSET_VERSIONS = 20;

const ASSET_ID_RANDOM_LENGTH = 8;
const VERSION_ID_RANDOM_LENGTH = 4;

export type CreateAssetRecordInput = {
  projectId: string;
  label: string;
  version: Omit<AssetVersionRef, "versionId" | "createdAt"> & {
    versionId?: string;
    createdAt?: string;
  };
  assetId?: string;
  createdAt?: string;
  createdBy?: string;
  meta?: Record<string, unknown>;
};

export type AddAssetVersionInput = {
  asset: AssetRecord;
  version: Omit<AssetVersionRef, "versionId" | "createdAt"> & {
    versionId?: string;
    createdAt?: string;
  };
  updatedAt?: string;
  updatedBy?: string;
  label?: string;
  meta?: Record<string, unknown>;
};

export function createAssetId(): string {
  return `asset_${randomToken(ASSET_ID_RANDOM_LENGTH)}`;
}

export function createAssetVersionId(date = new Date()): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `v_${stamp}_${randomToken(VERSION_ID_RANDOM_LENGTH)}`;
}

export function getAssetSk(assetId: string): `asset#${string}` {
  return `asset#${assetId}`;
}

export function getCurrentAssetVersion(asset: AssetRecord): AssetVersionRef {
  const current = asset.versions[0];
  if (!current) {
    throw new Error(`Asset "${asset.assetId}" has no versions.`);
  }
  return current;
}

export function buildAssetVersionKey(args: {
  projectId: string;
  assetId: string;
  versionId: string;
  filename: string;
}): string {
  return [
    "projects",
    encodePathSegment(args.projectId),
    "assets",
    encodePathSegment(args.assetId),
    "versions",
    encodePathSegment(args.versionId),
    sanitizeAssetFilename(args.filename),
  ].join("/");
}

export function sanitizeAssetFilename(filename: string): string {
  const cleaned = filename
    .trim()
    .replace(/[\\/:*?"<>|#%{}^~[\]`]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .slice(0, 180);

  return cleaned || "asset";
}

export function createAssetRecord(input: CreateAssetRecordInput): AssetRecord {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const assetId = input.assetId ?? createAssetId();
  const version = normalizeVersion(input.version, createdAt, input.createdBy);

  return {
    projectId: input.projectId,
    sk: getAssetSk(assetId),
    assetId,
    label: input.label || assetId,
    versions: [version],
    createdAt,
    updatedAt: createdAt,
    createdBy: input.createdBy,
    updatedBy: input.createdBy,
    meta: input.meta,
  };
}

export function addAssetVersion(input: AddAssetVersionInput): AssetRecord {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const version = normalizeVersion(input.version, updatedAt, input.updatedBy);
  const versions = [version, ...input.asset.versions.filter((v) => v.versionId !== version.versionId)]
    .slice(0, MAX_EMBEDDED_ASSET_VERSIONS);

  return {
    ...input.asset,
    label: input.label ?? input.asset.label,
    versions,
    updatedAt,
    updatedBy: input.updatedBy ?? input.asset.updatedBy,
    meta: input.meta ?? input.asset.meta,
  };
}

export function rollbackAssetVersion(
  asset: AssetRecord,
  versionId: string,
  args: { updatedAt?: string; updatedBy?: string } = {}
): AssetRecord {
  const index = asset.versions.findIndex((version) => version.versionId === versionId);
  if (index < 0) {
    throw new Error(`Asset "${asset.assetId}" does not contain version "${versionId}".`);
  }

  const selected = asset.versions[index]!;
  const versions = [
    selected,
    ...asset.versions.filter((version) => version.versionId !== versionId),
  ];

  return {
    ...asset,
    versions,
    updatedAt: args.updatedAt ?? new Date().toISOString(),
    updatedBy: args.updatedBy ?? asset.updatedBy,
  };
}

export async function getAsset(args: {
  ddb: DynamoDBDocumentClient;
  tableName: string;
  projectId: string;
  assetId: string;
}): Promise<AssetRecord | undefined> {
  const result = await args.ddb.send(new GetCommand({
    TableName: args.tableName,
    Key: {
      projectId: args.projectId,
      sk: getAssetSk(args.assetId),
    },
  }));

  return result.Item as AssetRecord | undefined;
}

export async function listAssets(args: {
  ddb: DynamoDBDocumentClient;
  tableName: string;
  projectId: string;
}): Promise<AssetRecord[]> {
  const assets: AssetRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await args.ddb.send(new QueryCommand({
      TableName: args.tableName,
      KeyConditionExpression: "projectId = :projectId AND begins_with(sk, :assetPrefix)",
      ExpressionAttributeValues: {
        ":projectId": args.projectId,
        ":assetPrefix": "asset#",
      },
      ExclusiveStartKey: lastKey,
    }));

    assets.push(...((result.Items ?? []) as AssetRecord[]));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return assets;
}

export async function putAsset(args: {
  ddb: DynamoDBDocumentClient;
  tableName: string;
  asset: AssetRecord;
}): Promise<void> {
  assertValidAsset(args.asset);
  await args.ddb.send(new PutCommand({
    TableName: args.tableName,
    Item: args.asset,
  }));
}

export async function createAsset(args: {
  ddb: DynamoDBDocumentClient;
  tableName: string;
  asset: AssetRecord;
}): Promise<void> {
  assertValidAsset(args.asset);
  await args.ddb.send(new PutCommand({
    TableName: args.tableName,
    Item: args.asset,
    ConditionExpression: "attribute_not_exists(projectId) AND attribute_not_exists(sk)",
  }));
}

export async function updateAsset(args: {
  ddb: DynamoDBDocumentClient;
  tableName: string;
  asset: AssetRecord;
}): Promise<void> {
  assertValidAsset(args.asset);
  await args.ddb.send(new PutCommand({
    TableName: args.tableName,
    Item: args.asset,
    ExpressionAttributeValues: {
      ":projectId": args.asset.projectId,
      ":sk": args.asset.sk,
    },
    ConditionExpression: "projectId = :projectId AND sk = :sk",
  }));
}

export function getAssetSearchText(asset: AssetRecord, relatedAssets: AssetRecord[] = []): string {
  return [
    asset.assetId,
    asset.label,
    asset.versions.map((version) => [
      version.versionId,
      version.bucket,
      version.key,
      version.mimeType,
      version.sizeBytes,
      version.etag,
      version.sha256,
    ].join(" ")).join(" "),
    JSON.stringify(asset.meta ?? {}),
    relatedAssets.map((related) => [
      related.assetId,
      related.label,
      related.versions[0]?.mimeType,
      related.versions[0]?.key,
      JSON.stringify(related.meta ?? {}),
    ].join(" ")).join(" "),
  ].join(" ").toLowerCase();
}

export function assetMatchesSearch(
  asset: AssetRecord,
  query: string,
  relatedAssets: AssetRecord[] = [],
): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = getAssetSearchText(asset, relatedAssets);
  return terms.every((term) => text.includes(term));
}

function normalizeVersion(
  version: CreateAssetRecordInput["version"],
  fallbackCreatedAt: string,
  fallbackCreatedBy?: string
): AssetVersionRef {
  return {
    ...version,
    versionId: version.versionId ?? createAssetVersionId(new Date(fallbackCreatedAt)),
    createdAt: version.createdAt ?? fallbackCreatedAt,
    createdBy: version.createdBy ?? fallbackCreatedBy,
  };
}

function assertValidAsset(asset: AssetRecord): void {
  if (!asset.projectId) throw new Error("Asset projectId is required.");
  if (!asset.assetId) throw new Error("Asset assetId is required.");
  if (asset.sk !== getAssetSk(asset.assetId)) {
    throw new Error(`Asset sk must be "asset#${asset.assetId}".`);
  }
  if (!asset.label) throw new Error("Asset label is required.");
  if (!asset.versions.length) throw new Error("Asset must contain at least one version.");
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "-");
}

function randomToken(length: number): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}
