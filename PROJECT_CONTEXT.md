# Jeffspace Loader — Project Context

## Vision

A generic, config-driven micro-frontend framework that assembles a full web application at runtime from independently deployable React modules. The framework has no opinion about what those modules do — they could be hardware evaluation tools, project management dashboards, branded customer portals, or anything else. The shell authenticates the user, resolves a root config file from S3, and recursively loads the module tree. Every module follows the same protocol, so the shell never needs to know what a module does — only how to load it.

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

### Auth Shell (`auth-shell`)

Responsibilities:
- Authenticate the user (Google Sign-In → AWS Cognito Identity Pool → temporary AWS credentials)
- Resolve the root `ModuleConfig` from S3 using those credentials
- Bootstrap the recursive module loader
- Provide global context to the module tree: auth state, AWS credential provider, sign-out callback, edit mode flag

Auth is handled before any module is loaded. The module tree never deals with authentication directly — it receives context via hooks and uses the credential provider to access its own resources.

Tech stack: React 19, Vite, Zustand, AWS SDK v3, Google Identity Services.

### Full-Screen Takeover

Loaded modules take over the full viewport. The shell has no persistent top bar or chrome. The reasoning: the top-level frame exists only as an orientation structure for the app's flow, and a persistent shell bar would intrude on every loaded application. Modules that want a header, navigation, or user badge are responsible for rendering those themselves.

This means any shell-level UI element — like the OAuth user badge — must be available as an importable module that top-level apps can include as a child slot. This is intentional: it makes the badge itself a first-class test of the module framework.

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
  theme?: {
    cssKey?: string;                 // S3 key for a project-level stylesheet
    cssBucket?: string;              // S3 bucket for the stylesheet (defaults to app bucket)
  };
  resources?: Resource[];            // AWS resources this module has access to
  children?: ChildSlot[];            // named child slots, each with their own config
};
```

### `Resource`

Describes a dataset or AWS resource belonging to a module. Resources are declared in the module's config and registered globally at load time — any module in the tree can access any declared resource.

```ts
type Resource = {
  id: string;           // unique ID within the project
  label: string;        // human-readable name shown in the resource picker dialog
  type: "s3-object" | "s3-prefix" | "dynamodb" | "api" | "other";
  bucket?: string;      // for S3 types
  key?: string;         // for s3-object: exact key; for s3-prefix: directory prefix
  table?: string;       // for dynamodb
  endpoint?: string;    // for api
  mimeType?: string;    // hint for consumers (e.g. "text/csv", "image/png")
  meta?: Record<string, unknown>;
};
```

### `ChildSlot`

A named slot within a module's layout that is filled by a child module.

```ts
type ChildSlot = {
  slotName: string;       // logical name (e.g. "content", "left-nav", "user-badge")
  configPath: string;     // S3 key for the child module's config.json
  configBucket?: string;  // defaults to the parent's bucket
};
```

---

## Module Loading Protocol

### Two-Step Load

1. **Fetch config** — GET the `config.json` from S3, parse it as `ModuleConfig`
2. **Fetch bundle** — GET the JS bundle, execute it as an IIFE via a blob URL + script tag, extract the named export from `window.RemoteModule`

The IIFE format (not ES module) is used because browser dynamic imports cannot resolve bare specifiers (`react`, `module-core`) from blob URLs. The shell exposes shared dependencies as window globals; the module bundle declares them as externals referencing those globals.

### Theme Injection

If the resolved `ModuleConfig` contains a `theme.cssKey`, the shell fetches that stylesheet from S3 and injects it as a `<link>` into `<head>` before rendering the module. On navigation away, the stylesheet is removed. This gives each project full visual control — custom color schemes, fonts, branding images — without any module code changes.

CSS custom properties (`--color-primary`, `--font-body`, etc.) are the right primitive: the shell defines defaults, the theme stylesheet overrides them, and modules reference the variables rather than hardcoding values.

### Shared Window Globals

The shell exposes shared dependencies synchronously at boot, before any module script runs:

```ts
window.__React            = React
window.__ReactJsxRuntime  = ReactJsxRuntime
window.__ReactDOM         = ReactDOM
window.__ModuleCore       = moduleCore   // all of module-core's exports
```

Each module's Vite/Rollup build marks these as external and maps them to the global names. This is a lightweight alternative to Module Federation.

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
  signOut: () => void;                 // clears session; modules (e.g. user badge) call this
  getS3Client: (bucket?: string) => Promise<S3Client>;
  getDdbClient: () => Promise<DynamoDBDocumentClient>;
};
```

`signOut` is in the context so that any module (including the OAuth badge module) can trigger it without reaching into the shell's internal store.

### `<SlotContainer>`

A shared React component (in `module-core`) that encapsulates the recursive loading logic:

- Calls the loader with the child's `configPath` and `configBucket`
- Renders a loading state while fetching
- Renders an error boundary if loading fails
- In edit mode, renders a configuration overlay on top of the loaded child

All modules use `<SlotContainer>` for every child slot.

---

## The OAuth User Badge (Planned Module)

The OAuth user badge — showing the user's avatar and name, with a dropdown for sign-out and profile actions — is a standalone module, not part of the shell chrome.

**Why a module?** Because the shell has no persistent top bar (full-screen takeover model). Apps that want the badge include it as a child slot; apps that don't (e.g. a kiosk display, an embedded view) simply omit it. This is intentional: the badge is the first real test that the module framework can host framework-level UI, not just application content.

The badge module uses `useAuthContext()` for `userProfile` (avatar, name) and `signOut`. It needs no special access — it's a pure consumer of the auth context like any other module.

Jeffspace includes the badge as a child slot. Custom top-level apps can do the same by adding it to their `children` array in their root config.

---

## Global Resource Registry

Data belongs to the project, not to individual modules. Resources are declared in whichever module's config owns them, but all resources from the entire config tree are aggregated into a single global context that any module can read from.

Registration is **lazy** — resources are added to the registry as each module's config is fetched, not by pre-crawling the entire tree at startup.

```ts
// inside any module component
const csvFile = useResource("component-database-csv");
```

The `Resource` descriptor provides the address. The module fetches actual data using `useAwsS3Client()` or `useAwsDdbClient()` from context.

### Resource ID Uniqueness

Resource `id` values must be unique within a project. Convention: `{moduleId}/{descriptive-name}`.

---

## Edit Mode

A global boolean context (`EditModeContext`) flowing down the entire module tree.

When `editMode` is `true`:
- Every `<SlotContainer>` renders an overlay/border indicating it is configurable
- Clicking the overlay opens a picker for selecting or replacing the module in that slot
- The user can delete a slot's module
- On confirm, the parent module's `config.json` is written back to S3

Edit mode is toggled at the shell level; individual modules implement none of this logic.

### Permission Model

IAM controls actual S3 write access. The DynamoDB project record lists the owner and authorized editors. If the user's credentials lack write access despite the role record suggesting otherwise, the worst outcome is a failed S3 write — the UI degrades gracefully.

---

## Jeffspace — The Default Application

Jeffspace is a full-screen application built on Jeffspace Loader. It is the default experience when no `?config=` param is in the URL, and it demonstrates what a polished top-level application looks like within the framework.

### Layout

Full-screen. No shell chrome. Jeffspace manages its own header, navigation, and layout. The OAuth badge module is included as a child slot — positioned in the corner, optional, demonstrating the framework's composability.

### Project List

Jeffspace's main view is a **tabbed interface** with two tabs:

- **My Projects** — projects the user owns, sorted by most-recently-updated, single DynamoDB query (one page of results)
- **Shared with Me** — projects where the user is a collaborator, queried via a separate GSI

The tabbed layout is preferred over two separate listboxes because it keeps selection and details state simple: whichever tab is active drives which project's metadata is shown in the details panel.

### Project Selection & Details

Selecting a project in either tab opens a **details panel** (slide-in or side panel) showing:
- Project name
- Thumbnail image (if `thumbnailKey` is set)
- Description
- Owner (for shared projects)
- Last modified date
- An **Open** button that navigates to the project (`?bucket=&config=`)

This two-stage interaction keeps the project list lightweight — card data comes from the DynamoDB query, richer metadata loads only on selection.

### Creating a Project

A **+** button in Jeffspace's own header opens a new project flow. On completion it:
1. Writes a new `config.json` scaffold to S3 under `projects/{newId}/`
2. Writes a DynamoDB record for the new project
3. Navigates to the new project URL

The + button is part of Jeffspace, not the shell. Other top-level apps do not inherit it.

### Navigation

The URL is the navigation state. Opening a project sets `?bucket=&config=` and navigates. The browser's back button returns to Jeffspace (bare URL). No home button needed — users bookmark Jeffspace and their frequent projects directly.

### Project Registry Schema (DynamoDB)

```
Table: org-projects
PK: userId (OAuth email or Cognito identity ID)
SK: projectId

Attributes:
  role: "owner" | "editor" | "viewer"
  rootConfigPath: string        // S3 key for the project's root config.json
  rootBucket: string
  displayName: string
  description?: string
  thumbnailKey?: string         // S3 key for a preview image
  createdAt: string (ISO 8601)
  updatedAt: string (ISO 8601)

GSI: sharedWithUserId-updatedAt-index
  PK: sharedWithUserId          // the collaborator's userId
  SK: updatedAt                 // for sort order in "Shared with Me" tab
```

The GSI on `sharedWithUserId` enables the "Shared with Me" tab to query in a single call without scanning. Design this GSI into the table at creation — retrofitting it is possible but disruptive.

### Resource Provisioning

Default resources provisioned at project creation:
- An S3 prefix (`projects/{projectId}/`) owned by the project
- One shared DynamoDB table (`{projectId}-data`) for all modules in the project, with module-prefixed keys to avoid collisions

---

## Project Export & Archive

Before deletion or for backup, the shell produces a self-contained zip of the project.

### Export Flow

1. Shell reads the full config tree to enumerate all loaded modules
2. For each module that exports an `onExport` function, the shell calls it sequentially
3. Each module fetches its external data and writes it into its subdirectory under the project prefix
4. Shell downloads the entire S3 prefix as a zip including `manifest.json`

### Module Export Protocol

```ts
export async function onExport(ctx: {
  config: ModuleConfig;
  s3: S3Client;
  projectPrefix: string;
}): Promise<void> {
  // fetch external data, write to S3
}
```

Modules that only use S3 resources need not implement `onExport`.

### Project Manifest (`manifest.json`)

Authoritative record of everything the project owns or depends on.

```json
{
  "projectId": "hardware-eval-abc123",
  "createdAt": "2026-03-31T00:00:00Z",
  "s3": { "bucket": "my-org-apps", "prefix": "projects/hardware-eval-abc123/" },
  "provisionedResources": [
    { "type": "dynamodb", "table": "hardware-eval-abc123-data", "region": "us-east-2" }
  ],
  "externalSources": [
    { "moduleId": "bom-editor", "type": "api", "endpoint": "https://erp.internal/api/bom" }
  ]
}
```

---

## Concurrent Edit Locking

```
Table: org-projects-locks
PK: projectId
Attributes:
  lockedBy: string      // OAuth email of the active editor
  lockedAt: string
  ttl: number           // Unix epoch; DynamoDB auto-expires
```

Lock acquired on edit mode entry (TTL 30 min), refreshed by heartbeat, deleted on clean exit. Other users see "Editing locked by jeff@…". Owners/editors may override the lock.

---

## Shared Dependencies & Build Strategy

- Shell exposes React, ReactDOM, and module-core as window globals at boot
- Module builds declare these as externals mapped to the global names
- IIFE format (`format: "iife"`, `name: "RemoteModule"`) — not ES module — to avoid bare specifier failures in blob URL contexts
- Each module is serialised through a queue to prevent `window.RemoteModule` race conditions during concurrent slot loads

---

## Packages in This Monorepo

| Package | Purpose | Status |
|---|---|---|
| `auth-shell` | Host application: auth, config resolution, module bootstrapping | Working |
| `module-core` | Shared types, `<SlotContainer>`, `loadModule()`, contexts, hooks | Working |
| `app-landing` | Jeffspace — the default organizational project launcher | In progress |
| `module-template` | Starter template for new modules | Working |
| `scripts/` | `seed-local.ts`, `publish-module.ts` | Working |

Planned modules:
| `module-oauth-badge` | Reusable user avatar/name badge with sign-out dropdown — first framework-level module | Planned |
| `app-markdown-viewer` | Simple module: renders markdown from an S3 resource | Planned |
| `app-tab-viewer` | Module with a top tab bar; each tab is a child slot | Planned |
| `app-task-board` | Jira-like task board backed by DynamoDB | Planned |

---

## Module Registry

The edit-mode picker draws modules from one or more registries.

### Publishing & Ownership

- Users publish modules by name. The original publisher owns all versions under that name.
- Published modules are versioned. The registry retains all historical versions alongside latest.
- Configs reference modules by name and resolve to the latest bundle at load time (latest-pointer model).

### Module Registry Record (DynamoDB)

```
Table: module-registry
PK: moduleName (e.g. "jeff/tab-viewer")
SK: version (semver, e.g. "1.0.0"; "latest" is a pointer record)

Attributes:
  ownerId, bundlePath, bundleBucket, category, displayName,
  description?, thumbnailUrl?, publishedAt, tags?
```

### External Registries

Root-level configs may declare external registries:

```json
{ "externalRegistries": [{ "name": "Partner Org", "endpoint": "https://…/registry.json" }] }
```

The shell merges their listings into the picker at startup.

---

## Local Development Workflow

### Infrastructure

DynamoDB Local + MinIO in Docker Compose (`docker-compose.yml`). Both use the standard AWS SDK — only the endpoint URL changes between local and production.

Chosen over LocalStack: DynamoDB Local is maintained by Amazon (exact API compatibility); MinIO is battle-tested S3-compatible storage. Lighter weight and covers exactly what this platform needs.

### Vite Proxy for Local S3 and DynamoDB

Browser requests to MinIO and DynamoDB Local are routed through the Vite dev server proxy to avoid CORS issues entirely:

```
VITE_LOCAL_S3_ENDPOINT=http://localhost:5173/__local_s3
VITE_LOCAL_DYNAMODB_ENDPOINT=http://localhost:5173/__local_ddb
```

The Vite config proxies `/__local_s3/*` → `localhost:9000` and `/__local_ddb/*` → `localhost:8000`. The browser never makes cross-origin requests.

### The Publish Script

`scripts/publish-module.ts` is the same script for local test publishes and real publishes — only the endpoint config changes.

1. Runs `vite build` in the target module directory
2. Versions the output: writes `bundle.v{semver}.js`, updates `bundle.js` pointer
3. Uploads to S3 (MinIO locally, real S3 in production)
4. Writes/updates the module registry record in DynamoDB

```
npm run publish-module -- --module=app-landing --local   # local MinIO
npm run publish-module -- --module=app-landing            # real AWS
```

### Full Developer Lifecycle

**Phase 1 — Source alias**: Module aliased directly into shell via Vite. Fast HMR, no build step. Good for initial UI development.

**Phase 2 — Local test publish**: Full build → version → upload → registry record against MinIO + DynamoDB Local. Exercises the complete path including edit mode, config writes, and slot configuration.

**Phase 3 — Real publish**: Same script, no `--local`. Behavior identical to Phase 2.

### Per-Developer Isolation

```
npm run seed -- --developer=jeff        # scaffold dev project
npm run seed -- --developer=jeff --reset  # wipe and re-seed
```

The seed script creates buckets, DynamoDB tables, a scaffold `config.json`, and a project record. Each developer runs their own Docker instance.

### Per-Bucket Endpoint Routing

```
VITE_LOCAL_BUCKETS=hep-dev-modules,hep-dev-registry
```

The S3 client factory checks this list before creating each client — local buckets route to MinIO, others route to real AWS. Entirely absent from production builds.

---

## Open Questions / Decisions

| Topic | Decision |
|---|---|
| Config source | URL params (`?bucket=&config=`); any bucket allowed; IAM controls access |
| Default when no params | Load Jeffspace from well-known S3 path in shell deployment config |
| Module versioning | Latest-pointer model (`bundle.js`); registry retains all versions |
| Module format | IIFE with window globals; not ES module (blob URL bare specifier limitation) |
| Module registry | Internal primary + external registries declared in root config |
| Write permissions | Role from DynamoDB drives UI; graceful failure on actual write |
| IAM policy sync | Direct SDK calls from owner's credentials; no Lambda required |
| Local dev infrastructure | DynamoDB Local + MinIO in Docker; Vite proxy eliminates CORS |
| Shell chrome | None — full-screen takeover; shell has no persistent top bar |
| OAuth user badge | Standalone module, optional child slot; first framework-level module |
| Navigation | URL is state; browser back returns to Jeffspace; no home button |
| Theming | CSS file loaded from S3 path in `config.theme.cssKey`; CSS custom properties |
| Shared projects display | Tabbed (My Projects / Shared with Me); selection opens details panel |
| Shared projects query | GSI on `sharedWithUserId` + `updatedAt` sort key in `org-projects` table |
| `signOut` in context | Yes — in `AuthContextValue` so badge module can trigger it via hook |
