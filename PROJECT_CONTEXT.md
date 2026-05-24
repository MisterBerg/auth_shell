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

### Asset vs Version

Use project-scoped logical assets, optionally with immutable versions underneath.

`Asset`
- stable project-scoped ID
- human label
- type
- current version pointer
- provenance / source module
- metadata

`AssetVersion`
- immutable storage record
- S3 bucket/key
- content type
- size
- checksum / hash
- createdAt / createdBy

Modules should usually store:
- `assetId` for stable references
- optionally resolved `bucket` / `key` / `versionId` for direct-read fast path

### Why This Matters

This prevents broken links:
- a module can keep pointing at the same logical asset
- the storage location can change without requiring every consumer to rewrite references
- immutable versions allow reproducibility where needed

## Registry Shape

There should be one global asset registry table, not one table per project.

However, the primary partition boundary must be `projectId`, so current-project reads are efficient and direct.

Example high-level shape:

```text
Table: project-assets
PK: projectId
SK: asset#<assetId>
```

Possible sibling items:
- `asset#<assetId>`
- `asset-version#<assetId>#<versionId>`
- `source#<sourceId>`
- `derived-view#<assetId>#<viewType>`

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

## Project Graph

The data layer needs to cover both:
- assets/artifacts
- workspace structure

That means agents and future tooling should be able to reason about:
- module instances
- child-slot wiring
- resource references
- asset references
- typed source links

This likely becomes a "project graph" concept over time, even if the first implementation starts with assets.

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

Not implemented yet:
- project asset table
- asset/version abstraction
- shared project data broker
- typed data source registry
- stable asset references across modules
- agent-writable project data APIs
- scheduler module

## Recommended Implementation Order

1. Introduce project asset metadata table in DynamoDB
2. Introduce asset upload/resolve helpers in `module-core` or a sibling shared package
3. Add the browser-local shared project data broker
4. Convert document viewer and markdown viewer to create/use asset records instead of module-private storage assumptions
5. Add typed data source support for structured module data
6. Update task tracker to publish a typed task-date view
7. Build scheduler on top of that data layer

## Open Decisions

- Whether structured module state and binary artifacts should share one table shape or be sibling concepts
- Whether the broker should support persistence beyond the current loaded session
- Whether cross-project asset reuse is supported initially or only project-scoped assets
- Whether asset versions are first-class from day one or added after logical assets
- How much of the project graph should be formalized in DynamoDB versus remaining config-file driven

## Operational Notes

- Branch for this design work: `central-data-store`
- Current auth model depends on Cognito Identity Pool claim-based authorization
- Cloud publish and shell deploy were successfully run before this handoff
- This file is intended to be the source of truth for the next PC/session so the original shared-local-data intent is not lost again
