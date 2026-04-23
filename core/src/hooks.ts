import { useContext, useCallback, useEffect, useRef } from "react";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  AuthContext,
  ResourceRegistryContext,
  EditModeContext,
  UiNavigationContext,
  LinkAuthoringContext,
} from "./context.tsx";
import { SlotContext } from "./SlotContext.tsx";
import type { ModuleConfig, ModuleRegistryEntry, Resource, UiTargetRegistration, LinkSourceRegistration, LinkAuthoringStep } from "./types.ts";

// ---------------------------------------------------------------------------
// Auth hooks
// ---------------------------------------------------------------------------

export function useAuthContext() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuthContext must be used inside <AuthProvider>");
  return ctx;
}

export function useTableNames() {
  const ctx = useContext(AuthContext);
  return {
    registry: ctx?.tables?.registry ?? "module-registry",
    projects: ctx?.tables?.projects ?? "org-projects",
  };
}

/** Returns the async AWS credential provider function. */
export function useAwsCredentials() {
  return useAuthContext().awsCredentialProvider;
}

/** Returns an async factory that resolves a pre-configured S3Client. */
export function useAwsS3Client() {
  return useAuthContext().getS3Client;
}

/** Returns an async factory that resolves a pre-configured DynamoDBDocumentClient. */
export function useAwsDdbClient() {
  return useAuthContext().getDdbClient;
}

/** Returns the authenticated user's profile information. */
export function useUserProfile() {
  return useAuthContext().userProfile;
}

/** Returns the sign-out function. Clears the session and returns to the sign-in screen. */
export function useSignOut() {
  return useAuthContext().signOut;
}

// ---------------------------------------------------------------------------
// Resource registry hooks
// ---------------------------------------------------------------------------

/**
 * Look up a resource by its declared id from any module in the tree.
 * Returns undefined if the resource hasn't been registered yet (config not yet loaded).
 */
export function useResource(id: string): Resource | undefined {
  const { registry } = useContext(ResourceRegistryContext);
  return registry.get(id);
}

/**
 * Returns all currently registered resources across the project.
 * Useful for building resource picker UIs.
 */
export function useAllResources(): ReadonlyMap<string, Resource> {
  return useContext(ResourceRegistryContext).registry;
}

/**
 * Returns the function for registering resources. Used internally by SlotContainer
 * after loading a child module's config. Modules themselves don't call this.
 */
export function useRegisterResources() {
  return useContext(ResourceRegistryContext).registerResources;
}

// ---------------------------------------------------------------------------
// Edit mode hook
// ---------------------------------------------------------------------------

export function useEditMode() {
  const { editMode, setEditMode, lockHolder } = useContext(EditModeContext);
  return { editMode, setEditMode, lockHolder };
}

// ---------------------------------------------------------------------------
// UI navigation hooks
// ---------------------------------------------------------------------------

export function useNavigateToTarget() {
  return useContext(UiNavigationContext).navigateToTarget;
}

export function useUiTargets(): ReadonlyMap<string, UiTargetRegistration> {
  return useContext(UiNavigationContext).targets;
}

export function useHighlightedTargets(): ReadonlySet<string> {
  return useContext(UiNavigationContext).highlightedTargetIds;
}

export function useIsTargetHighlighted(targetId: string): boolean {
  return useContext(UiNavigationContext).highlightedTargetIds.has(targetId);
}

export function useRegisterUiTarget(target: UiTargetRegistration | null | undefined) {
  const registerTarget = useContext(UiNavigationContext).registerTarget;
  const targetRef = useRef<UiTargetRegistration | null | undefined>(target);
  targetRef.current = target;

  useEffect(() => {
    if (!target) return;
    return registerTarget({
      id: target.id,
      kind: target.kind,
      parentId: target.parentId,
      label: target.label,
      reveal: () => targetRef.current?.reveal?.(),
    });
  }, [registerTarget, target?.id, target?.kind, target?.parentId, target?.label]);
}

export function useLinkAuthoring() {
  const { step, selectedSourceId, startLinking, cancelLinking, chooseSource, completeLink, advanceToTargetSelection } = useContext(LinkAuthoringContext);
  return { step, selectedSourceId, startLinking, cancelLinking, chooseSource, completeLink, advanceToTargetSelection };
}

export function useIsLinking(): boolean {
  return useContext(LinkAuthoringContext).step !== "idle";
}

export function useLinkAuthoringStep(): LinkAuthoringStep {
  return useContext(LinkAuthoringContext).step;
}

export function useIsLinkSourceSelected(sourceId: string): boolean {
  return useContext(LinkAuthoringContext).selectedSourceId === sourceId;
}

export function useRegisterLinkSource(source: LinkSourceRegistration | null | undefined) {
  const registerSource = useContext(LinkAuthoringContext).registerSource;
  const sourceRef = useRef<LinkSourceRegistration | null | undefined>(source);
  sourceRef.current = source;

  useEffect(() => {
    if (!source) return;
    return registerSource({
      id: source.id,
      label: source.label,
      commitLink: (targetId) => sourceRef.current?.commitLink(targetId),
    });
  }, [registerSource, source?.id, source?.label]);
}

// ---------------------------------------------------------------------------
// useUpdateSlotMeta
// For use inside modules loaded by SlotContainer. Merges newMeta into the
// slot's existing meta and persists the parent config to S3. Does NOT
// dispatch shell:navigate — the module decides whether reload is needed.
// ---------------------------------------------------------------------------

export function useUpdateSlotMeta(): ((newMeta: Record<string, unknown>) => Promise<void>) | null {
  const ctx = useContext(SlotContext);
  return ctx?.updateSlotMeta ?? null;
}

// ---------------------------------------------------------------------------
// useUpdateSlotChildren
// For use inside child layouts (tabs-top, tabs-left, etc.) loaded by
// SlotContainer. Replaces the slot's children array in the parent config.
// Returns null when there is no parent SlotContext (i.e. this IS the root).
// ---------------------------------------------------------------------------

export function useUpdateSlotChildren(): ((children: import("./types.ts").ChildSlot[]) => Promise<void>) | null {
  const ctx = useContext(SlotContext);
  return ctx?.updateSlotChildren ?? null;
}

export function useParentUiTargetId(): string | undefined {
  return useContext(SlotContext)?.targetId;
}

export function useReplaceModule() {
  const { getS3Client } = useAuthContext();

  return useCallback(async (entry: ModuleRegistryEntry, currentConfig: ModuleConfig) => {
    const params = new URLSearchParams(window.location.search);
    const configBucket = params.get("bucket");
    const configPath = params.get("config");

    if (!configBucket || !configPath) {
      throw new Error("Cannot determine config location from URL — missing ?bucket= or ?config=");
    }

    const newConfig: ModuleConfig = {
      ...currentConfig,
      app: { bucket: entry.bundleBucket, key: entry.bundlePath },
    };

    const s3 = await getS3Client(configBucket);
    await s3.send(new PutObjectCommand({
      Bucket: configBucket,
      Key: configPath,
      Body: JSON.stringify(newConfig, null, 2),
      ContentType: "application/json",
      CacheControl: "no-store",
    }));

    window.dispatchEvent(new Event("shell:navigate"));
  }, [getS3Client]);
}
