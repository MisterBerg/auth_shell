import { create } from "zustand";

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
};

export type UserProfile = {
  email?: string;
  name?: string;
  picture?: string;
};

export type AuthState = {
  isSignedIn: boolean;
  googleToken?: string;
  awsCredentialProvider?: () => Promise<AwsCredentials>;
  userProfile?: UserProfile;
  loading: boolean;
  error?: string;
  // True when a request failed with an auth error (expired token, etc.) mid-session. Distinct from
  // isSignedIn/clearSession: flagging this does NOT tear down the signed-in app — AuthGate keeps
  // the whole module tree mounted and shows a "reconnect" prompt on top of it instead, so no
  // in-memory work in any module gets destroyed just because a token needs renewing.
  needsReauth: boolean;
  // Bumped every time a fresh awsCredentialProvider is established (initial sign-in or reconnect).
  // awsClients.ts includes this in its S3/DynamoDB client cache keys so a reconnect actually
  // produces new clients bound to the new provider, instead of old cached clients silently
  // continuing to use a credential closure permanently tied to the expired token.
  authGeneration: number;
  signInWithGoogle: () => void;
  signInWithMicrosoft: () => void;
  signOut: () => void;
  setGoogleSession: (args: {
    googleToken: string;
    expiresAt?: number;
    userProfile?: UserProfile;
    awsCredentialProvider: () => Promise<AwsCredentials>;
  }) => void;
  clearSession: () => void;
  flagReauthNeeded: () => void;
  setLoading: (loading: boolean) => void;
  setError: (error?: string) => void;
};

const SESSION_KEY = "jsl:googleToken";
const EXPIRES_AT_KEY = "jsl:expiresAt";
const PROFILE_KEY = "jsl:userProfile";

export function saveSession(
  googleToken: string,
  expiresAt: number | undefined,
  userProfile: UserProfile | undefined
) {
  try {
    sessionStorage.setItem(SESSION_KEY, googleToken);
    if (expiresAt) {
      sessionStorage.setItem(EXPIRES_AT_KEY, String(expiresAt));
    } else {
      sessionStorage.removeItem(EXPIRES_AT_KEY);
    }
    sessionStorage.setItem(PROFILE_KEY, JSON.stringify(userProfile ?? {}));
  } catch {
    // sessionStorage unavailable - continue without persistence
  }
}

export function loadSavedSession():
  | {
      googleToken: string;
      expiresAt?: number;
      userProfile?: UserProfile;
    }
  | null {
  try {
    const googleToken = sessionStorage.getItem(SESSION_KEY);
    if (!googleToken) return null;

    const expiresAtRaw = sessionStorage.getItem(EXPIRES_AT_KEY);
    const profile = sessionStorage.getItem(PROFILE_KEY);

    return {
      googleToken,
      expiresAt: expiresAtRaw ? Number(expiresAtRaw) : undefined,
      userProfile: profile ? JSON.parse(profile) : undefined,
    };
  } catch {
    return null;
  }
}

export function clearSavedSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(EXPIRES_AT_KEY);
    sessionStorage.removeItem(PROFILE_KEY);
  } catch {
    // ignore
  }
}

let externalSignIn: (() => void) | null = null;
let externalSignOut: (() => void) | null = null;

export const registerAuthHandlers = (handlers: {
  signIn: () => void;
  signOut: () => void;
}) => {
  externalSignIn = handlers.signIn;
  externalSignOut = handlers.signOut;
};

export const useAuthStore = create<AuthState>((set, get) => ({
  isSignedIn: false,
  googleToken: undefined,
  awsCredentialProvider: undefined,
  userProfile: undefined,
  loading: false,
  error: undefined,
  needsReauth: false,
  authGeneration: 0,

  setGoogleSession: ({ googleToken, expiresAt, userProfile, awsCredentialProvider }) => {
    saveSession(googleToken, expiresAt, userProfile);
    set((state) => ({
      isSignedIn: true,
      googleToken,
      userProfile,
      awsCredentialProvider,
      loading: false,
      error: undefined,
      needsReauth: false,
      authGeneration: state.authGeneration + 1,
    }));
  },

  clearSession: () => {
    clearSavedSession();
    set({
      isSignedIn: false,
      googleToken: undefined,
      userProfile: undefined,
      awsCredentialProvider: undefined,
      loading: false,
      error: undefined,
      needsReauth: false,
    });
  },

  flagReauthNeeded: () => set({ needsReauth: true }),

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  signInWithGoogle: () => {
    if (!externalSignIn) {
      console.warn("Auth handlers not registered yet");
      return;
    }
    get().setLoading(true);
    externalSignIn();
  },

  signInWithMicrosoft: () => {
    get().setLoading(false);
    get().setError("Microsoft sign-in is not implemented yet.");
  },

  signOut: () => {
    if (externalSignOut) {
      externalSignOut();
    }
    get().clearSession();
  },
}));
