# Jeffspace Loader - Project Context

## Vision

Jeffspace Loader is a config-driven micro-frontend shell. The shell authenticates the user, resolves a root config file from S3, loads the module tree at runtime, and gives each module shared access to auth, AWS clients, edit mode, and project-scoped resources. The shell should not need to know what a module does - only how to load it.

Jeffspace is the default application built on top of the framework. It lists projects, opens them by URL, creates new projects, and serves as the first production-grade example of the module system.

The long-term goal is not only "host modules," but "build a workspace with the user." Human users and AI agents should both be able to inspect project data, add modules, wire resources, and evolve the workspace safely without hard-coded S3 paths or fragile one-off integrations.

## Current State

### Auth

- Auth is Google Sign-In through Cognito Identity Pool.
- The shell no longer treats a Google token itself as authorization.
- A user is considered signed in only after Cognito successfully exchanges the Google token for AWS credentials.
- Access control is therefore enforced by the Identity Pool configuration, especially Google claim-based role mapping.
- Unauthorized users can still sign in with Google, but they should fail to obtain credentials if the Identity Pool denies them.

Relevant code:
- `apps/shell/src/auth/googleCognito.ts`
- `apps/shell/src/stores/authStore.ts`
- `apps/shell/src/auth/AuthGate.tsx`

### Runtime Architecture

- `apps/shell` hosts the public sign-in UI and first-stage bootstrap.
- `modules/shell-core` provides the authenticated runtime.
- `core` (`module-core`) contains the shared types, module loader, contexts, hooks, registry helpers, and `SlotContainer`.
- Project content modules are published to S3 and registered in DynamoDB.
- The shell and modules are built as IIFEs and loaded via script tags from blob URLs / S3.

### Active Packages

Core/runtime:
- `apps/shell`
- `apps/landing`
- `core`
- `modules/shell-core`

Layouts:
- `layouts/top-left`
- `layouts/tabs-top`
- `layouts/tabs-left`
- `layouts/left-right-columns`

Modules:
- `modules/webview`
- `modules/oauth-badge`
- `modules/template`
- `modules/markdown-viewer`
- `modules/document-viewer`
- `modules/documentation-viewer`
- `modules/links`
- `modules/task-tracker`
- `modules/kicad-board-viewer`
- `modules/serial-display`

Shared libraries:
- `shared/web-serial-runtime`
- `shared/kicad-board-export`

### Local and Cloud Workflow

Local:
- S3-compatible storage via MinIO
- DynamoDB Local
- direct browser access to local S3 endpoint
- proxied local DynamoDB endpoint

Cloud:
- shell bundle in `jeffspace-shell`
- module bundles in `jeffspace-registry`
- project content/config in `jeffspace-modules`
- registry metadata in `jeffspace-module-registry`
- project metadata in `jeffspace-projects`

Recent status:
- AWS publish and shell deploy scripts are working.
- Current cloud branch includes the stricter "credential exchange required" auth flow.

## Core Architecture

### Entry URL

Projects are opened by URL:

```text
https://shell.example.com/?bucket=my-org&config=apps/hardware-eval/config.json
```

If no params are present, the shell loads Jeffspace from its configured default app location.

### Module Loading

Every module is loaded in two steps:
1. Fetch config JSON from S3
2. Fetch the JS bundle from S3 and execute it as an IIFE

Shared dependencies are exposed as globals before any module loads:

```ts
window.__React = React;
window.__ReactJsxRuntime = ReactJsxRuntime;
window.__ReactDOM = ReactDOM;
window.__ModuleCore = moduleCore;
```

Each module bundle must build with named exports so `window.RemoteModule.default` resolves correctly.

### Shared Contexts

Today the shell exposes:
- Auth context
- Edit mode context
- Resource registry context

Current shared resource support is real, but narrow: it aggregates static resource declarations from loaded configs. It is not yet the generalized shared data layer the project originally intended.

## Current Config Contract

### ModuleConfig

```ts
type ModuleConfig = {
  id: string;
  app: {
    bucket: string;
    key: string;
    exportName?: string;
  };
  meta?: Record<string, unknown>;
  resources?: Resource[];
  children?: ChildSlot[];
  theme?: {
    cssKey?: string;
    cssBucket?: string;
  };
};
```

### Resource

```ts
type Resource = {
  id: string;
  label: string;
  type: "s3-object" | "s3-prefix" | "dynamodb" | "api" | "other";
  bucket?: string;
  key?: string;
  table?: string;
  region?: string;
  endpoint?: string;
  mimeType?: string;
  meta?: Record<string, unknown>;
};
```

This remains useful, but it should be treated as the static config-facing layer, not the final answer for shared live project data.

## Shared Project Data - Updated Design Direction

### Why the Existing Model Is Not Enough

Current modules often treat S3 as private module storage:
- document viewer uploads a PDF to its own prefix
- markdown viewer uploads a whole directory and its artifacts to its own prefix
- task tracker stores its own JSON under its own prefix

That causes duplication and weak reuse:
- the same document may be uploaded more than once
- another module cannot reliably reference data without knowing bucket/key conventions
- links become fragile because modules point at storage locations, not stable project-level objects

### Original Intent to Preserve

The original intent was a shared local in-memory database for module data. That intent is still valid and should be preserved, but it needs to be expanded so it also works with cloud-backed project data, stable references, and large arbitrary assets.

### Proposed Model

The project should have a unified data layer with three parts:

1. Persistent canonical storage
- S3 stores the bytes
- DynamoDB stores metadata, identity, versions, and references

2. Shared local runtime broker
- browser-local, shared by all loaded modules
- caches data records and loaded content
- exposes project data to modules and AI agents at runtime

3. Stable project references
- modules should reference project data by stable IDs, not raw S3 paths
- resolved S3 locations may be cached alongside IDs for fast reads

In short:
- S3 is the data plane
- DynamoDB is the control plane
- the in-memory broker is the runtime coordination plane

### Design Goals

- no mandatory DynamoDB lookup on every file read
- no hard-coded path assumptions between modules
- no accidental duplicate uploads when reusing assets
- stable references that survive storage moves or version updates
- browseable access for humans and agents
- support for arbitrary data size and shape
- direct project scoping for efficient queries

## Asset Model

### Settled First Asset Shape

Use project-scoped logical assets. Modules and agents should refer to assets by stable `assetId`, not by guessed S3 paths.

The first implementation should use one DynamoDB asset record with compact embedded version references. Do not create separate asset-version records yet.

```ts
type AssetVersionRef = {
  versionId: string;
  bucket: string;
  key: string;

  mimeType?: string;
  sizeBytes?: number;
  etag?: string;
  sha256?: string;

  createdAt: string;
  createdBy?: string;
};

type AssetRecord = {
  projectId: string;
  sk: `asset#${string}`;

  assetId: string;
  label: string;

  versions: AssetVersionRef[]; // current version is always versions[0]

  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;

  meta?: Record<string, unknown>;
};
```

Asset IDs should be opaque and project-scoped:

```text
asset_<random>
```

Version IDs should be timestamped plus random suffix:

```text
v_<yyyymmddThhmmssZ>_<random>
```

Asset labels are required. Use the user-provided label when available, otherwise fall back to original filename, generated purpose label, or finally the `assetId`.

`meta` belongs to the logical asset only. Do not add version-level `meta` yet; update the asset-level `meta` as the logical asset changes.

Embedded version rules:
- `versions[0]` is current
- rollback moves an existing version ref to index 0
- `versions[1...]` are available prior versions and are not guaranteed chronological
- keep at most 20 embedded version refs
- do not automatically delete old S3 objects when trimming embedded refs in the first implementation

Modules should usually store:
- `assetId` for stable references
- optionally resolved `bucket` / `key` / `versionId` for direct-read fast path

### Why This Matters

This prevents broken links:
- a module can keep pointing at the same logical asset
- the storage location can change without requiring every consumer to rewrite references
- compact embedded versions allow basic rollback and reproducibility without a separate version table shape yet

### S3 Layout

Asset bytes should be stored under the project, not under the uploading module:

```text
projects/<projectId>/assets/<assetId>/versions/<versionId>/<filename>
```

Example:

```text
s3://jeffspace-modules/projects/hardware-eval-mabc123/assets/asset_k8x4p2m9/versions/v_20260523T182200Z_x4p2/motor-controller.pdf
```

## Registry Shape

There should be one global asset registry table, not one table per project.

However, the primary partition boundary must be `projectId`, so current-project reads are efficient and direct.

First implementation shape:

```text
Table: jeffspace-project-assets
PK: projectId
SK: asset#<assetId>
```

Accepted first item type:
- `asset#<assetId>`

Possible later sibling items, not part of the first asset pass:
- `typed-source#<sourceId>`
- `typed-view#<sourceId>#<viewType>`
- `asset-version#<assetId>#<versionId>` if embedded versions become too large

This keeps all current-project assets queryable without scans, even if a project has tens of thousands of assets.

## Performance and Cost Principles

### Hard Rule

Do not design the system so every normal file open requires:
1. DynamoDB lookup
2. then S3 fetch

That would add unnecessary cost and latency.

### Fast Path

Normal render/read path should be:
- module has `assetId`
- module or broker already has resolved `bucket` / `key`
- client reads S3 directly or from memory cache

### Control Plane Path

DynamoDB should mainly be used for:
- browse/search
- linking existing assets
- mutation bookkeeping
- provenance
- repair when a cached location is stale
- agent crawl/index operations

### Runtime Cache

The in-memory broker should cache:
- asset metadata
- resolved S3 locations
- already-downloaded or already-parsed content where useful

## Shared Runtime Broker

The runtime broker is the modern continuation of the original shared local DB idea.

Responsibilities:
- keep project data records in memory for loaded modules
- resolve stable IDs to usable references
- expose subscription APIs for live updates
- cache fetched content
- expose typed views and adapters

Example responsibilities:
- `getAsset(assetId)`
- `getAssetContent(assetId)`
- `listAssets(projectId, filters)`
- `subscribeAsset(assetId, handler)`
- `resolveSource(sourceId)`

The broker should not replace S3/DynamoDB; it should sit on top of them.

## Data Sources and Typed Views

Assets alone are not enough for cross-module structured data.

The broker should also support typed data sources and derived views:
- `task-dates`
- `schedule-items`
- `calendar-events`
- `document-tree`
- `pdf-text`
- `markdown-manifest`

This allows:
- browse by type first
- pick a specific source by human label plus unique ID
- ask the provider/adapter for normalized data
- return explicit incompatibility failures instead of silent misuse

This is especially important for the planned scheduler module, which should be able to browse available typed sources rather than hard-coding paths to task-tracker data.

## AI Agent Requirements

Agents are first-class consumers and editors of the workspace.

The data layer must let agents:
- list project assets and sources
- inspect metadata
- fetch raw content when needed
- fetch derived/structured views when available
- create new assets
- create derived assets
- modify module configs
- create modules and wire them to existing resources

So the system is not just an asset index; it is a writable project knowledge layer.

The agent should operate through stable objects and project graph updates, not through guessed S3 paths.

### Agent Runtime Direction

Keep both agent modes:
- browser-native agent mode for any signed-in user, including CloudFront-only use where no local service exists
- local runtime mode for users who explicitly install and enable a local service

The browser-native agent can use project APIs, central assets, module registry data, and project config mutation tools. It remains intentionally limited for local filesystem, shell, Python, PDF extraction, PTY, and eventual native Agent runtime behavior.

The local runtime/bridge is an explicit permission boundary:
- default state is disabled
- the UI must require the user to check `Enable local runtime for this project`
- installed service detection happens only after the user enables or manually checks it
- installation is initiated through visible platform download links; the browser must not silently install or start software
- saved pairing tokens do not imply the runtime is enabled for the current project/module
- when disabled, the browser agent must not call local runtime or bridge APIs

Current first-pass local runtime behavior:
- `scripts/agent-bridge.ts` exposes unauthenticated `GET /health` for safe install/detection only
- privileged `POST /rpc` calls still require the bearer token
- default CORS allows localhost and CloudFront distribution origins; custom production domains must be added through `AGENT_BRIDGE_ALLOWED_ORIGINS`
- the Chat Agent module stores local runtime enablement separately from URL/token/workspace root
- `run:local` can inject bridge defaults, but the UI still requires project-scoped enablement before use

Planned native Agent runtime behavior:
- add a separate local `Agent-runtime` service or evolve the bridge into one
- browser UI becomes an agent console that can select browser-native or local runtime backends
- local runtime owns real Agent session lifecycle, PTY/process control, approvals, filesystem, shell, Python, and project APIs
- browser streams events, displays approvals/tool output, and falls back to browser-native mode when the runtime is unavailable

Current shared browser/bridge agent API direction:
- the browser agent remains primary for appspace awareness because it can see project config, loaded modules, assets, resources, and CloudFront-only state
- when the bridge is explicitly enabled and paired, the browser publishes an appspace context snapshot to the bridge
- the local runtime can read/search that bridge-held appspace snapshot and queue appspace operations for the browser to execute
- queued appspace operations use the same operation names as browser-agent tools so browser and local runtime capabilities stay aligned
- the bridge is treated as trusted once the user enables it; the queue exists because browser appspace state and AWS credentials live in the browser, not because the local runtime is untrusted
- asset transfer is bidirectional: local files can be imported into central project assets, and central project assets can be exported into the local workspace
- response handling from the local runtime should stay conversational/freeform; structure belongs mainly at the operation/API boundary

## Project Graph

Over time, the data layer needs to cover both:
- assets/artifacts
- workspace structure

That means agents and future tooling should be able to reason about:
- module instances
- child-slot wiring
- resource references
- asset references
- typed source links

For now, do not persist a separate module-instance graph. Keep the nested project `config.json` as the canonical workspace structure and let the runtime broker build an in-memory graph from it.

A persisted project graph may become useful later for server-side search, partial lazy-load mutation, indexing, locking, or agent operations that should not require loading the full project config in the browser.

## Scheduler Module Direction

Planned scheduler requirements:
- Gantt view as primary display
- calendar view as a secondary display
- tasks, milestones, phases, and other event types
- multi-task dependencies
- vertical dashed "today" line
- ability to consume dates from other modules without path coupling

Scheduler should consume typed views through the shared project data layer, not raw module-private files.

Likely first integration:
- task tracker publishes a typed `task-dates` view
- scheduler browses available typed sources for the current project
- scheduler links to a selected source
- incompatibility is surfaced explicitly

## Existing Shared Runtime Example

The repo already contains one successful pattern for a shared browser-local runtime:
- `shared/web-serial-runtime`

That package is a singleton shared by modules and is the best current example of how to structure a shared runtime without hard-coding module-to-module coupling.

The future project data broker should follow the same spirit, but with cloud-backed assets and typed project data.

## Current Implementation Gaps

Implemented today:
- resource registry for config-declared resources
- shared auth/runtime contexts
- module registry and dynamic loading
- project/module persistence in S3 + DynamoDB
- serial shared runtime
- project asset table provisioning for local and cloud environments
- compact embedded-version asset helpers in `module-core`
- Markdown Viewer upload to central project assets
- Document Viewer upload to central project assets
- Document Viewer project-PDF picker backed by the central asset table
- browser-native Chat Agent module with project asset/config tools
- local agent bridge with explicit UI enablement, tokened privileged RPC, and tokenless health check
- bridge appspace session APIs: sync context, get context, search synced assets, queue/list/complete appspace operations
- Chat Agent bridge sync/poll loop so local-runtime queued appspace operations execute through the same browser tool path

Not implemented yet:
- shared project data broker
- typed data source registry
- native local Agent runtime service
- installer artifacts for the local runtime downloads
- scheduler module

Partially implemented:
- stable asset references across modules: Markdown Viewer creates file-set/file assets and Document Viewer can select PDF file assets from the same project
- browse/search: current PDF picker searches labels, paths, version metadata, asset metadata, and parent file-set labels; a reusable broker-level browser is still future work
- agent-writable project data APIs: Chat Agent can list/create/read/export/import assets and create/update/remove nested slots; browser tools and bridge-queued operations now share the same operation names, but a formal shared broker package is still future work

Markdown Viewer first asset behavior:
- creates one `file-set` asset for the reachable markdown tree
- creates one `file` asset for each reachable markdown-linked file
- stores file bytes under `projects/<projectId>/assets/<fileSetAssetId>/versions/<versionId>/files/<path>`
- stores a JSON manifest as the file-set version object
- stores module meta as `{ prefix, rootKey, bucket, assetId, versionId }`

Document Viewer first asset behavior:
- new PDF uploads create one `file` asset
- module meta stores `{ key, filename, bucket, assetId, versionId }`
- edit mode can browse existing project PDF assets and point the viewer at the selected asset version
- older S3-only document meta remains readable

## Recommended Implementation Order

1. Add native local Agent runtime execution behind the existing explicit enable/pairing boundary
2. Promote the Chat Agent operation executor into a shared browser broker package
3. Expand bridge appspace operations for asset import/export, module creation, nested module edits, and runtime result reconciliation
4. Promote the Document Viewer PDF picker into a reusable asset/source picker
5. Add typed data source support for structured module data
6. Update task tracker to publish a typed task-date view
7. Build scheduler on top of that data layer

## Open Decisions

- Whether structured module state and binary artifacts should share one table shape or be sibling concepts
- Whether the broker should support persistence beyond the current loaded session
- Whether cross-project asset reuse is supported initially or only project-scoped assets
- Whether embedded asset versions need promotion to separate DynamoDB records after real usage
- How much of the project graph should eventually be formalized in DynamoDB versus remaining config-file driven

## Operational Notes

- Branch for this design work: `central-data-store`
- Current auth model depends on Cognito Identity Pool claim-based authorization
- Cloud publish and shell deploy were successfully run before this handoff
- This file is intended to be the source of truth for the next PC/session so the original shared-local-data intent is not lost again

## Local Appspace Lab

The local `jeffdevelopment-dev` project has been expanded from the bare seed into an appspace lab:
- root module: `layout-top-left`
- top bar: `module-links` plus `module-oauth-badge`
- Command Center nav: `layout-tabs-top` containing Chat Agent, Task Tracker, and Links
- Documentation nav: `layout-tabs-left` containing Markdown Viewer, Document Viewer, and Documentation Viewer
- Engineering Tools nav: `layout-left-right-columns` containing nested tab layouts for KiCad, Serial Display, Webview, and tool links

The lab also seeds central assets under `project-assets`:
- `asset_appspace_docs_set`: markdown file-set manifest
- markdown child files for README/runtime/hierarchy notes
- `asset_appspace_sample_pdf`: sample PDF shared by Markdown Viewer and Document Viewer

The Documentation Viewer tab also has an editable native documentation tree:
- manifest: `projects/jeffdevelopment-dev/documentation/documentation-index/manifest.json`
- pages prefix: `projects/jeffdevelopment-dev/documentation/documentation-index/pages`
- root page: `Appspace Lab Documentation`
- child pages cover overview, browser/local runtime, bridge operation queue, shared assets, module hierarchy, and local testing notes

This project is meant to exercise nested module creation, shared assets, cross-module asset references, and browser/bridge agent operation flows.
