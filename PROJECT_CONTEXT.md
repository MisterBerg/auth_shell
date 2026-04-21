# Jeffspace Loader — Project Context

## Vision

A generic, config-driven micro-frontend framework that assembles a full web application at runtime from independently deployable React modules. The framework has no opinion about what those modules do — they could be hardware evaluation tools, project management dashboards, branded customer portals, or anything else. The shell authenticates the user, resolves a root config file from S3, and loads the module tree. Every module follows the same protocol, so the shell never needs to know what a module does — only how to load it.

**Jeffspace** is the first real application built on this framework. It is the default app: an organizational project launcher that lists the user's projects and lets them open, create, and manage them. Jeffspace is not a demo or a placeholder — it demonstrates what a well-built top-level application looks like within the framework. Hardware Eval Platform is a project that runs *inside* Jeffspace, not the framework itself.

The framework is designed to support wildly different use cases in the same shell: a hardware team's evaluation workbench, a customer-branded product portal, an internal productivity suite — each configured independently, each loading the right modules for its context, each optionally carrying its own visual theme.

---

## Naming

| Thing | Name |
|---|---|
| The framework (shell + module system) | **Jeffspace Loader** |
| The default app (project launcher) | **Jeffspace** |
| An example project running in Jeffspace | Hardware Eval Platform |

The `hep-` prefix on bucket names and table names reflects the original prototype name. These should be renamed to a framework-neutral prefix (e.g. `jsl-`) before any production deployment, but the local dev environment retains `hep-` for now.

---

## Architecture Overview

### Entry Point

The user navigates to the shell with a URL that optionally points to a root config file in S3:

```
https://shell.example.com/?bucket=my-org&config=apps/hardware-eval/config.json
```

If no `?bucket=&config=` params are present, the shell loads Jeffspace from a well-known S3 location configured in the shell's deployment config.

Users may host valid modules in their own S3 buckets — IAM controls actual access. The shell does not restrict which buckets are valid sources.

### Shell Host (`apps/shell` + `module-shell-core`)

Responsibilities:
- Authenticate the user (Google Sign-In → AWS Cognito Identity Pool → temporary AWS credentials)
- Resolve the root `ModuleConfig` from S3 using those credentials
- Bootstrap the module loader
- Provide global context to the module tree: auth state, AWS credential provider, sign-out callback, edit mode flag

Auth is handled before any module is loaded. The module tree never deals with authentication directly — it receives context via hooks and uses the credential provider to access its own resources.

The shell has no awareness of specific modules (Jeffspace, layout modules, etc.). The only module it knows about is the one pointed to by the current URL — or the default app when no URL params are present.

Tech stack: React 19, Vite, Zustand, AWS SDK v3, Google Identity Services.

### Full-Screen Takeover

Loaded modules take over the full viewport. The shell has no persistent top bar or chrome. Apps that want a header, navigation, or user badge render those themselves as child slots. This makes any shell-level UI element — like the OAuth user badge — a first-class module, not a shell responsibility.

### SPA Navigation

Navigation between modules does not cause page reloads. Jeffspace (and any module) calls `history.pushState` to update the URL, then dispatches `window.dispatchEvent(new Event("shell:navigate"))`. The shell listens for this event, re-reads the URL, and lazy-loads the new module in place. Auth session is preserved in memory (and in `sessionStorage` for page refresh resilience).

---

## The Module System

### Core Principle

Every element in the UI — from the top-level layout to a single content pane — is a **module**. A module is a React component loaded from an S3 bundle, described by a config file also in S3. The shell and all modules share the same loading utility. The config schema is the contract.

**The framework is schema-agnostic beyond the loading contract.** The `children` array in a config is interpreted entirely by the module that receives it. The framework only requires enough structure to load a child bundle (`slotId`, `app.bucket`, `app.key`). Everything else — what `meta` means, how children are ordered, what makes a nav item vs. a slot — is the module's own domain. Different modules have completely different `children` schemas. No conventions are imposed at the framework level.

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

---

## Config Schema

### `ModuleConfig`

```ts
type ModuleConfig = {
  id: string;                        // unique identifier for this instance
  app: {
    bucket: string;                  // S3 bucket containing the bundle
    key: string;                     // S3 key for the JS bundle
    exportName?: string;             // named export to use (default: "default")
  };
  meta?: Record<string, unknown>;    // module-specific static configuration (opaque to framework)
  resources?: Resource[];            // AWS resources this module has access to
  children?: ChildSlot[];            // child slots — schema defined by the module, not the framework
};
```

### `ChildSlot`

The minimal structure the framework needs to load a child. Everything else in `meta` is the module's own schema.

```ts
type ChildSlot = {
  slotId: string;          // logical name; semantics defined by the parent module
  app: {
    bucket: string;
    key: string;
    exportName?: string;
  };
  meta?: Record<string, unknown>;   // module-defined; framework never reads this
  resources?: Resource[];
  children?: ChildSlot[];           // recursive; child modules have their own children
};
```

### `Resource`

Describes a dataset or AWS resource belonging to a module. Resources are declared in the module's config and registered globally at load time — any module in the tree can access any declared resource.

```ts
type Resource = {
  id: string;           // unique ID within the project
  label: string;        // human-readable name shown in the resource picker dialog
  type: "s3-object" | "s3-prefix" | "dynamodb" | "api" | "other";
  bucket?: string;
  key?: string;
  table?: string;
  endpoint?: string;
  mimeType?: string;
  meta?: Record<string, unknown>;
};
```

---

## Module Loading Protocol

### Two-Step Load

1. **Fetch config** — GET the `config.json` from S3, parse it as `ModuleConfig`
2. **Fetch bundle** — GET the JS bundle, execute it as an IIFE via a blob URL + script tag, extract the named export from `window.RemoteModule`

The IIFE format (not ES module) is used because browser dynamic imports cannot resolve bare specifiers (`react`, `module-core`) from blob URLs. The shell exposes shared dependencies as window globals; the module bundle declares them as externals referencing those globals.

### Critical: IIFE Build Requirements

All module Vite configs **must** include `exports: "named"` in the Rollup output options:

```ts
rollupOptions: {
  external: ["react", "react/jsx-runtime", "react-dom", "module-core"],
  output: {
    exports: "named",   // ← required: wraps default export as { default: fn }
    globals: { ... }
  }
}
```

Without this, Rollup returns the default export directly (`var RemoteModule = fn`) instead of as an object (`var RemoteModule = { default: fn }`). `loadModule` reads `rawModule["default"]`, so the component would never be found.

Additionally: `var RemoteModule` in a classic browser script creates a **non-configurable** window property. Do not attempt `delete window.RemoteModule` — it throws in strict mode. The IIFE load queue is serialised, so the next load safely overwrites the value.

### Shared Window Globals

The shell exposes shared dependencies synchronously at boot, before any module script runs:

```ts
window.__React            = React
window.__ReactJsxRuntime  = ReactJsxRuntime
window.__ReactDOM         = ReactDOM
window.__ModuleCore       = moduleCore   // all of module-core's exports
```

Each module's Vite/Rollup build marks these as external and maps them to the global names.

### Props Passed to Every Module

```ts
type ModuleProps = {
  config: ModuleConfig;
};
```

Everything else comes from shared React contexts — no prop tunneling:

| Context | Hook | What it provides |
|---|---|---|
| Auth | `useAuthContext()` | Credential provider, user profile, sign-out, S3 client factory, DDB client |
| Resource Registry | `useResource(id)` | Descriptor for any resource declared in the project |
| Edit Mode | `useEditMode()` | Whether the UI is in edit mode |

### `AuthContextValue`

```ts
type AuthContextValue = {
  awsCredentialProvider: () => Promise<AwsCredentials>;
  userProfile?: UserProfile;           // name, email, picture from OAuth
  signOut: () => void;
  getS3Client: (bucket?: string) => Promise<S3Client>;
  getDdbClient: () => Promise<DynamoDBDocumentClient>;
};
```

### `<SlotContainer>`

A shared React component in `module-core` that encapsulates the recursive loading logic for a single child slot. Modules call it explicitly — the framework never auto-renders children.

```tsx
// Module decides which child to render and where
<SlotContainer child={config.children?.find(c => c.slotId === "content")} />
```

`SlotContainer` handles: fetching the child config, fetching and running the IIFE bundle, Suspense fallback, error boundary, and (in edit mode) the configuration overlay. Modules do not call `loadModule` directly.

### `useReplaceModule()` (planned)

A hook that allows any running module to replace itself — update `config.app` in its own `config.json` on S3 and trigger shell re-navigation. Used by layout modules to let the user swap the root module in edit mode, and by Jeffspace to assign the first module to a new project.

```ts
const replaceModule = useReplaceModule();
// User picks a new module from the picker:
await replaceModule({ bucket: newEntry.bundleBucket, key: newEntry.bundlePath });
// → writes new config.json, dispatches shell:navigate
```

---

## Module Categories

Modules fall into three categories. The category appears in `package.json` under `jsl.category` and in the registry record. The module picker groups by category.

| Category | Description | Examples |
|---|---|---|
| `layout` | Structural frames with child slots | `layout-nav` (top bar + sidebar + content pane) |
| `app` | Self-contained full-frame applications | Jeffspace, hardware eval dashboard |
| `component` | Panels and widgets for use inside layouts | OAuth user badge, markdown viewer |

**Jeffspace and layout modules are not selectable from the module picker.** The picker is for choosing what goes *inside* a slot, not for infrastructure-level modules. Filtering is achieved simply: Jeffspace and the default app infrastructure are never published to the module registry. Only modules intended for use as project content appear there.

---

## Jeffspace — The Default Application

Jeffspace is a full-screen application built on Jeffspace Loader. It is the default experience when no `?config=` param is in the URL.

### Project List

Full-screen. Jeffspace manages its own header, navigation, and layout. The OAuth badge module can be included as a child slot by any app that wants it — Jeffspace included.

A tabbed interface with two tabs:
- **My Projects** — projects the user owns, sorted by most-recently-updated
- **Shared with Me** — projects where the user is a collaborator, via GSI query

Selecting a project opens a **details panel** showing project name, description, owner, last modified, and an **Open** button.

### New Project Flow

When the user creates a project:
1. A DynamoDB record and an S3 `config.json` scaffold are written
2. **The module picker opens inside Jeffspace** (no navigation yet)
3. The user picks a root module (e.g. `layout-nav`)
4. Jeffspace writes a full `config.json` pointing to that module
5. Navigation to the new project occurs

This means a project never exists in an uninitialized state. There is no separate "empty project" module — that responsibility lives within Jeffspace, which is the right place since it requires authentication to reach. `app-empty` has been removed as a standalone package.

### Navigation

URL is the navigation state. Opening a project sets `?bucket=&config=` via `history.pushState` + `shell:navigate`. Browser back returns to Jeffspace (bare URL).

### Project Registry Schema (DynamoDB)

```
Table: org-projects
PK: userId (OAuth email)
SK: projectId

Attributes:
  role: "owner" | "editor" | "viewer"
  rootConfigPath: string
  rootBucket: string
  displayName: string
  description?: string
  thumbnailKey?: string
  createdAt: string (ISO 8601)
  updatedAt: string (ISO 8601)

GSI: sharedWithUserId-updatedAt-index
  PK: sharedWithUserId
  SK: updatedAt
```

---

## Next Module: `layout-nav`

The first layout module. A three-zone frame:

- **Top bar** — rendered by the layout module itself; right area is a child slot for any component module (OAuth badge, search, etc.)
- **Left sidebar** — navigation list; each item is a child slot with a display configuration
- **Content pane** — renders the module for the selected nav item; shows a + button (via `useReplaceModule`) if that slot has no module yet

### Children Schema (layout-nav's own convention)

`layout-nav` interprets its `children` array as follows (this is the module's schema, not the framework's):

```jsonc
"children": [
  // Top-bar right slot — identified by meta.position
  {
    "slotId": "top-bar-right",
    "app": { "bucket": "...", "key": "modules/module-oauth-badge/bundle.js" },
    "meta": { "position": "top-bar-right" }
  },
  // Nav items — identified by meta.navDisplay; order in array = order in sidebar
  {
    "slotId": "nav-dashboard",
    "app": { "bucket": "...", "key": "modules/my-dashboard/bundle.js" },
    "meta": { "navDisplay": { "type": "text", "text": "Dashboard" } }
  },
  {
    "slotId": "nav-reports",
    "app": { "bucket": "...", "key": "modules/reports/bundle.js" },
    "meta": { "navDisplay": { "type": "image", "src": "s3://..." } }
  }
]
```

Nav items are flat (no nesting). Display type (text or image) is chosen per-item by the user in edit mode. The top-bar slot has no fixed position requirement — if `meta.position === "top-bar-right"` is absent, the top-bar right area is simply empty.

### Edit Mode Behaviour

- Add nav item → opens module picker → writes new child into config
- Remove nav item → removes child from config
- Reorder → reorders children array in config
- Change display type → updates `meta.navDisplay` in that child's config entry
- Swap root module → calls `useReplaceModule()` (replaces the layout module itself)
- Swap content in a slot → `SlotContainer` edit overlay handles it

---

## Next Module: `module-oauth-badge` (component)

The OAuth user badge — showing the user's avatar/name, with a dropdown for sign-out and profile actions — is a standalone **component** module. First real-world test that the framework can host framework-level UI as a component.

Uses `useAuthContext()` for `userProfile` and `signOut`. No special access needed. Designed to sit in whatever slot the parent module assigns — no assumptions about position.

---

## Global Resource Registry

Data belongs to the project, not to individual modules. Resources are declared in whichever module's config owns them, but all resources from the entire config tree are aggregated into a single global context that any module can read from.

Registration is **lazy** — resources are added to the registry as each module's config is fetched, not by pre-crawling the entire tree at startup.

```ts
const csvFile = useResource("component-database-csv");
```

---

## Edit Mode

A global boolean context (`EditModeContext`) flowing down the entire module tree.

When `editMode` is `true`:
- Every `<SlotContainer>` renders an overlay indicating it is configurable
- Clicking the overlay opens the module picker for selecting or replacing the module in that slot
- On confirm, the parent module's `config.json` is written back to S3 with the updated child

Edit mode is toggled at the shell level. `SlotContainer` renders the overlays. Modules implement none of this logic except for the root-level swap (via `useReplaceModule()`).

### Permission Model

IAM controls actual S3 write access. The DynamoDB project record lists the owner and authorized editors. Failed writes degrade gracefully.

---

## Concurrent Edit Locking

```
Table: org-projects-locks
PK: projectId
Attributes:
  lockedBy: string
  lockedAt: string
  ttl: number           // DynamoDB auto-expires
```

Lock acquired on edit mode entry (TTL 30 min), refreshed by heartbeat, deleted on clean exit. Other users see "Editing locked by jeff@…". Owners/editors may override.

---

## Project Export & Archive

1. Shell reads the full config tree to enumerate all loaded modules
2. For each module that exports an `onExport` function, the shell calls it sequentially
3. Each module fetches its external data and writes it into its subdirectory
4. Shell downloads the entire S3 prefix as a zip including `manifest.json`

```ts
export async function onExport(ctx: {
  config: ModuleConfig;
  s3: S3Client;
  projectPrefix: string;
}): Promise<void> { ... }
```

---

## Shared Dependencies & Build Strategy

- Shell exposes React, ReactDOM, and module-core as window globals at boot
- Module builds declare these as externals mapped to the global names
- IIFE format (`format: "iife"`, `name: "RemoteModule"`) — not ES module — to avoid bare specifier failures in blob URL contexts
- **`exports: "named"` required** in Rollup output — ensures `{ default: Component }` structure
- IIFE loads are serialised through a module-level queue to prevent `window.RemoteModule` race conditions

---

## Packages in This Monorepo

| Package | Purpose | Status |
|---|---|---|
| `apps/shell` | Public shell host: sign-in UI, first-stage bootstrap, protected bundle loader | Working |
| `module-shell-core` | Authenticated runtime: contexts, AWS clients, root module navigation/loading | Working |
| `module-core` | Shared types, `<SlotContainer>`, `loadModule()`, `ModulePicker`, `useModuleRegistry`, contexts, hooks | Working |
| `app-landing` | Jeffspace — the default organizational project launcher | Working |
| `module-template` | Starter template for new modules | Working |
| `scripts/` | `reset-local.ts`, `seed-local.ts`, `update-locals.ts`, `publish-module.ts` | Working |

Planned:
| Package | Purpose |
|---|---|
| `layout-nav` | First layout module: top bar + left sidebar nav + content pane |
| `module-oauth-badge` | User avatar/name badge with sign-out dropdown — first component module |
| `app-markdown-viewer` | Renders markdown from an S3 resource |
| `app-task-board` | Jira-like task board backed by DynamoDB |

Removed:
| Package | Reason |
|---|---|
| `app-empty` | Absorbed into Jeffspace; empty-project picker now lives in the default app behind authentication |

---

## Module Registry

The edit-mode picker draws modules from the registry. Only modules intended for use as project content are published — infrastructure modules (Jeffspace, layout shells) are never registered and therefore never appear in the picker.

### Publishing

```
npx tsx scripts/publish-module.ts --local --module=layout-nav   # local MinIO
npx tsx scripts/publish-module.ts --module=layout-nav            # real AWS
```

`jsl` metadata in the module's `package.json` drives the registry record:

```json
"jsl": {
  "displayName": "Nav Layout",
  "category": "layout",
  "description": "Top bar + sidebar navigation + content pane"
}
```

### Registry Schema (DynamoDB)

```
Table: module-registry
PK: moduleName
SK: version (semver or "latest" pointer)

Attributes:
  ownerId, bundlePath, bundleBucket, category,
  displayName, description, publishedAt/updatedAt
```

---

## Local Development Workflow

### Infrastructure

DynamoDB Local + MinIO in Docker Compose. Both use the standard AWS SDK — only the endpoint URL changes.

### S3 Access in Local Dev

The Vite dev server **does not proxy S3**. MinIO is accessed directly at `localhost:9000` from the browser. SigV4 request signatures break when routed through a proxy (the signed path no longer matches the actual path). Buckets are made fully public in the seed script (`PutBucketPolicyCommand` with `s3:GetObject` + `s3:PutObject`) — a local-dev-only convenience.

DynamoDB Local **is** proxied through the Vite dev server (`/__local_ddb`) to avoid CORS on that endpoint.

```
VITE_LOCAL_S3_ENDPOINT=http://localhost:9000     ← direct to MinIO
VITE_LOCAL_DYNAMODB_ENDPOINT=http://localhost:5173/__local_ddb  ← proxied
VITE_LOCAL_BUCKETS=hep-dev-modules,hep-dev-registry
VITE_LOCAL_AWS_ACCESS_KEY_ID=minioadmin
VITE_LOCAL_AWS_SECRET_ACCESS_KEY=minioadmin
```

### Per-Bucket Endpoint Routing

The S3 client factory checks `VITE_LOCAL_BUCKETS` before creating each client — local buckets route to MinIO, all others route to real AWS. Absent from production builds entirely.

### Developer Lifecycle

**Phase 1 — Source alias**: Module aliased directly into shell via Vite. Fast HMR, no build step.

**Phase 2 — Local test publish**: Full build → version → upload → registry record against MinIO + DynamoDB Local. Exercises the complete path.

**Phase 3 — Real publish**: Same script, no `--local`.

---

## Open Questions / Decisions

| Topic | Decision |
|---|---|
| Config source | URL params (`?bucket=&config=`); any bucket allowed; IAM controls access |
| Default when no params | Load Jeffspace from well-known S3 path in shell deployment config |
| Module versioning | Latest-pointer model (`bundle.js`); registry retains all versions |
| Module format | IIFE with `exports: "named"`; window globals for shared deps |
| Module registry | Internal DynamoDB table; infrastructure modules never published |
| Write permissions | Role from DynamoDB drives UI; graceful failure on actual write |
| Local dev S3 | Direct to MinIO (no proxy); public bucket policy |
| Local dev DDB | Proxied through Vite dev server |
| Shell chrome | None — full-screen takeover |
| OAuth user badge | Standalone component module; slots wherever parent decides |
| Navigation | URL is state; `history.pushState` + `shell:navigate` event; no page reloads |
| Empty project state | No longer a separate module; picker lives in Jeffspace (behind auth) |
| Children schema | Module-defined; framework is agnostic beyond `{ slotId, app }` |
| Root module swap | `useReplaceModule()` hook (to be built in module-core) |
| Shared projects display | Tabbed (My Projects / Shared with Me); selection opens details panel |
| `signOut` in context | Yes — in `AuthContextValue` so any module can trigger it |
