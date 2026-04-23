import React, { createContext, useState, useCallback, useRef } from "react";
import type { S3Client } from "@aws-sdk/client-s3";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type {
  AwsCredentials,
  UserProfile,
  Resource,
  UiTargetRegistration,
  LinkAuthoringStep,
  LinkSourceRegistration,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Auth context
// Provided by the shell runtime. Gives any module access to the authenticated user's
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
  /** DynamoDB table names for this deployment. Defaults to local dev names. */
  tables?: {
    registry?: string;  // module registry table (default: "module-registry")
    projects?: string;  // org projects table   (default: "org-projects")
  };
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

// ---------------------------------------------------------------------------
// UI navigation context
// Registers revealable runtime targets and resolves navigation/highlight
// requests across layouts and modules.
// ---------------------------------------------------------------------------

export type UiNavigationContextValue = {
  targets: ReadonlyMap<string, UiTargetRegistration>;
  registerTarget: (target: UiTargetRegistration) => () => void;
  navigateToTarget: (targetId: string, options?: { highlightMs?: number }) => Promise<boolean>;
  highlightedTargetIds: ReadonlySet<string>;
};

export const UiNavigationContext = createContext<UiNavigationContextValue>({
  targets: new Map(),
  registerTarget: () => () => {},
  navigateToTarget: async () => false,
  highlightedTargetIds: new Set(),
});

export function UiNavigationProvider({ children }: { children: React.ReactNode }) {
  const [targets, setTargets] = useState<Map<string, UiTargetRegistration>>(new Map());
  const [highlightedTargetIds, setHighlightedTargetIds] = useState<Set<string>>(new Set());
  const highlightTokenRef = useRef(0);

  const registerTarget = useCallback((target: UiTargetRegistration) => {
    setTargets((prev) => {
      const current = prev.get(target.id);
      if (
        current &&
        current.kind === target.kind &&
        current.parentId === target.parentId &&
        current.label === target.label &&
        current.reveal === target.reveal
      ) {
        return prev;
      }
      const next = new Map(prev);
      next.set(target.id, target);
      return next;
    });

    return () => {
      setTargets((prev) => {
        const current = prev.get(target.id);
        if (!current) return prev;
        if (
          current.kind !== target.kind ||
          current.parentId !== target.parentId ||
          current.label !== target.label ||
          current.reveal !== target.reveal
        ) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(target.id);
        return next;
      });
    };
  }, []);

  const resolveTargetWithFallback = useCallback((targetId: string) => {
    let currentId: string | undefined = targetId;

    while (currentId) {
      const direct = targets.get(currentId);
      if (direct) return direct;

      const slotIndex = currentId.lastIndexOf(":slot:");
      if (slotIndex >= 0) {
        currentId = currentId.slice(0, slotIndex);
        continue;
      }

      currentId = undefined;
    }

    return undefined;
  }, [targets]);

  const navigateToTarget = useCallback(async (targetId: string, options?: { highlightMs?: number }) => {
    const target = resolveTargetWithFallback(targetId);
    if (!target) return false;

    const chain: UiTargetRegistration[] = [];
    const seen = new Set<string>();
    let current: UiTargetRegistration | undefined = target;

    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current);
      current = current.parentId ? targets.get(current.parentId) : undefined;
    }

    chain.reverse();

    for (const entry of chain) {
      await entry.reveal?.();
    }

    const nextHighlight = new Set(chain.map((entry) => entry.id));
    const token = ++highlightTokenRef.current;
    setHighlightedTargetIds(nextHighlight);

    const durationMs = options?.highlightMs ?? 2200;
    window.setTimeout(() => {
      if (highlightTokenRef.current === token) {
        setHighlightedTargetIds(new Set());
      }
    }, durationMs);

    return true;
  }, [resolveTargetWithFallback, targets]);

  return (
    <UiNavigationContext value={{ targets, registerTarget, navigateToTarget, highlightedTargetIds }}>
      {children}
    </UiNavigationContext>
  );
}

// ---------------------------------------------------------------------------
// Link authoring context
// Shell-level edit flow for choosing a source first, then a destination target.
// Persisted state lives only in the source module's own config when committed.
// ---------------------------------------------------------------------------

export type LinkAuthoringContextValue = {
  step: LinkAuthoringStep;
  selectedSourceId?: string;
  registerSource: (source: LinkSourceRegistration) => () => void;
  startLinking: () => void;
  cancelLinking: () => void;
  chooseSource: (sourceId: string) => void;
  completeLink: (targetId: string) => Promise<boolean>;
  advanceToTargetSelection: () => void;
};

export const LinkAuthoringContext = createContext<LinkAuthoringContextValue>({
  step: "idle",
  selectedSourceId: undefined,
  registerSource: () => () => {},
  startLinking: () => {},
  cancelLinking: () => {},
  chooseSource: () => {},
  completeLink: async () => false,
  advanceToTargetSelection: () => {},
});

export function LinkAuthoringProvider({ children }: { children: React.ReactNode }) {
  const [sources, setSources] = useState<Map<string, LinkSourceRegistration>>(new Map());
  const [step, setStep] = useState<LinkAuthoringStep>("idle");
  const [selectedSourceId, setSelectedSourceId] = useState<string | undefined>();

  const registerSource = useCallback((source: LinkSourceRegistration) => {
    setSources((prev) => {
      const current = prev.get(source.id);
      if (
        current &&
        current.label === source.label &&
        current.commitLink === source.commitLink
      ) {
        return prev;
      }
      const next = new Map(prev);
      next.set(source.id, source);
      return next;
    });

    return () => {
      setSources((prev) => {
        const current = prev.get(source.id);
        if (!current) return prev;
        if (current.label !== source.label || current.commitLink !== source.commitLink) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(source.id);
        return next;
      });
    };
  }, []);

  const startLinking = useCallback(() => {
    setSelectedSourceId(undefined);
    setStep("select-source");
  }, []);

  const cancelLinking = useCallback(() => {
    setSelectedSourceId(undefined);
    setStep("idle");
  }, []);

  const chooseSource = useCallback((sourceId: string) => {
    if (!sources.has(sourceId)) return;
    setSelectedSourceId(sourceId);
    setStep("source-selected");
  }, [sources]);

  const advanceToTargetSelection = useCallback(() => {
    setStep((current) => {
      if (current !== "source-selected") return current;
      return "select-target";
    });
  }, []);

  const completeLink = useCallback(async (targetId: string) => {
    if (!selectedSourceId) return false;
    const source = sources.get(selectedSourceId);
    if (!source) return false;

    setStep("saving");
    try {
      await source.commitLink(targetId);
      setSelectedSourceId(undefined);
      setStep("idle");
      return true;
    } catch (error) {
      console.error("[module-core] Failed to save authored link", error);
      setStep("select-target");
      return false;
    }
  }, [selectedSourceId, sources]);

  return (
    <LinkAuthoringContext value={{ step, selectedSourceId, registerSource, startLinking, cancelLinking, chooseSource, completeLink, advanceToTargetSelection }}>
      {children}
    </LinkAuthoringContext>
  );
}
