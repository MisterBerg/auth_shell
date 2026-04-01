import React, { createContext, useState, useCallback } from "react";
import type { S3Client } from "@aws-sdk/client-s3";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { AwsCredentials, UserProfile, Resource } from "./types.ts";

// ---------------------------------------------------------------------------
// Auth context
// Provided by auth-shell. Gives any module access to the authenticated user's
// identity and pre-configured AWS clients without prop drilling.
// ---------------------------------------------------------------------------

export type AuthContextValue = {
  awsCredentialProvider: () => Promise<AwsCredentials>;
  userProfile?: UserProfile;
  /** Clears the session and returns the user to the sign-in screen.
   *  Exposed here so modules (e.g. the OAuth badge) can trigger sign-out
   *  without reaching into the shell's internal store. */
  signOut: () => void;
  getS3Client: (bucket?: string) => Promise<S3Client>;
  getDdbClient: () => Promise<DynamoDBDocumentClient>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

type AuthProviderProps = AuthContextValue & { children: React.ReactNode };

export function AuthProvider({ children, ...value }: AuthProviderProps) {
  return <AuthContext value={value}>{children}</AuthContext>;
}

// ---------------------------------------------------------------------------
// Resource registry context
// Aggregates all Resource declarations from every loaded ModuleConfig in the
// tree. Registration is lazy — resources are added as each module config loads.
// ---------------------------------------------------------------------------

export type ResourceRegistryValue = {
  registry: ReadonlyMap<string, Resource>;
  registerResources: (resources: Resource[]) => void;
};

export const ResourceRegistryContext = createContext<ResourceRegistryValue>({
  registry: new Map(),
  registerResources: () => {},
});

export function ResourceRegistryProvider({ children }: { children: React.ReactNode }) {
  const [registry, setRegistry] = useState<Map<string, Resource>>(new Map());

  const registerResources = useCallback((resources: Resource[]) => {
    setRegistry((prev) => {
      const next = new Map(prev);
      for (const r of resources) {
        if (next.has(r.id)) {
          console.warn(`[module-core] Duplicate resource id "${r.id}" — overwriting.`);
        }
        next.set(r.id, r);
      }
      return next;
    });
  }, []);

  return (
    <ResourceRegistryContext value={{ registry, registerResources }}>
      {children}
    </ResourceRegistryContext>
  );
}

// ---------------------------------------------------------------------------
// Edit mode context
// A single global boolean that flows down the entire module tree. SlotContainer
// reads this to decide whether to render the edit overlay on each slot.
// ---------------------------------------------------------------------------

export type EditModeContextValue = {
  editMode: boolean;
  setEditMode: (v: boolean) => void;
  lockHolder?: string;   // email of the user currently holding the edit lock
};

export const EditModeContext = createContext<EditModeContextValue>({
  editMode: false,
  setEditMode: () => {},
  lockHolder: undefined,
});

export function EditModeProvider({ children }: { children: React.ReactNode }) {
  const [editMode, setEditMode] = useState(false);
  const [lockHolder] = useState<string | undefined>(undefined);

  return (
    <EditModeContext value={{ editMode, setEditMode, lockHolder }}>
      {children}
    </EditModeContext>
  );
}
