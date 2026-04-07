import { fromCognitoIdentityPool } from "@aws-sdk/credential-providers";
import type { AppConfig } from "../config";
import {
  useAuthStore,
  registerAuthHandlers,
  loadSavedSession,
  type AwsCredentials,
} from "../stores/authStore";

declare global {
  interface Window {
    google?: any;
  }
}

const GOOGLE_PROVIDER = "accounts.google.com";

type GoogleIdTokenPayload = {
  email?: string;
  name?: string;
  picture?: string;
  [key: string]: any;
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
    return JSON.parse(json);
  } catch (e) {
    console.warn("Failed to decode Google ID token payload", e);
    return null;
  }
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

function renderGoogleButtonIfContainerExists() {
  if (!window.google || !gisInitialized) return;
  const container = document.getElementById("google-signin-container");
  if (!container) return;

  // Clear any previous button instance
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

/**
 * Initialize GIS once and register the ID token callback.
 */
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
    callback: (resp: any) => {
      try {
        const googleToken: string | undefined = resp?.credential;
        if (!googleToken) {
          console.error("Google callback received no credential");
          useAuthStore.getState().setError("Google sign-in failed.");
          useAuthStore.getState().setLoading(false);
          return;
        }

        const awsCredentialProvider = makeAwsCredentialProviderFromGoogle(
          config,
          googleToken
        );

        const payload = decodeGoogleIdTokenPayload(googleToken);
        const userProfile = {
          email: payload?.email,
          name: payload?.name,
          picture: payload?.picture,
        };

        useAuthStore.getState().setGoogleSession({
          googleToken,
          userProfile,
          awsCredentialProvider,
        });
      } catch (err) {
        console.error("Error in Google sign-in callback", err);
        useAuthStore.getState().setError("Google sign-in failed.");
        useAuthStore.getState().setLoading(false);
      }
    },
    ux_mode: "popup",
  });

  gisInitialized = true;
  renderGoogleButtonIfContainerExists();
}

// --- public entrypoint used by AuthGate ---

type InitAuthShellOptions = {
  config: AppConfig;
};

export function initAuthShell({ config }: InitAuthShellOptions) {
  storedConfig = config;

  // Restore session from sessionStorage if a previous Google token was saved.
  // This keeps the user signed in across hard reloads within the same tab session.
  const saved = loadSavedSession();
  if (saved && !useAuthStore.getState().isSignedIn) {
    const awsCredentialProvider = makeAwsCredentialProviderFromGoogle(config, saved.googleToken);
    useAuthStore.getState().setGoogleSession({
      googleToken: saved.googleToken,
      userProfile: saved.userProfile,
      awsCredentialProvider,
    });
  }

  // Register handlers so the store always has something (even if we don't
  // call signInWithGoogle from UI anymore, this keeps the plumbing sane).
  registerAuthHandlers({
    signIn: () => {
      // This is now mainly for future One Tap / programmatic flows.
      const { setLoading, setError } = useAuthStore.getState();
      setError(undefined);
      setLoading(true);

      ensureGisInitialized();
      if (!gisInitialized) return;

      try {
        window.google?.accounts.id.prompt();
      } catch (err) {
        console.error("Error invoking google.accounts.id.prompt", err);
        setError("Unable to start Google sign-in.");
        setLoading(false);
      }
    },

    signOut: () => {
      try {
        window.google?.accounts.id.disableAutoSelect();
      } catch (err) {
        console.warn("Failed to disable Google auto-select", err);
      }
      // clearing Zustand session is handled by authStore.signOut()
    },
  });

  // Try to initialize immediately; when the React tree mounts,
  // the #google-signin-container div will be there and we can render into it.
  if (typeof window !== "undefined" && window.google) {
    try {
      ensureGisInitialized();
      // renderGoogleButtonIfContainerExists is called inside ensureGisInitialized
    } catch (err) {
      console.warn("Initial GIS setup failed", err);
    }
  }
}
