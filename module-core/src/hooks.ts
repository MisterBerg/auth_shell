import { useContext, useCallback } from "react";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  AuthContext,
  ResourceRegistryContext,
  EditModeContext,
} from "./context.tsx";
import type { ModuleConfig, ModuleRegistryEntry, Resource } from "./types.ts";

// ---------------------------------------------------------------------------
// Auth hooks
// ---------------------------------------------------------------------------

export function useAuthContext() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuthContext must be used inside <AuthProvider>");
  return ctx;
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
// useReplaceModule
// Replaces the root module (the one loaded from the URL's config.json) with
// a new module. Preserves id, meta, resources, and children from the current
// config, only swapping out app. Used for:
//   - First-time module assignment when creating a project
//   - Edit-mode root module swap
// ---------------------------------------------------------------------------

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
    }));

    window.dispatchEvent(new Event("shell:navigate"));
  }, [getS3Client]);
}
