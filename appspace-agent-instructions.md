# Appspace Agent Instructions

This document is for a new agent/session working with Jeff in the appspace workspace. It explains how to use the local bridge, browser appspace APIs, organizer graph, and local runtime tools without bypassing the app's persistence model.

## Operating Model

The browser agent is the primary appspace participant. It has the live browser context: current project, visible module tree, loaded module resources, assets, organizer state, and CloudFront/app persistence access.

The local bridge/runtime is a capability escalation layer. It can read and write local workspace files, run shell/Python/PDF tools, and queue appspace operations for the browser to execute. When the bridge is enabled, the local runtime should be allowed to manipulate the workspace, but appspace mutations should go through browser appspace APIs or bridge-queued appspace operations.

Do not directly edit S3/DynamoDB/project storage unless Jeff explicitly asks for that. If an appspace API is missing or broken, fix or extend the API instead of patching remote storage by hand.

## Bridge Connection

Default local bridge:

- Host: `127.0.0.1`
- Port: `4317`
- Health endpoint: `GET /health`
- RPC endpoint: `POST /rpc`
- Auth: optional. If the bridge was started with `AGENT_BRIDGE_TOKEN`, send `Authorization: Bearer <token>`. Installer-managed local bridges may run tokenless on loopback.

Example health check:

```bash
curl -sS http://127.0.0.1:4317/health
```

Example RPC call:

```bash
curl -sS -X POST http://127.0.0.1:4317/rpc \
  -H 'Content-Type: application/json' \
  --data '{"method":"get_bridge_status","params":{}}'
```

Bridge RPC responses are shaped like:

```json
{ "ok": true, "result": {} }
```

or:

```json
{ "ok": false, "error": "message" }
```

## Startup Checklist For A New Agent

1. Check bridge health.
2. Call `get_bridge_status`.
3. Confirm at least one browser appspace session is synced before relying on appspace context.
4. If `appspaceSessions` is empty, ask Jeff to open the app and enable the chat module local runtime checkbox.
5. Call `get_appspace_context` or `get_organizer_overview`.
6. Use appspace APIs for project/module/asset/organizer mutations.
7. Use local filesystem/shell/Python APIs for local analysis, generation, conversion, and repo changes.

## Bridge Capabilities

Current bridge capability families:

- `filesystem`
- `shell`
- `python`
- `pdf_text`
- `workspace_root`
- `appspace_context`
- `appspace_operation_queue`
- `organizer_memory`

Useful bridge methods:

- `get_bridge_status`
- `set_workspace_root`
- `list_workspace_files`
- `read_workspace_file`
- `write_workspace_file`
- `run_workspace_command`
- `get_python_environment`
- `check_python_dependencies`
- `install_python_dependencies`
- `run_python_script`
- `extract_pdf_text`
- `sync_appspace_context`
- `get_appspace_context`
- `search_appspace_assets`
- `queue_appspace_operation`
- `list_appspace_operations`
- `complete_appspace_operation`

Organizer bridge methods:

- `get_organizer_overview`
- `list_work_scope_index`
- `search_work_scope_graph`
- `get_work_scope_context`
- `create_work_scopes`
- `replace_organizer_store`
- `update_work_scope`
- `archive_work_scope`
- `list_organizer_items`
- `create_organizer_items`
- `upsert_sweep_review`
- `batch_update_organizer_items`
- `mark_organizer_items_complete`

The browser normally calls `sync_appspace_context` and `complete_appspace_operation`. A local agent should usually not manually complete its own queued operations.

## Appspace Session Behavior

Bridge appspace read APIs depend on browser-synced appspace sessions. If no session is synced, calls that need appspace context will fail or return no useful data.

Important: `/health` only proves the local bridge service is running. It does not mean appspace content is available. Appspace content becomes available only after a Jeffspace browser tab with a chat module has local runtime enabled and has successfully called `sync_appspace_context`. Verify this with `get_bridge_status`; a ready bridge has at least one `appspaceSessions` entry.

Mutation APIs such as `create_work_scopes`, `create_organizer_items`, `update_work_scope`, and `upsert_sweep_review` queue operations for the browser and wait for the browser to execute them. The browser remains the appspace persistence owner.

If an operation times out:

1. Confirm the app is open.
2. Confirm local runtime/bridge is enabled in the chat UI.
3. Confirm `get_bridge_status` shows at least one `appspaceSessions` entry.
4. Retry with a longer `timeoutMs`, for example `120000`.

## Common RPC Examples

Get appspace context:

```bash
curl -sS -X POST http://127.0.0.1:4317/rpc \
  -H 'Content-Type: application/json' \
  --data '{"method":"get_appspace_context","params":{}}'
```

Search work scopes:

```bash
curl -sS -X POST http://127.0.0.1:4317/rpc \
  -H 'Content-Type: application/json' \
  --data '{"method":"search_work_scope_graph","params":{"query":"zener smoke short","includeArchived":false}}'
```

Expand context around a scope:

```bash
curl -sS -X POST http://127.0.0.1:4317/rpc \
  -H 'Content-Type: application/json' \
  --data '{"method":"get_work_scope_context","params":{"scopeId":"scope-id","direction":"both","depth":3,"includeLinkedItems":true}}'
```

Create a linked organizer item:

```bash
curl -sS -X POST http://127.0.0.1:4317/rpc \
  -H 'Content-Type: application/json' \
  --data '{"method":"create_organizer_items","params":{"items":[{"kind":"todo","title":"Follow up with lab","details":"Ask for quote timing and sample handling.","status":"open","scopeIds":["scope-vendor-tests"],"followUpAt":"2026-06-08"}],"timeoutMs":120000}}'
```

Update a work scope:

```bash
curl -sS -X POST http://127.0.0.1:4317/rpc \
  -H 'Content-Type: application/json' \
  --data '{"method":"update_work_scope","params":{"scopeId":"scope-id","patch":{"status":"blocked","notes":"Waiting on vendor quote."},"timeoutMs":120000}}'
```

Queue a generic browser appspace operation:

```bash
curl -sS -X POST http://127.0.0.1:4317/rpc \
  -H 'Content-Type: application/json' \
  --data '{"method":"queue_appspace_operation","params":{"operation":"focus_slot","args":{"slotPath":["some-slot-id"]},"timeoutMs":120000}}'
```

## Browser Appspace API Families

The browser agent and bridge-queued operations expose APIs in these families:

Project/appspace:

- `get_workspace_summary`
- `get_appspace_context`
- `get_root_config`
- `list_slot_tree`
- `focus_slot`
- `upsert_slot`
- `remove_slot`
- `upsert_root_slot`
- `remove_root_slot`
- `update_root_config`
- `list_available_modules`
- `list_registered_resources`

Assets:

- `list_project_assets`
- `read_project_asset`
- `create_text_asset`
- `import_workspace_file_as_asset`
- `export_project_asset_to_workspace`
- `attach_project_asset_to_work_item`
- `attach_project_asset_to_task`

Module creation and content:

- `create_markdown_file_set`
- `create_markdown_slot_from_content`
- `read_markdown_slot`
- `replace_markdown_slot_content`
- `create_document_viewer_slot`
- `replace_document_viewer_asset`
- `create_documentation_slot`
- `read_documentation_tree`
- `search_documentation_content`
- `read_documentation_pages`
- `create_documentation_page`
- `update_documentation_page`
- `rename_documentation_page`
- `move_documentation_page`
- `delete_documentation_page`
- `create_work_manager_slot`
- `list_work_manager_items`
- `create_work_manager_items`
- `update_work_manager_item`
- `delete_work_manager_item`
- `replace_work_manager_items`
- `create_task_tracker_slot`
- `list_task_tracker_tasks`
- `create_task_tracker_tasks`
- `update_task_tracker_task`
- `delete_task_tracker_task`
- `create_links_slot`
- `set_links_slot_items`
- `create_webview_slot`
- `set_webview_url`

Organizer and work scope:

- `get_organizer_overview`
- `list_work_scope_index`
- `search_work_scope_graph`
- `get_work_scope_context`
- `list_work_scopes`
- `create_work_scopes`
- `update_work_scope`
- `archive_work_scope`
- `list_organizer_items`
- `create_organizer_items`
- `update_organizer_item`
- `delete_organizer_item`
- `batch_update_organizer_items`
- `mark_organizer_items_complete`
- `upsert_sweep_review`

Legacy objective tools may still exist and map to scopes:

- `list_work_objectives`
- `create_work_objectives`
- `update_work_objective`
- `archive_work_objective`

Prefer the newer work scope APIs.

## Organizer Model

The organizer is moving toward a graph of work scopes. A work scope is a durable unit of context that can be broad or narrow:

- Hardware validation
- Vendor testing
- Fire hazard test plan
- 3.3 V rail short investigation
- Follow-up with outside lab

Scopes form a parent/child graph that usually reads broad-to-narrow. The agent should be able to search the graph, move upstream for larger objective context, move downstream for detailed status, and reorganize scopes as the work changes.

Organizer items are smaller actionable or reference objects linked to scopes:

- `note`
- `todo`
- `follow-up`
- `waiting-on`
- `idea`
- `reminder`

Done/archived items should usually be ignored unless Jeff asks for historical context.

## Agent Sweep Behavior

When Jeff asks for a sweep, do not just list graph items. Produce useful work guidance in plain language.

Good sweep output should include:

- Status by meaningful work area, not by storage object.
- What needs attention now.
- What is blocking other progress.
- Quick follow-ups Jeff can complete.
- A checklist-style set of proposed updates where Jeff can mark items complete or ignore them.

The persisted sweep review should carry forward unchecked items, append new useful items, and avoid preserving more than one prior sweep. Items Jeff ignores should stop reappearing unless new evidence makes them relevant again.

Avoid phrasing like "the graph shows" or "I can see from the execution environment." Talk about the work itself.

## Local Files, Shell, Python, And PDFs

Use local bridge tools for local workspace tasks:

- Read/write local project files.
- Run tests/builds.
- Generate or transform files.
- Extract PDF text.
- Run Python analysis scripts.

Bridge Python dependency installation is allowlisted. Known allowed packages include:

- `beautifulsoup4`
- `lxml`
- `openpyxl`
- `pandas`
- `pillow`
- `pypdf`
- `python-docx`
- `requests`

Use local files for generated artifacts when that is appropriate, then import/export through appspace asset APIs if the appspace needs to own the file.

## Module And Asset Rules

Assets should be shared appspace objects so multiple modules can reference the same file. For example, a PDF imported by a markdown viewer should be available to a document viewer or documentation page.

When creating or updating modules:

1. Use module APIs where available.
2. Store files as project assets when they should be reusable.
3. Attach or reference assets from module instances.
4. Keep appspace changes within the core/module APIs rather than expanding the auth shell.

Useful module patterns:

- Markdown viewer: create linked markdown structures with documents/images as assets.
- Document viewer: point to an existing PDF/document asset.
- Documentation editor: create structured pages and diagrams.
- Work manager: create schedules, milestones, tasks, dependencies.
- Organizer/chat: manage work scopes, small reminders, notes, and sweep reviews.

## Safety And Collaboration Norms

- Prefer appspace APIs over direct storage edits.
- If an API is insufficient, modify the API rather than bypassing it.
- Do not run reset/destructive commands unless Jeff explicitly asks.
- If project data disappears or looks wrong, investigate before changing more.
- Keep the auth shell thin; new functionality should live in core or modules.
- For browser/local split behavior, preserve both Mac and Windows local workflows.
- Report exact files changed, APIs used, and any operations that timed out or failed.
