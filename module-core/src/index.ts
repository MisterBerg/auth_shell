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
  useAwsCredentials,
  useAwsS3Client,
  useAwsDdbClient,
  useUserProfile,
  useResource,
  useAllResources,
  useRegisterResources,
  useEditMode,
} from "./hooks.ts";

// Module loader
export { loadModule } from "./loadModule.ts";
export type { LoadedModule } from "./loadModule.ts";

// Recursive slot renderer
export { SlotContainer } from "./SlotContainer.tsx";
