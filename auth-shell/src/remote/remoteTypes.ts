// All shared module types now live in module-core.
// This file re-exports them for any legacy references within auth-shell.
export type { ModuleConfig, ModuleProps, Resource, ChildSlot } from "module-core";
