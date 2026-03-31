# Hardware Eval Platform — Project Context

## Vision

A modular, config-driven web platform for hardware evaluation workflows. The UI is assembled at runtime from independently deployable React modules, each described by a configuration file stored in S3. The top-level shell authenticates the user, resolves the root config, and recursively loads the module tree. Every module follows the same protocol, so the shell never needs to know what a module does — only how to load it and pass it its config.

The platform is designed to host tools like schematic viewers, BOM managers, task boards, and documentation viewers — all as composable, self-describing modules that an organization can configure without redeploying the shell.

---

## Architecture Overview

### Entry Point

The user navigates to the shell with a URL that points to a root config file in S3:

```
https://shell.example.com/?config=apps/hardware-eval/config.json
```

Both the `bucket` and `key` come from the URL. Users may host valid modules in their own S3 buckets and the shell should not restrict this — IAM controls actual access. If no config is specified, the shell loads a default organizational landing page from a well-known S3 location configured in the shell's deployment config.

### Auth Shell (`auth-shell`)

Responsibilities:
- Authenticate the user (Google Sign-In → AWS Cognito Identity Pool → temporary AWS credentials)
- Resolve the root `ModuleConfig` from S3 using those credentials
- Bootstrap the recursive module loader
- Provide global context to the module tree: auth state, AWS credential provider, edit mode flag

Auth is handled before any module is loaded. The module tree never deals with authentication directly — it receives an AWS credential provider via context and uses it to access its own resources.

Tech stack: React 19, Vite, Zustand, AWS SDK v3, Google Identity Services.

---

## The Module System

### Core Principle

Every element in the UI — from the top-level layout to a single content pane — is a **module**. A module is a React component loaded from an S3 bundle, described by a config file also in S3. The shell and all modules share a common loader utility; the recursive structure is self-similar at every level.

### S3 Directory Convention

Each module owns a directory in S3. All of its assets (bundle, config, data) live under that prefix:

```
apps/
  hardware-eval/
    config.json         ← module config
    bundle.js           ← compiled React component
    data/               ← module-specific data (optional)
  left-nav/
    config.json
    bundle.js
  markdown-viewer/
    config.json
    bundle.js
    content/
      readme.md
```

This makes it straightforward to copy, archive, version, or transfer ownership of an entire module.

---

## Config Schema

The config schema is the central contract of the entire system. The shell and every module must agree on this structure.

### `ModuleConfig`

```ts
type ModuleConfig = {
  id: string;                        // unique identifier for this instance
  app: {
    bucket: string;                  // S3 bucket containing the bundle
    key: string;                     // S3 key for the JS bundle
    exportName?: string;             // named export to use (default: "default")
  };
  meta?: Record<string, unknown>;    // module-specific static configuration
                                     // (e.g. tab labels, markdown file key, color theme)
  resources?: Resource[];            // AWS resources this module has access to
  children?: ChildSlot[];            // named child slots, each with their own config
};
```

### `Resource`

Describes a dataset or AWS resource belonging to a module. Resources are declared in the module's config and registered globally at load time — any module in the tree can access any declared resource. The format is intentionally open-ended since data could be CSV files, images, DynamoDB tables, SQL databases, or anything else.

```ts
type Resource = {
  id: string;           // unique ID within the project, used to look up the resource globally
  label: string;        // human-readable name shown in the resource picker dialog
  type: "s3-object" | "s3-prefix" | "dynamodb" | "api" | "other";
  bucket?: string;      // for S3 types
  key?: string;         // for s3-object: exact key; for s3-prefix: directory prefix
  table?: string;       // for dynamodb
  endpoint?: string;    // for api
  mimeType?: string;    // hint for consumers (e.g. "text/csv", "image/png", "application/json")
  meta?: Record<string, unknown>;  // type-specific extras
};
```

### `ChildSlot`

A named slot within a module's layout that is filled by a child module. The child's full config is stored at a separate S3 path, resolved lazily when needed.

```ts
type ChildSlot = {
  slotName: string;       // logical name for this slot (e.g. "content", "left-nav", "tab-1")
  configPath: string;     // S3 key for the child module's config.json
                          // resolved relative to the same bucket as the parent
};
```

### Example Config

```json
{
  "id": "hardware-eval-root",
  "app": {
    "bucket": "my-org-apps",
    "key": "apps/hardware-eval/bundle.js"
  },
  "meta": {
    "title": "Hardware Eval"
  },
  "resources": [
    { "type": "dynamodb", "table": "eval-sessions" }
  ],
  "children": [
    { "slotName": "left-nav",  "configPath": "apps/hardware-eval/left-nav/config.json" },
    { "slotName": "content",   "configPath": "apps/hardware-eval/content/config.json" },
    { "slotName": "top-bar",   "configPath": "apps/hardware-eval/top-bar/config.json" }
  ]
}
```

---

## Module Loading Protocol

### Two-Step Load

Loading a module is always two steps:

1. **Fetch config** — GET the `config.json` from S3, parse it as `ModuleConfig`
2. **Fetch bundle** — GET the JS bundle at `config.app.key`, dynamic-import it as a blob URL, extract the named export

The current `loadRemoteAppFromS3.ts` implements step 2 only (pointed directly at a bundle). This needs to be refactored into a unified `loadModule(configPath)` function that does both steps.

### Props Passed to Every Module

Every loaded module component receives a standard set of props:

```ts
type ModuleProps = {
  config: ModuleConfig;    // the module's own resolved config (resources, children, meta)
};
```

That's it. Everything else a module needs comes from shared React contexts provided by the shell — no tunneling through constructors or prop chains:

| Context | Hook | What it provides |
|---|---|---|
| Auth | `useAwsCredentials()` | Credential provider for AWS SDK calls |
| Resource Registry | `useResource(id)` | Descriptor for any resource declared in the project |
| Resource Picker | `useResourcePicker()` | Opens the standard dataset selection dialog |
| Edit Mode | `useEditMode()` | Whether the UI is in edit mode |

Modules are not responsible for fetching their own config — they receive it already resolved. They are responsible for rendering their children via `<SlotContainer slotName="…" />`, which reads child config paths from the module's own `config.children`.

### `<SlotContainer>`

A shared React component (in a common library package) that encapsulates the recursive loading logic:

- Calls the loader with the child's `configPath`
- Renders a loading state while fetching
- Renders an error boundary if loading fails
- In edit mode, renders a configuration overlay on top of the loaded child
- Otherwise renders the loaded child component with its resolved `ModuleConfig`

All modules use `<SlotContainer>` for every child slot. This is what makes the recursion uniform.

---

## Global Resource Registry

### Motivation

Data belongs to the project, not to individual modules. A schematic viewer and a BOM editor working in the same project should both be able to reach the same component database without either one passing a handle to the other. Resources are declared in whichever module's config owns them, but all resources from the entire config tree are aggregated into a single global context that any module can read from.

### How It Works

Resource registration is **lazy** — resources are added to the global registry as each module's config is fetched, not by pre-crawling the entire tree at startup. When a `SlotContainer` resolves a child's config, it registers that config's `resources` into the registry before rendering the child. This keeps startup fast and avoids fetching configs for modules the user may never navigate to.

Modules access resources via a hook — no props, no tunneling:

```ts
// inside any module component
const csvFile = useResource("component-database-csv");   // returns Resource | undefined
```

The `Resource` descriptor provides the address (S3 key, DynamoDB table, etc.). The module fetches the actual data itself using **TanStack Query**, which provides an app-wide cache shared across all modules:

```ts
const s3 = useAwsS3Client();   // from shell context

const { data } = useQuery({
  queryKey: ["resource", "component-database-csv"],
  queryFn: () => s3.send(new GetObjectCommand({ Bucket: res.bucket, Key: res.key })),
});
```

TanStack Query handles caching, deduplication, and background refetch automatically. If two modules request the same resource, only one fetch is made. The query cache is app-wide, so data fetched by one module is immediately available to another that requests the same key.

### Resource Picker Dialog

A shared `<ResourcePicker>` component (in `module-core`) provides a standard UI for modules to let users select from available resources. It reads from `ResourceRegistry` and presents a filterable list showing each resource's label, type, and owning module. Modules open this dialog when they need the user to point them at a dataset — for example, a chart module asking "which table should I visualize?"

In edit mode, resource bindings can be reconfigured through this same dialog. The selected resource `id` is saved into the module's `meta` config in S3.

### Resource ID Uniqueness

Resource `id` values must be unique within a project. Convention: `{moduleId}/{descriptive-name}` (e.g. `hardware-eval-root/component-db`). The shell warns at load time if duplicate IDs are detected across the tree.

---

## Edit Mode

A global boolean context (`EditModeContext`) that flows down the entire module tree.

### Behavior

When `editMode` is `true`:

- Every `<SlotContainer>` renders an overlay/border indicating it is a configurable slot
- Clicking the overlay opens a picker dialog for selecting or replacing the module in that slot
- The user can also delete a slot's module entirely
- When replacing a module, the existing `meta` config is carried over to the new module. If the new module version is incompatible with parts of the old config, it loads what it can and the user rebuilds the rest — no hard failure, best-effort carry-over
- On confirm, the parent module's `config.json` is written back to S3 with the updated `children` array

Edit mode is toggled at the shell level. Individual modules do not need to implement any edit-mode logic — it is entirely handled by `<SlotContainer>` and the shell picker dialog.

### Permission Model

IAM controls actual S3 write access. The DynamoDB project record lists the owner and authorized editors by OAuth email/identity ID. When the app loads, it reads its own project record to determine the user's role. If the user is owner or an authorized editor, the edit mode button is rendered. If the user's credentials turn out not to have write access despite the role record suggesting otherwise, the worst outcome is a failed S3 write — the UI degrades gracefully rather than breaking. No upfront permission probing needed.

---

## Default App (Organizational Landing Page)

When no `?config=` parameter is present in the URL, the shell loads a default module from a well-known S3 path (configured in the shell's own deployment config, not hardcoded in source).

The default app is itself a module following the same schema. It is responsible for:

- Displaying the authenticated user's profile
- Listing projects the user owns or has been added to as a collaborator
- Each project entry links to that project's root config (i.e. sets `?config=` and navigates)
- In edit mode, allowing the user to create a new project (writes a new config scaffold to S3)

Project membership data lives in DynamoDB. The default app's config declares that table as a resource, and it reads/writes it directly using the AWS credential provider from context.

### Project Registry Schema (DynamoDB)

```
Table: org-projects
PK: userId (OAuth email or Cognito identity ID)
SK: projectId

Attributes:
  role: "owner" | "editor" | "viewer"
  rootConfigPath: string        // S3 key for the project's root config.json
  rootBucket: string            // S3 bucket for the project
  displayName: string
  description?: string
  createdAt: string (ISO 8601)
  updatedAt: string (ISO 8601)
```

Ownership and editor lists are maintained in this table. The project owner can add or remove editors and viewers by their OAuth email. IAM permission policies for the project's S3 prefix are created and updated dynamically as users are granted or revoked access — the shell or a backend function handles policy generation so the DynamoDB record and IAM stay in sync.

### Resource Provisioning

The default resource set provisioned at project creation:
- An S3 prefix (`projects/{projectId}/`) owned by the project
- One shared DynamoDB table (`{projectId}-data`) for all modules in the project to use, with module-prefixed keys to avoid collisions

Modules that require additional infrastructure (e.g. a dedicated DynamoDB table for high-volume data) declare this in their registry entry. When such a module is added to a project in edit mode, the shell prompts the owner to approve provisioning. All provisioned resources are recorded in the project manifest (see below).

### Project Manifest (`manifest.json`)

A file written to the root of every project's S3 prefix. It is the authoritative record of everything the project owns or depends on. Updated whenever a resource is provisioned or an external source is linked.

```json
{
  "projectId": "hardware-eval-abc123",
  "createdAt": "2026-03-31T00:00:00Z",
  "s3": {
    "bucket": "my-org-apps",
    "prefix": "projects/hardware-eval-abc123/"
  },
  "provisionedResources": [
    { "type": "dynamodb", "table": "hardware-eval-abc123-data", "region": "us-east-2" }
  ],
  "externalSources": [
    { "moduleId": "bom-editor", "type": "api", "endpoint": "https://erp.internal/api/bom" }
  ]
}
```

At project deletion, the shell reads the manifest and tears down every `provisionedResources` entry before removing the S3 prefix.

---

## Project Export & Archive

Before a project is deleted — or simply for backup — the shell can produce a self-contained zip of the entire project.

### Export Flow

1. Shell reads the full config tree to enumerate all loaded modules
2. For each module that exports an `onExport` function, the shell calls it sequentially, passing S3 write access and the project prefix
3. Each module is responsible for fetching its own external data (API responses, non-S3 sources) and writing it into its subdirectory under the project prefix in a predictable layout
4. Once all modules complete, the shell downloads the entire S3 prefix as a zip
5. The manifest is included in the zip

### Module Export Protocol

Exporting external data is optional but standardized. A module bundle may export an `onExport` function alongside its default component:

```ts
// module bundle exports:
export default function MyComponent(props: ModuleProps) { … }

export async function onExport(ctx: {
  config: ModuleConfig;
  s3: S3Client;
  projectPrefix: string;  // module writes under: projectPrefix + config.id + "/export/"
}): Promise<void> {
  // fetch external data, write to S3
}
```

Modules that only use S3 resources need not implement `onExport` — their data is already in the project prefix. Only modules with external dependencies (APIs, non-project DynamoDB tables, etc.) need to implement it.

### Re-import

A zip produced by export can be re-imported to reconstitute the project. The shell detects a `manifest.json` in the uploaded zip, creates a new project record, and re-provisions any resources listed in `provisionedResources`. External source links are preserved in the manifest but the module may need reconfiguration if the external endpoint has changed.

---

## Concurrent Edit Locking

Only one user may be in edit mode for a project at a time. This is enforced via a lock record written directly to DynamoDB:

```
Table: org-projects-locks
PK: projectId
Attributes:
  lockedBy: string      // OAuth email of the active editor
  lockedAt: string      // ISO 8601
  ttl: number           // Unix epoch; DynamoDB auto-expires the record
```

When a user enters edit mode, the shell writes this record with a TTL of 30 minutes. A heartbeat refreshes the TTL every few minutes while edit mode is active. On clean exit from edit mode the record is deleted immediately.

Other users see the lock in the UI — the edit button is replaced with "Editing locked by jeff@…". Users with write access (owner or editor role) may override the lock, which overwrites the record and steals edit mode. The previous editor's next heartbeat will find they no longer hold the lock and exit edit mode gracefully.

---

## Shared Dependencies & Build Strategy

Because every module is a separately built JS bundle, shared dependencies (React, React DOM, AWS SDK) must not be duplicated at runtime. Strategy:

- The shell exposes React, ReactDOM, Zustand, and TanStack Query as globals on `window.__SHELL_DEPS__`
- Each module's build config (Vite/Rollup) marks these as external and reads them from `window.__SHELL_DEPS__` at runtime
- TanStack Query's `QueryClient` is instantiated once in the shell and provided via `QueryClientProvider` — all modules share the same cache instance
- This is a lightweight alternative to Webpack Module Federation and works with Vite-built modules

Each module bundle is built as an ES module (`format: "es"`) with a single default (or named) export that is the root React component.

---

## Packages in This Monorepo

| Package | Purpose |
|---|---|
| `auth-shell` | Host application: auth, config resolution, module bootstrapping |
| `module-core` *(planned)* | Shared types (`ModuleConfig`, `ModuleProps`, `Resource`, `ChildSlot`), `<SlotContainer>`, `loadModule()`, `EditModeContext` |
| `app-landing` *(planned)* | Default organizational landing page module |
| `app-markdown-viewer` *(planned)* | Simple module: renders markdown from an S3 resource |
| `app-tab-viewer` *(planned)* | Module with a top tab bar; each tab is a child slot |
| `app-task-board` *(planned)* | Jira-like task board backed by DynamoDB |

---

## Current State of the Codebase

- `auth-shell` is functional for auth (Google → Cognito) and loads a single remote bundle pointed to directly by URL params
- URL params currently point to a bundle (`?bucket=&key=`); this needs to change to point to a config file (`?config=`)
- No `module-core` package exists yet; shared types are inline in `auth-shell`
- No default landing page exists; missing URL params currently shows an error screen
- Microsoft auth is stubbed (placeholder button, not implemented)
- Shell config (`region`, `identityPoolId`, `googleClientId`) is hardcoded in `src/config.ts`; should move to environment variables or a bootstrapped fetch

---

## Module Registry

The edit-mode picker draws modules from one or more registries. The primary registry is an internal platform service (DynamoDB + S3), but external registries can also be used.

### Publishing & Ownership

- Users publish modules by name. The original publisher owns all versions published under that name.
- Other users may publish under a different name (forks or custom variants); they own their own name.
- Published modules are versioned. The registry always offers all historical versions alongside the latest.
- Configs reference modules by name and resolve to the latest bundle at load time (latest-pointer model). This means module updates are picked up automatically without reconfiguring.

### Module Registry Record (DynamoDB)

```
Table: module-registry
PK: moduleName (globally unique, owner-namespaced e.g. "jeff/tab-viewer")
SK: version (semver string, e.g. "1.0.0"; "latest" is a pointer record)

Attributes:
  ownerId: string               // OAuth email of publisher
  bundlePath: string            // S3 key for the compiled bundle
  bundleBucket: string
  category: string              // e.g. "layout", "viewer", "data", "utility"
  displayName: string
  description?: string
  thumbnailUrl?: string         // S3 URL for a preview image of the rendered module
  previewImageUrl?: string      // full screenshot if available
  publishedAt: string (ISO 8601)
  tags?: string[]
```

### External Registries

Nothing prevents a config or sub-module config from pointing to an S3 location outside the internal registry. To support the edit-mode picker for external sources (including their thumbnails and metadata), the **root-level config** can declare external registry endpoints:

```json
{
  "externalRegistries": [
    { "name": "Partner Org", "endpoint": "https://modules.partner.example.com/registry.json" }
  ]
}
```

The shell probes each declared registry at startup and merges their module listings into the picker. Thumbnails and metadata come from the registry response itself, so no special trust relationship is needed — the root config owner decides which external sources to include.

---

## Open Questions

- **Config bucket**: URL-specified. Users may host modules in their own buckets; IAM controls actual access. ✓ decided
- **Module versioning**: Latest-pointer model (`bundle.js` always reflects latest publish). Registry retains all historical versions for rollback. ✓ decided
- **Module registry**: Internal primary registry + external registries declared in root config. ✓ decided
- **Write permissions UI**: Role from DynamoDB project record drives edit button visibility; graceful failure on actual write if IAM lags. ✓ decided
- **IAM policy sync**: When an owner grants editor access by email, the IAM policy for the project's S3 prefix must be updated. This is done directly via the AWS SDK using the owner's credentials (no Lambda, no API Gateway). The owner's Cognito identity must have iam:PutRolePolicy or s3:PutBucketPolicy rights scoped to the project prefix. Direct SDK calls keep the access grant flow fast and eliminates the need for backend infrastructure.
