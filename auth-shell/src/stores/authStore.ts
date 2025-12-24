// src/stores/authStore.ts
import { create } from "zustand";
import type { AppConfig } from "../config";

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

// These functions will be wired to the Google/Cognito module:
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

  setGoogleSession: ({ googleToken, userProfile, awsCredentialProvider }) =>
    set({
      isSignedIn: true,
      googleToken,
      userProfile,
      awsCredentialProvider,
      loading: false,
      error: undefined,
    }),

  clearSession: () =>
    set({
      isSignedIn: false,
      googleToken: undefined,
      userProfile: undefined,
      awsCredentialProvider: undefined,
      loading: false,
      error: undefined,
    }),

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
    // For now, just show a friendly message; later we’ll plug in MS auth.
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
