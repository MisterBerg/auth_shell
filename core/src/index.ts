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
  UiTargetKind,
  UiTargetRegistration,
} from "./types.ts";

// Contexts & providers
export {
  AuthContext,
  AuthProvider,
  ResourceRegistryContext,
  ResourceRegistryProvider,
  EditModeContext,
  EditModeProvider,
  UiNavigationContext,
  UiNavigationProvider,
  LinkAuthoringContext,
  LinkAuthoringProvider,
} from "./context.tsx";
export type {
  AuthContextValue,
  ResourceRegistryValue,
  EditModeContextValue,
  UiNavigationContextValue,
  LinkAuthoringContextValue,
} from "./context.tsx";

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
  useNavigateToTarget,
  useUiTargets,
  useHighlightedTargets,
  useIsTargetHighlighted,
  useRegisterUiTarget,
  useLinkAuthoring,
  useIsLinking,
  useLinkAuthoringStep,
  useIsLinkSourceSelected,
  useRegisterLinkSource,
  useParentUiTargetId,
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
