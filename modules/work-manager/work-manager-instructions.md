# Work Manager Agent Guide

This document tells an agent how to use `modules/work-manager` correctly through the appspace APIs and how to author schedules in the style Jeff prefers.

The guidance below is based on:

- the actual implementation in [modules/work-manager/src/index.tsx](./src/index.tsx)
- the browser tool schemas exposed by `module-agent-chat`
- the live KAS-HW example schedule at:
  - `KAS-2 -> Design -> Dev Schedule`
  - slot path: `["left-mq2qu15d","tab-mq58ntwq","tab-mq58oavv","tab-mqtrdty4"]`

## Goal

Use the work manager as a dependency-driven planning module with:

- a task-side grouped board
- a gantt schedule
- optional exports
- minimal fixed dates

The preferred authoring model is:

- use `lane` as the phase or group name
- use `durationDays` for almost every task
- omit `startAt` for most tasks
- let dependencies determine schedule placement
- avoid explicit milestone items unless a true date marker is needed

## Native APIs

Prefer module-native APIs over direct S3 edits.

Useful APIs:

- `create_work_manager_slot`
- `list_work_manager_items`
- `create_work_manager_items`
- `update_work_manager_item`
- `delete_work_manager_item`
- `replace_work_manager_items`
- `attach_project_asset_to_work_item`

## Work Item Shape

The stored item shape is:

```json
{
  "id": "string",
  "kind": "task | event | task-event | milestone",
  "title": "string",
  "description": "string",
  "notes": "string",
  "status": "open | in-progress | blocked | done | archived",
  "priority": "low | normal | high | urgent",
  "assignee": "string?",
  "tags": ["string"],
  "repeatable": false,
  "createdAt": "ISO string",
  "updatedAt": "ISO string",
  "createdBy": "string?",
  "attachments": [],
  "startAt": "ISO string?",
  "durationDays": 0,
  "allDay": true,
  "location": "string?",
  "progress": 0,
  "dependencies": ["other-item-id"],
  "lane": "string"
}
```

Notes:

- `dependencies` means "this item starts after those items finish."
- `dependencyTitles` may appear in list API output as a convenience, but it is derived and not stored.
- `durationDays` is business-day duration, not calendar-day duration.

## Scheduling Rules

These rules come directly from the module implementation.

### 1. Weekends are visible but not counted

- The gantt shows Saturdays and Sundays.
- `durationDays` skips weekends when computing the end date.

Implementation basis:

- `addBusinessDays(...)`
- `deriveWindow(...)`

### 2. Dependency-driven items do not need a fixed start date

If `startAt` is missing and dependencies exist:

- the module finds the latest dependency end date
- the item starts on the next business day

So this pattern is preferred:

- upstream tasks have durations
- downstream tasks depend on them
- only the true anchor point needs `startAt`

### 3. Milestones are optional

Jeff's preferred style is to avoid milestones when a lane's terminal task already serves as the completion marker.

Use a milestone only when:

- a hard calendar anchor matters
- a real zero-duration event matters
- you need a visible dated checkpoint independent of lane completion

### 4. Task-list-only items

If a non-milestone item has `durationDays: 0`:

- it stays out of the gantt
- it can still exist as a board/list item

Use that only for reference/checklist items, not for normal scheduled work.

## Preferred Authoring Pattern

This is the preferred schedule style for Jeff.

### Anchor pattern

- Give the schedule one real anchor near the start.
- After that, prefer dependencies over fixed dates.

Good:

- kickoff item with `startAt`
- most other items with no `startAt`
- all later timing derived from dependency chains

### Lane pattern

- Put related tasks in the same `lane`.
- `lane` should be a human-readable phase/group name.

Examples from the live `Dev Schedule`:

- `Phase 1 - Design Investigation`
- `Phase 2 - Part Selection`
- `Phase 3 - Architecture Planning`
- `Phase 4 - Artwork`
- `Phase 5 - Artwork Revision`
- `software development`
- `Phase 6 - Certification`

### Parallel-work pattern

When multiple tasks run in parallel inside a phase:

1. Have them all depend on the same predecessor.
2. Make the downstream consolidation task depend on all of them.

This is a preferred visual pattern because:

- it keeps the gantt clean
- it shows convergence clearly
- it allows a single duration change to propagate through the rest of the plan

### Sequential-within-lane pattern

Inside a lane, tasks should usually form a dependency chain even if no dates are set:

- task B depends on task A
- task C depends on task B

This makes the lane's final task effectively represent lane completion.

## Live Example: KAS-HW Dev Schedule

The live `Dev Schedule` contains 26 items.

Important observed characteristics:

- almost every real task omits `startAt`
- almost every real task has a nonzero `durationDays`
- almost every real task is scheduled by dependency only
- the only explicit milestone is `Project kickoff`
- the meaningful completion markers are mostly the final tasks in each lane

Example patterns from that schedule:

### Software development lane

- `Week 1-8: NFC/BLE/SE integration`
- `Week 9-12: Modem SW and API development`
- `Week 13-16: Validation testing`

These form a strict dependency chain with no fixed dates except upstream prerequisites.

### Design Investigation lane

Parallel investigation tasks fan out and then reconverge:

- `NFC Mode investigation`
- `RFID mode/requirements investigation`
- `Interface comparison (Modem vs. ETH)` depends on both

This is the exact preferred "parallel then converge" pattern.

### Cross-lane handoff pattern

Later phases depend on terminal tasks from earlier lanes.

Example:

- `Device certification` depends on:
  - `revised sample evaluation`
  - `Week 13-16: Validation testing`

That is the preferred way to express major phase convergence.

## Agent Authoring Rules

When creating or revising a schedule:

- prefer `kind: "task"` unless a real event/milestone is required
- set `lane` on every meaningful item
- set `durationDays` on every scheduled task
- omit `startAt` unless the task is a true anchor
- use dependencies instead of repeated manual dates
- keep task titles concise and schedule-readable
- use `notes` for timing rationale
- use `description` for what the task means

Do not:

- add fixed dates everywhere
- use milestones to stand in for every phase boundary
- leave scheduled tasks without both `durationDays` and either `startAt` or dependencies
- encode dependency meaning only in prose when it can be represented structurally

## API Usage Guidance

### For small edits

Use:

- `list_work_manager_items`
- `update_work_manager_item`
- `create_work_manager_items`
- `delete_work_manager_item`

### For major schedule rewrites

Use:

- `replace_work_manager_items`

Only set `replaceExisting: true` when intentionally replacing the whole schedule.

### Dependencies

If you know exact IDs, use `dependencies`.

If you only know titles, the work-manager APIs also support title-based dependency resolution:

- `dependencyTitles`

Prefer IDs when editing an existing known schedule because they are unambiguous.

## Validation Checklist

Before finishing work on a schedule, verify:

- every scheduled task has `durationDays > 0`
- every lane name is intentional and human-readable
- anchor tasks are the only tasks with fixed `startAt` unless there is a real reason otherwise
- dependency chains express the schedule, not just the notes
- parallel tasks share the proper upstream dependency
- downstream convergence tasks depend on all relevant parallel tasks
- zero-duration non-milestone items are only used intentionally

## Board And Gantt Expectations

The intended UX is:

- gantt for timeline understanding
- task board for grouped task review and editing

The task-side view should not require fixed dates to show items. Dependency-driven tasks are first-class schedule items and should still appear in the grouped task view.

## Recommended Agent Workflow

1. Read the module slot with `list_work_manager_items`.
2. Understand lanes, anchors, and dependency structure.
3. Decide whether the change is:
   - a small patch
   - a lane-local expansion
   - a whole-schedule rewrite
4. Apply mutations with the native work-manager APIs.
5. Re-read the schedule and confirm dependency integrity.

## Companion Note

For Jeff's preferred planning style, think of the work manager as:

- a dependency engine first
- a date grid second

Dates should mostly emerge from structure, not from manual per-task scheduling.
