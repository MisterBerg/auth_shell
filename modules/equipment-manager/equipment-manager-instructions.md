# Equipment Manager

`module-equipment-manager` is the seed for a reusable device-runtime layer.

Current intent:

- define lab device profiles
- define known commands for those devices
- define higher-level scripts that reference commands, waits, captures, and notes
- persist that design data in the project so it can later be consumed by:
  - `module-test-manager`
  - standalone lab-automation flows
  - bridge-driven agent tooling

## Shared Contract Direction

The equipment runtime contract should converge on these concepts:

- `get_capabilities`
- `connect`
- `disconnect`
- `enumerate_targets`
- `execute_command`
- `execute_script`
- `read_data`
- `capture_artifact`
- `subscribe`
- `stop`

This module does not execute hardware commands yet. It defines the profiles and script model we want the bridge and hardware-facing modules to implement.

## MVP State Shape

- `devices[]`
  - name
  - transport
  - address
  - capabilities
  - known commands
- `scripts[]`
  - optional target device
  - ordered steps
  - command references
  - waits
  - raw command escape hatches
  - output/save hints

## Next Steps

- bridge API for equipment discovery and execution
- standard device module API surface
- test-manager equipment bindings in YAML
- wrapper execution module that can run and store scripts outside test-manager
