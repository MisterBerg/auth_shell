// Types
export type {
  Resource,
  ChildSlot,
  ModuleConfig,
  ModuleProps,
  ModuleBundle,
  ExportContext,
  AssetRecord,
  AssetVersionRef,
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

// Project assets
export {
  MAX_EMBEDDED_ASSET_VERSIONS,
  addAssetVersion,
  buildAssetVersionKey,
  createAsset,
  createAssetId,
  createAssetRecord,
  createAssetVersionId,
  getAsset,
  getAssetSk,
  getCurrentAssetVersion,
  listAssets,
  putAsset,
  rollbackAssetVersion,
  sanitizeAssetFilename,
  updateAsset,
} from "./assets.ts";
export type { AddAssetVersionInput, CreateAssetRecordInput } from "./assets.ts";
