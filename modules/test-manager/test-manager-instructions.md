# Fire Hazard Test Manager Handoff

This document is for an agent working in the dedicated fire-hazard project. Its job is to create and maintain a YAML test specification that works correctly with the `module-test-manager` software in this repo.

The guidance below is based on the actual implementation in `modules/test-manager/src/index.tsx`, not on guesswork.

## Goal

Produce a YAML definition that:

- loads cleanly in `module-test-manager`
- exposes fire-hazard tests in grouped form
- supports runtime execution and evidence capture
- generates useful markdown/PDF report output
- keeps diagrams, procedures, and validation metadata attached to each test

## Top-Level YAML Shape

The parser expects a YAML document with these optional top-level sections:

- `program`
- `diagrams`
- `steps`
- `procedures`
- `linked_values`
- `input_fields`
- `test_defined_fields`
- `test_groups`

Minimal valid files can omit many sections, but a serious fire-hazard spec should use most of them.

## What Each Top-Level Section Means

### `program`

Describes the overall test program.

Useful fields:

- `name` or `title`
- `description`
- `pre_test_assets`

`program.name` or `program.title` becomes the visible program title in the UI and report.

`program.description` is shown in overview/report areas.

`program.pre_test_assets` populates the "System Diagrams" / overview graphics.

### `diagrams`

Reusable diagram definitions that can be referenced by `pre_test_assets`.

Each diagram entry can contain:

- `title`
- `layout`
  - `left-to-right`
  - `top-to-bottom`
- `nodes`
- `edges`
- `annotations`

Node fields:

- `label`
- `note`
- `tone`
- `badge`

Edge fields:

- `from`
- `to`
- `label`
- `tone`

Annotation fields:

- `label`
- `tone`
- `connects`

The module renders these into SVG itself.

### `steps`

Reusable atomic procedure steps.

Each step can contain:

- `title`
- `instruction`
- `expected`
- `requires_evidence` or `requiresEvidence`
- `safety_critical` or `safetyCritical`

### `procedures`

Reusable step collections.

Each procedure can contain:

- `title`
- `description`
- `steps`

Think of the model as two layers:

- `steps` is a catalog of reusable single actions.
- `procedures` is a catalog of reusable ordered step sets.

A test can reference a whole procedure when most steps are shared, or it can reference individual steps when only a few actions are shared. This avoids copying 90% of a procedure across tests.

`steps` can contain:

- a string reference to a `steps` entry
- a string reference to another `procedures` entry
- an inline step object
- an object with `ref`, `step_ref`, or `procedure_ref`

There is no implemented patch/overlay merge for procedure steps. A `test_steps` entry shaped like `{ ref: some_step, patch: {...} }` will resolve only the `ref`; the `patch` object is ignored. To vary one step for a specific test, either:

- define a separate reusable step and reference that step
- add an inline step object in that test's `test_steps`
- define a small test-specific procedure and reference it

Example:

```yaml
steps:
  observe_for_smoke:
    title: Observe for smoke
    instruction: Watch the DUT and enclosure outlet for smoke for the specified interval.
    expected: No sustained smoke, flame, or glowing conductor.
    requires_evidence: true
    safety_critical: true

procedures:
  standard_fault_test:
    title: Standard Fault Test Procedure
    steps:
      - observe_for_smoke
      - id: record_peak_temperature
        title: Record peak temperature
        instruction: Capture thermal-camera peak temperature at the hot spot.
        expected: Peak remains below the program limit for this test.
        requires_evidence: true

test_groups:
  - id: example_group
    title: Example Group
    test_steps:
      - ref: standard_fault_test
    tests:
      - id: EX-001
        title: Test-specific procedure override
        test_steps:
          - ref: observe_for_smoke
          - id: record_peak_temperature_ex001
            title: Record peak temperature for EX-001
            instruction: Capture peak temperature at U13 and the enclosure outlet.
            expected: No surface exceeds the EX-001 threshold.
            requires_evidence: true
```

The software resolves nested procedures recursively and records issues for:

- missing references
- recursive procedure loops

If duplicate step IDs are produced after procedure expansion, the module keeps all steps and appends a numeric suffix to later duplicates so runtime step results remain distinct.

Recommended 90% overlap pattern:

```yaml
steps:
  setup_instrumentation:
    title: Set up instrumentation
    instruction: Connect current probe, thermocouple, and video capture.
  observe_fault:
    title: Observe fault
    instruction: Watch for smoke, flame, arcing, and abnormal heating.
  collect_evidence:
    title: Collect evidence
    instruction: Save photos, thermal images, and waveforms.

procedures:
  standard_fault_test:
    title: Standard Fault Test
    steps:
      - setup_instrumentation
      - observe_fault
      - collect_evidence

test_groups:
  - id: rail_short_tests
    title: Rail Short Tests
    test_steps:
      - standard_fault_test
    tests:
      - id: RAIL-001
        title: Standard rail short
      - id: RAIL-002
        title: Rail short with extra precheck
        test_steps:
          - setup_instrumentation
          - id: verify_ldo_temperature_probe
            title: Verify LDO temperature probe
            instruction: Confirm the probe is attached to the LDO package before fault injection.
            requires_evidence: true
          - observe_fault
          - collect_evidence
```

### `linked_values`

Named controlled vocabularies.

Used to validate IDs in both:

- `test_defined_fields`
- `input_fields`

Each set can be:

- an array of objects
- a map keyed by ID

Recognized per-entry fields:

- `id`
- `value`
- `name`
- `label`
- `title`
- `description`
- `help_text`
- `helpText`

### `input_fields`

Runtime execution inputs filled in while running the test.

These fields appear in the "Runtime Inputs" section.

Each field can contain:

- `id`
- `label`
- `type`
- `required`
- `help_text` / `helpText` / `description`
- `placeholder`
- `linked_values` / `linkedValueSet` / `linkedValue` / `source` / `options_from`
- `options` or `values`

Supported behavior by field type:

- `textarea`, `multiline`, `notes`: rendered as textareas
- `boolean`: rendered as checkbox
- `enum`, `select`, or any field with `options`: rendered as select
- `number`: coerced to numeric values
- types containing `file`, `image`, `video`, or `csv`: treated as artifact fields

Special runtime note:

- if an input field has id `status`, the UI also mirrors it to execution status

### `test_defined_fields`

Specification-time metadata that each resolved test should carry after inheritance.

These fields are not typed in at runtime. They are validated against the resolved test definition.

The UI shows these in the "Test Definitions" section.

Use this section for fire-hazard classification and static test metadata.

### `test_groups`

The core test tree.

Each group can contain:

- `id` or `test_group_id`
- `title`
- `description`
- `values`
- arbitrary direct keys
- `tests`

Each test can contain:

- `id` or `test_id`
- `title`
- `description`
- `values`
- arbitrary direct keys

Important: both groups and tests are normalized so that direct keys and `values` are merged. This means either of these patterns works:

```yaml
tests:
  - id: abc
    values:
      failure_mode: smoke_ingress
```

or:

```yaml
tests:
  - id: abc
    failure_mode: smoke_ingress
```

## Inheritance Model

Resolved test values are built as:

1. structural fields inserted by the software:
   - `test_group_id`
   - `test_group_title`
   - `test_id`
   - `title`
   - `description`
2. group values
3. test values

So test-level values override group-level values.

Use group-level values for shared defaults such as:

- target subsystem
- hazard family
- environment
- operator role
- required equipment package
- common procedure

## Required Structural Fields

The software hard-checks only these structural fields after inheritance:

- `test_group_id`
- `test_id`
- `title`

The first three are filled structurally if you use normal group/test entries.

`failure_mode` and `target_module` are no longer globally required by the module. They are still useful fire-hazard metadata, but they should only be treated as required when your specific spec marks them required or your workflow depends on them.

## Recommended Fire-Hazard Metadata Model

For the fire-hazard project, define `test_defined_fields` that make the report and UI useful. Recommended fields:

- `failure_mode`
- `target_module`
- `hazard_zone`
- `hazard_trigger`
- `severity_class`
- `detection_method`
- `shutdown_strategy`
- `mitigation_expected`
- `preconditions`
- `expected_hazard_focus`
- `procedure`
- `equipment_runtime`
- `pre_test_guidance`
- `pre_test_assets`

Suggested meaning:

- `failure_mode`: canonical hazard event name
- `target_module`: DUT or subsystem under test
- `hazard_zone`: physical area or circuit domain
- `hazard_trigger`: what initiates the hazardous condition
- `severity_class`: internal safety ranking
- `detection_method`: smoke, temperature, current, software fault, manual observation, etc.
- `shutdown_strategy`: what should happen when hazard criteria are met
- `mitigation_expected`: expected software or hardware response
- `preconditions`: what must be true before execution
- `expected_hazard_focus`: short text for operator awareness

## Recommended `linked_values`

For a fire-hazard program, add controlled vocabularies such as:

- `failure_modes`
- `target_modules`
- `hazard_zones`
- `hazard_triggers`
- `severity_classes`
- `detection_methods`
- `shutdown_strategies`
- `operator_roles`
- `equipment_profiles`

Then point fields at them with `linked_values`.

Example:

```yaml
linked_values:
  failure_modes:
    thermal_runaway:
      label: Thermal runaway
    smoke_release:
      label: Smoke release

test_defined_fields:
  failure_mode:
    label: Failure Mode
    type: select
    required: true
    linked_values: failure_modes
```

If a resolved value is not present in the linked set, the UI will report a linked-value issue.

## Runtime Input Design

Use `input_fields` only for values the operator records while executing the run.

Good fire-hazard runtime fields:

- `status`
- `operator_name`
- `ambient_temperature_c`
- `supply_voltage_v`
- `measured_current_a`
- `smoke_detected`
- `smoke_onset_seconds`
- `surface_temp_c`
- `thermal_camera_peak_c`
- `shutdown_command_issued`
- `shutdown_latency_ms`
- `alarm_observed`
- `containment_intact`
- `operator_notes`
- `evidence_photos`
- `scope_capture`
- `data_log_csv`

Recommended runtime field types:

- `select` or `enum` for discrete states
- `number` for numeric measurements
- `boolean` for yes/no checks
- `textarea` or `notes` for operator narrative
- `image_file`, `video_file`, `csv_file`, `file_list` style names for artifact capture

Artifact fields are detected by field type text containing:

- `file`
- `image`
- `video`
- `csv`

## Procedure Authoring Guidance

Use reusable `steps` and `procedures` heavily. Fire-hazard testing often repeats safety and observation actions.

Create shared step sets for:

- pre-check and instrumentation setup
- ignition/trigger initiation
- observation interval
- shutdown verification
- post-event inspection
- evidence collection
- reset and safe-state confirmation

Mark steps with:

- `requires_evidence: true` when proof is needed
- `safety_critical: true` for operator-safety-sensitive actions

## Pre-Test Guidance and Assets

Each resolved test may carry:

- `pre_test_guidance`
- `pre_test_assets`
- `equipment_runtime`
- `procedure` or `test_steps`

These can be specified at group level or test level.

### `pre_test_assets`

Supported asset styles:

1. referenced generated diagrams:

```yaml
pre_test_assets:
  - type: diagram_ref
    diagram: battery_pack_isolation
    label: Isolation boundary
```

Referenced diagrams support a `patch` object. This is the overlay/variant mechanism implemented by the module. It applies only to generated diagrams in `pre_test_assets`, not to procedure steps.

Supported `patch` keys:

- `add_nodes`: add nodes or merge node fields
- `update_nodes`: merge fields into existing nodes
- `nodes`: alias-style node updates; also merges fields
- `remove_nodes`: remove nodes by ID and automatically remove connected edges
- `edges`: replace the base diagram edge list
- `add_edges`: append edges
- `remove_edges`: remove edges by edge ID
- `annotations`: replace the base annotation list
- `add_annotations`: append annotations

Node patch fields are the same as normal node fields:

- `label`
- `note`
- `tone`
- `badge`

Diagram patch example:

```yaml
pre_test_assets:
  - type: diagram_ref
    id: fuse-003-diag
    diagram: fuse-circuit
    label: Hard Fault - Unrestricted Short Circuit
    patch:
      update_nodes:
        12VBatt: { tone: danger }
        Fuse_5A: { tone: danger, badge: "SHORT" }
      add_edges:
        - id: short_return_path
          from: Fuse_5A
          to: GND
          label: fault current
          tone: danger
      add_annotations:
        - label: Scope required - capture inrush, arc, and clearing
          tone: danger
          connects: [12VBatt, Fuse_5A]
```

2. inline diagram definitions:

```yaml
pre_test_assets:
  - type: diagram
    label: Hazard signal path
    diagram:
      title: Hazard signal path
      layout: left-to-right
      nodes:
        sensor:
          label: Smoke Sensor
```

3. inline SVG:

```yaml
pre_test_assets:
  - type: svg_inline
    label: Enclosure section
    content: "<svg ...>...</svg>"
```

4. external image URLs:

```yaml
pre_test_assets:
  - type: image_url
    label: Chamber photo
    url: "https://..."
```

### `equipment_runtime`

This is an array describing tools/services used during execution.

Each item supports:

- `id`
- `label`
- `provider`
- `mode`
  - `manual`
  - `assisted`
  - `automated`
- `actions`
- `outputs`
- `notes`

Use it for things like:

- thermal camera workflow
- smoke sensor logger
- programmable power supply
- CAN capture/logger
- chamber controller

## What Appears in the Report

The generated report summary includes:

- program
- run label
- generation time
- tests in scope
- program overview assets
- results summary table with:
  - `test.id`
  - `test.testGroupId`
  - runtime `status`
  - `failure_mode`
  - `target_module`

Therefore, `failure_mode` and `target_module` are especially important.

Each per-test detail page includes:

- pre-test guidance
- diagrams and pre-test assets
- equipment runtime summary
- all resolved defined values
- resolved procedure table
- runtime input values
- notes
- typed/supporting file links

## Validation Behavior to Expect

The module will surface issues for:

- missing required `test_defined_fields`
- missing structural required fields
- linked-value IDs not found in their value sets
- unknown step/procedure references
- recursive procedures

This means the agent should treat validation issues as authoring errors to fix, not as acceptable noise.

## Important Reserved and Special Keys

Some keys are handled specially by the module and should be intentionally authored:

- `pre_test_guidance`
- `pre_test_assets`
- `equipment_runtime`
- `procedure`
- `test_steps`
- `preconditions`
- `expected_hazard_focus`

These are excluded from some fingerprint logic and displayed in special UI/report sections.

## Authoring Strategy for the Fire Hazard Project

Use this workflow:

1. Define `linked_values` first.
2. Define `test_defined_fields` second.
3. Define reusable `steps`.
4. Define reusable `procedures`.
5. Define reusable `diagrams`.
6. Define `program` metadata and shared overview assets.
7. Create `test_groups` with shared defaults.
8. Add per-test overrides and unique procedures/assets only where needed.
9. Keep runtime fields minimal and operator-friendly.

## Recommended Fire-Hazard Grouping Model

Suggested `test_groups`:

- `detection_and_alarm`
- `shutdown_response`
- `containment_behavior`
- `post_event_recovery`
- `power_path_isolation`
- `sensor_fault_injection`
- `false_positive_resilience`

Within each group, keep tests narrow and observable.

Example test themes:

- smoke source near intake sensor
- overtemperature threshold crossing
- short-circuit induced thermal event
- communication loss during hazard state
- alarm propagation timing
- contactor dropout timing
- fan shutdown or continued purge behavior
- operator acknowledgment flow

## Concrete Authoring Rules for the Other Agent

The other agent should:

- always set a unique `id` for every group, test, step, procedure, diagram, and asset when practical
- always provide `failure_mode`
- always provide `target_module`
- use `linked_values` for any repeated vocabulary
- prefer reusable procedures over copying step arrays
- attach diagrams with `pre_test_assets` rather than embedding random markdown image references inside descriptions
- keep runtime evidence fields explicit
- avoid inventing fields that are not declared in `test_defined_fields` or `input_fields`
- keep `status` as a runtime input field if execution status should be operator-controlled

## Things the Other Agent Should Not Assume

- Do not assume markdown files drive the spec. The source of truth is YAML.
- Do not assume every test must define all values directly. Group inheritance is intentional.
- Do not assume diagrams must be external files. Inline/generated SVG is supported.
- Do not assume procedure-step patching is supported. Step variants must be separate step definitions, inline steps, or test-specific procedures.
- Do not assume diagram patching rewrites the reusable base diagram. Patches are rendered per `pre_test_assets` entry.
- Do not assume artifact upload fields need a special separate schema beyond `input_fields`; type naming controls behavior.
- Do not assume reports are free-form. The module emits a structured summary/detail format using resolved values.

## Acceptance Checklist

Before handing the fire-hazard YAML over for use, verify:

- every test resolves `failure_mode`
- every test resolves `target_module`
- every linked value reference exists
- every `procedure` or `test_steps` reference resolves
- every test-specific procedure variation is represented as a real step/procedure, not an ignored step `patch`
- every `pre_test_asset` diagram reference exists
- every diagram patch references existing node/edge IDs or intentionally adds them
- runtime fields are sensible for operators
- report-critical values are populated
- tests are grouped in a way that matches how runs will actually be executed

## Deliverables to Produce in the Fire Hazard Project

At minimum, create:

1. a master YAML definition for the fire-hazard test program
2. grouped tests with shared inheritance
3. linked value sets for controlled vocabularies
4. reusable procedures and steps
5. system/hazard diagrams via `diagrams` and `pre_test_assets`
6. runtime input fields for execution and evidence capture

## Companion File

Use the companion working spec file:

- `temp/fire-hazard-spec.yaml`

`temp/fire-hazard-spec copy.yaml` may also exist as a snapshot/reference copy. Treat `temp/fire-hazard-spec.yaml` as the working YAML unless Jeff says otherwise.
