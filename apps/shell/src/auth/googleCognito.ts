import { fromCognitoIdentityPool } from "@aws-sdk/credential-providers";
import type { AppConfig } from "../config";
import {
  loadSavedSession,
  registerAuthHandlers,
  useAuthStore,
  type AwsCredentials,
  type UserProfile,
} from "../stores/authStore";

declare global {
  interface Window {
    google?: any;
  }
}

const GOOGLE_PROVIDER = "accounts.google.com";
const ACCESS_DENIED_MESSAGE =
  "This Google account is not authorized for this app.";

type GoogleIdTokenPayload = {
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  exp?: number;
  [key: string]: unknown;
};

let gisInitialized = false;
let storedConfig: AppConfig | null = null;

function decodeGoogleIdTokenPayload(token: string): GoogleIdTokenPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payload = parts[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded =
      normalized + "=".repeat((4 - (normalized.length % 4)) % 4);

    const json = atob(padded);
    return JSON.parse(json) as GoogleIdTokenPayload;
  } catch (error) {
    console.warn("Failed to decode Google ID token payload", error);
    return null;
  }
}

function isSessionExpired(expiresAt?: number): boolean {
  if (!expiresAt) return false;
  return Date.now() >= expiresAt - 60_000;
}

function makeAwsCredentialProviderFromGoogle(
  config: AppConfig,
  googleToken: string
): () => Promise<AwsCredentials> {
  const baseProvider = fromCognitoIdentityPool({
    clientConfig: { region: config.region },
    identityPoolId: config.identityPoolId,
    logins: {
      [GOOGLE_PROVIDER]: googleToken,
    },
  });

  return async () => {
    const creds = await baseProvider();
    return {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
      expiration: creds.expiration,
    };
  };
}

async function validateGoogleAccess(
  config: AppConfig,
  googleToken: string
): Promise<() => Promise<AwsCredentials>> {
  const awsCredentialProvider = makeAwsCredentialProviderFromGoogle(config, googleToken);
  await awsCredentialProvider();
  return awsCredentialProvider;
}

function buildUserProfile(googleToken: string): { userProfile: UserProfile; expiresAt?: number } {
  const payload = decodeGoogleIdTokenPayload(googleToken);
  return {
    userProfile: {
      email: payload?.email,
      name: payload?.name,
      picture: payload?.picture,
    },
    expiresAt: payload?.exp ? payload.exp * 1000 : undefined,
  };
}

function renderGoogleButtonIfContainerExists() {
  if (!window.google || !gisInitialized) return;
  const container = document.getElementById("google-signin-container");
  if (!container) return;

  container.innerHTML = "";

  window.google.accounts.id.renderButton(container, {
    type: "standard",
    theme: "outline",
    size: "large",
    text: "signin_with",
    shape: "rectangular",
    width: 240,
  });
}

function handleUnauthorizedSignIn(error: unknown) {
  console.warn("Google sign-in rejected by Cognito identity pool", error);
  useAuthStore.getState().clearSession();
  useAuthStore.getState().setError(ACCESS_DENIED_MESSAGE);
  useAuthStore.getState().setLoading(false);
}

function ensureGisInitialized(): void {
  const { setError, setLoading } = useAuthStore.getState();

  if (!storedConfig) {
    console.error("initAuthShell must be called before sign-in.");
    setError("Auth shell not initialized.");
    setLoading(false);
    return;
  }

  if (gisInitialized) {
    return;
  }

  if (typeof window === "undefined" || !window.google) {
    console.error(
      "Google Identity Services not available. Did you include https://accounts.google.com/gsi/client in index.html?"
    );
    setError("Google sign-in is unavailable in this environment.");
    setLoading(false);
    return;
  }

  const config = storedConfig;

  window.google.accounts.id.initialize({
    client_id: config.googleClientId,
    callback: async (resp: any) => {
      try {
        const googleToken: string | undefined = resp?.credential;
        if (!googleToken) {
          console.error("Google callback received no credential");
          useAuthStore.getState().setError("Google sign-in failed.");
          useAuthStore.getState().setLoading(false);
          return;
        }

        const { userProfile, expiresAt } = buildUserProfile(googleToken);
        const awsCredentialProvider = await validateGoogleAccess(config, googleToken);

        useAuthStore.getState().setGoogleSession({
          googleToken,
          expiresAt,
          userProfile,
          awsCredentialProvider,
        });
      } catch (error) {
        handleUnauthorizedSignIn(error);
      }
    },
    ux_mode: "popup",
  });

  gisInitialized = true;
  renderGoogleButtonIfContainerExists();
}

async function restoreSavedSession(config: AppConfig) {
  const saved = loadSavedSession();
  if (!saved || useAuthStore.getState().isSignedIn) {
    return;
  }

  if (isSessionExpired(saved.expiresAt)) {
    useAuthStore.getState().clearSession();
    return;
  }

  try {
    const awsCredentialProvider = await validateGoogleAccess(config, saved.googleToken);
    const { userProfile } = buildUserProfile(saved.googleToken);
    useAuthStore.getState().setGoogleSession({
      googleToken: saved.googleToken,
      expiresAt: saved.expiresAt,
      userProfile: saved.userProfile ?? userProfile,
      awsCredentialProvider,
    });
  } catch (error) {
    handleUnauthorizedSignIn(error);
  }
}

type InitAuthShellOptions = {
  config: AppConfig;
};

export function initAuthShell({ config }: InitAuthShellOptions) {
  storedConfig = config;

  void restoreSavedSession(config);

  registerAuthHandlers({
    signIn: () => {
      const { setLoading, setError } = useAuthStore.getState();
      setError(undefined);
      setLoading(true);

      ensureGisInitialized();
      if (!gisInitialized) return;

      try {
        window.google?.accounts.id.prompt();
      } catch (error) {
        console.error("Error invoking google.accounts.id.prompt", error);
        setError("Unable to start Google sign-in.");
        setLoading(false);
      }
    },

    signOut: () => {
      try {
        window.google?.accounts.id.disableAutoSelect();
      } catch (error) {
        console.warn("Failed to disable Google auto-select", error);
      }
    },
  });

  if (typeof window !== "undefined" && window.google) {
    try {
      ensureGisInitialized();
    } catch (error) {
      console.warn("Initial GIS setup failed", error);
    }
  }
}
