import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const STATE_PATH = join(ROOT, ".local-publish-state.json");

const LOCAL = {
  s3Endpoint: "http://localhost:9000",
  ddbEndpoint: "http://localhost:8000",
  region: "us-east-1",
  credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
  registryBucket: "hep-dev-registry",
  registryTable: "module-registry",
};

type WorkspaceEntry = {
  path: string;
  name: string;
  displayName: string;
  publishable: boolean;
  localDeps: string[];
};

type PublishState = {
  workspaces: Record<string, string>;
};

function parseArgs() {
  const flags = new Set(process.argv.slice(2).map((arg) => arg.replace(/^--/, "")));
  return {
    dryRun: flags.has("dry-run") || flags.has("plan") || process.env["npm_config_dry_run"] === "true",
  };
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function readRootPackage(): { workspaces?: string[] } {
  return readJsonFile<{ workspaces?: string[] }>(join(ROOT, "package.json"));
}

function discoverWorkspaces(): WorkspaceEntry[] {
  const rootPkg = readRootPackage();
  const workspaceMeta = new Map<string, { path: string; pkgPath: string; pkg: any }>();

  for (const ws of rootPkg.workspaces ?? []) {
    const pkgPath = join(ROOT, ws, "package.json");
    if (!existsSync(pkgPath)) continue;
    workspaceMeta.set(ws.replace(/\\/g, "/"), { path: ws.replace(/\\/g, "/"), pkgPath, pkg: readJsonFile<any>(pkgPath) });
  }

  const workspaceNames = new Map<string, string>();
  for (const meta of workspaceMeta.values()) {
    if (typeof meta.pkg.name === "string") {
      workspaceNames.set(meta.pkg.name, meta.path);
    }
  }

  const results: WorkspaceEntry[] = [];
  for (const meta of workspaceMeta.values()) {
    const dependencyNames = {
      ...(meta.pkg.dependencies ?? {}),
      ...(meta.pkg.devDependencies ?? {}),
      ...(meta.pkg.peerDependencies ?? {}),
    };

    const localDeps = Object.keys(dependencyNames)
      .map((depName) => workspaceNames.get(depName))
      .filter((depPath): depPath is string => Boolean(depPath));

    results.push({
      path: meta.path,
      name: meta.pkg.name ?? meta.path,
      displayName: meta.pkg.jsl?.displayName ?? meta.pkg.name ?? meta.path,
      publishable: Boolean(meta.pkg.jsl),
      localDeps,
    });
  }

  return results;
}

function loadState(): PublishState {
  if (!existsSync(STATE_PATH)) {
    return { workspaces: {} };
  }
  try {
    return readJsonFile<PublishState>(STATE_PATH);
  } catch {
    return { workspaces: {} };
  }
}

function saveState(state: PublishState): void {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function collectWorkspaceClosure(workspaces: Map<string, WorkspaceEntry>, workspace: WorkspaceEntry): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  function visit(path: string) {
    if (seen.has(path)) return;
    seen.add(path);
    const entry = workspaces.get(path);
    if (!entry) return;
    for (const dep of entry.localDeps) {
      visit(dep);
    }
    ordered.push(path);
  }

  visit(workspace.path);
  return ordered;
}

function listFilesRecursively(dirPath: string): string[] {
  const ignoredDirs = new Set(["dist", "node_modules", ".git"]);
  const ignoredFiles = new Set(["tsconfig.tsbuildinfo"]);
  const results: string[] = [];

  if (!existsSync(dirPath)) return results;

  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue;
      results.push(...listFilesRecursively(fullPath));
      continue;
    }
    if (ignoredFiles.has(entry.name)) continue;
    results.push(fullPath);
  }

  return results;
}

function fingerprintWorkspace(workspaces: Map<string, WorkspaceEntry>, workspace: WorkspaceEntry): string {
  const closure = collectWorkspaceClosure(workspaces, workspace);
  const hash = createHash("sha256");

  for (const closurePath of closure) {
    const absPath = join(ROOT, closurePath);
    const files = listFilesRecursively(absPath)
      .map((filePath) => relative(ROOT, filePath).replace(/\\/g, "/"))
      .sort();

    hash.update(`workspace:${closurePath}\n`);
    for (const file of files) {
      const absFile = join(ROOT, file);
      const stats = statSync(absFile);
      hash.update(`file:${file}:${stats.size}\n`);
      hash.update(readFileSync(absFile));
      hash.update("\n");
    }
  }

  return hash.digest("hex");
}

function selectPublishTargets(workspaces: WorkspaceEntry[], state: PublishState): Array<{ workspace: WorkspaceEntry; fingerprint: string }> {
  const workspaceMap = new Map(workspaces.map((workspace) => [workspace.path, workspace]));
  const publishable = workspaces.filter((workspace) => workspace.publishable);
  const changed: Array<{ workspace: WorkspaceEntry; fingerprint: string }> = [];

  for (const workspace of publishable) {
    const fingerprint = fingerprintWorkspace(workspaceMap, workspace);
    if (state.workspaces[workspace.path] !== fingerprint) {
      changed.push({ workspace, fingerprint });
    }
  }

  return changed;
}

function publishWorkspace(workspace: WorkspaceEntry): void {
  const publishScript = join(ROOT, "scripts", "publish-module.ts");
  const result = spawnSync(
    "npx",
    ["tsx", publishScript, `--module=${workspace.path}`, "--local"],
    {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
    }
  );

  if (result.status !== 0) {
    throw new Error(`${workspace.displayName} failed to publish`);
  }
}

async function pruneLocalVersions(moduleName: string): Promise<void> {
  const s3 = new S3Client({
    region: LOCAL.region,
    endpoint: LOCAL.s3Endpoint,
    credentials: LOCAL.credentials,
    forcePathStyle: true,
  });
  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: LOCAL.region,
      endpoint: LOCAL.ddbEndpoint,
      credentials: LOCAL.credentials,
    }),
    { marshallOptions: { removeUndefinedValues: true } }
  );

  const latest = await ddb.send(new QueryCommand({
    TableName: LOCAL.registryTable,
    KeyConditionExpression: "moduleName = :moduleName",
    ExpressionAttributeValues: {
      ":moduleName": moduleName,
    },
  }));

  const latestVersion = latest.Items?.find((item) => item["version"] === "latest")?.["latestVersion"] as string | undefined;
  if (!latestVersion) return;

  const prefix = `modules/${moduleName}/`;
  const listed = await s3.send(new ListObjectsV2Command({
    Bucket: LOCAL.registryBucket,
    Prefix: prefix,
  }));

  const deletions = (listed.Contents ?? [])
    .map((item) => item.Key)
    .filter((key): key is string => Boolean(key))
    .filter((key) => key.startsWith(`${prefix}bundle.v`) && key !== `${prefix}bundle.v${latestVersion}.js`);

  for (const key of deletions) {
    await s3.send(new DeleteObjectCommand({
      Bucket: LOCAL.registryBucket,
      Key: key,
    }));
  }

  for (const item of latest.Items ?? []) {
    const version = item["version"];
    if (typeof version !== "string") continue;
    if (version === "latest" || version === latestVersion) continue;

    await ddb.send(new DeleteCommand({
      TableName: LOCAL.registryTable,
      Key: { moduleName, version },
    }));
  }
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs();
  const workspaces = discoverWorkspaces();
  const state = loadState();
  const targets = selectPublishTargets(workspaces, state);

  if (targets.length === 0) {
    console.log("No local modules need publishing.");
    return;
  }

  console.log("Updating local modules:");
  for (const target of targets) {
    console.log(`  - ${target.workspace.displayName} (${target.workspace.path})`);
  }

  if (dryRun) {
    console.log("\nDry run only. No builds or publishes were performed.");
    return;
  }

  for (const target of targets) {
    console.log(`\nPublishing ${target.workspace.displayName}...`);
    publishWorkspace(target.workspace);
    await pruneLocalVersions(target.workspace.name);
    state.workspaces[target.workspace.path] = target.fingerprint;
    saveState(state);
  }

  console.log("\nLocal modules updated.");
}

main().catch((error) => {
  console.error("\nupdate-locals failed:", error);
  process.exit(1);
});
