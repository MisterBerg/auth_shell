// src/stores/authStore.ts
import { create } from "zustand";

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
};

export type AuthState = {
  isSignedIn: boolean;
  googleToken?: string; // internal only – do not show in UI
  awsCredentialProvider?: () => Promise<AwsCredentials>;
  userProfile?: { email?: string; name?: string; picture?: string };
  loading: boolean;
  error?: string;
  // actions:
  signInWithGoogle: () => void;
  signInWithMicrosoft: () => void;
  signOut: () => void;
  setGoogleSession: (args: {
    googleToken: string;
    userProfile?: { email?: string; name?: string; picture?: string };
    awsCredentialProvider: () => Promise<AwsCredentials>;
  }) => void;
  clearSession: () => void;
  setLoading: (loading: boolean) => void;
  setError: (error?: string) => void;
};

// ---------------------------------------------------------------------------
// Session persistence — keeps the user signed in across hard reloads.
// We store the Google ID token in sessionStorage (tab-scoped, not persisted
// across browser restarts). On load, if a token is found we rebuild the
// credential provider from it via googleCognito.ts.
// ---------------------------------------------------------------------------

const SESSION_KEY = "jsl:googleToken";
const PROFILE_KEY = "jsl:userProfile";

export function saveSession(googleToken: string, userProfile: AuthState["userProfile"]) {
  try {
    sessionStorage.setItem(SESSION_KEY, googleToken);
    sessionStorage.setItem(PROFILE_KEY, JSON.stringify(userProfile ?? {}));
  } catch {
    // sessionStorage unavailable — continue without persistence
  }
}

export function loadSavedSession(): { googleToken: string; userProfile: AuthState["userProfile"] } | null {
  try {
    const token = sessionStorage.getItem(SESSION_KEY);
    const profile = sessionStorage.getItem(PROFILE_KEY);
    if (!token) return null;
    return {
      googleToken: token,
      userProfile: profile ? JSON.parse(profile) : undefined,
    };
  } catch {
    return null;
  }
}

export function clearSavedSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(PROFILE_KEY);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// External handler registration (wired by googleCognito.ts)
// ---------------------------------------------------------------------------

let _externalSignIn: (() => void) | null = null;
let _externalSignOut: (() => void) | null = null;

export const registerAuthHandlers = (handlers: {
  signIn: () => void;
  signOut: () => void;
}) => {
  _externalSignIn = handlers.signIn;
  _externalSignOut = handlers.signOut;
};

export const useAuthStore = create<AuthState>((set, get) => ({
  isSignedIn: false,
  googleToken: undefined,
  awsCredentialProvider: undefined,
  userProfile: undefined,
  loading: false,
  error: undefined,

  setGoogleSession: ({ googleToken, userProfile, awsCredentialProvider }) => {
    saveSession(googleToken, userProfile);
    set({
      isSignedIn: true,
      googleToken,
      userProfile,
      awsCredentialProvider,
      loading: false,
      error: undefined,
    });
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
    });
  },

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  signInWithGoogle: () => {
    if (!_externalSignIn) {
      console.warn("Auth handlers not registered yet");
      return;
    }
    get().setLoading(true);
    _externalSignIn();
  },

  signInWithMicrosoft: () => {
    get().setLoading(false);
    get().setError("Microsoft sign-in is not implemented yet.");
    console.info("Microsoft sign-in placeholder invoked");
  },

  signOut: () => {
    if (_externalSignOut) {
      _externalSignOut();
    }
    get().clearSession();
  },
}));
