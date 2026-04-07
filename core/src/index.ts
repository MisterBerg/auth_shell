// Types
export type {
  Resource,
  ChildSlot,
  ModuleConfig,
  ModuleProps,
  ModuleBundle,
  ExportContext,
  AwsCredentials,
  UserProfile,
  ModuleCategory,
  ModuleRegistryEntry,
} from "./types.ts";

// Contexts & providers
export {
  AuthContext,
  AuthProvider,
  ResourceRegistryContext,
  ResourceRegistryProvider,
  EditModeContext,
  EditModeProvider,
} from "./context.tsx";
export type { AuthContextValue, ResourceRegistryValue, EditModeContextValue } from "./context.tsx";

// Hooks
export {
  useAuthContext,
  useTableNames,
  useAwsCredentials,
  useAwsS3Client,
  useAwsDdbClient,
  useUserProfile,
  useSignOut,
  useResource,
  useAllResources,
  useRegisterResources,
  useEditMode,
  useUpdateSlotMeta,
  useUpdateSlotChildren,
  useReplaceModule,
} from "./hooks.ts";

// Module loader
export { loadModule, loadBundle } from "./loadModule.ts";
export type { LoadedModule } from "./loadModule.ts";

// Recursive slot renderer
export { SlotContainer } from "./SlotContainer.tsx";

// Module registry
export { useModuleRegistry } from "./useModuleRegistry.ts";
export { ModulePicker } from "./ModulePicker.tsx";
