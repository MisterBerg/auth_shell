export type AppConfig = {
  region: string;
  identityPoolId: string;
  googleClientId: string;
  /** S3 bucket and config path for the default org landing page module. */
  defaultAppBucket: string;
  defaultAppConfigPath: string;
};

export const CONFIG: AppConfig = {
  region: "us-east-2",
  identityPoolId: "us-east-2:56ea9e92-144b-4c7c-993a-efc40288f4c2",
  googleClientId:
    "521862731900-p550uliqjs8r7jtgao1mlbj62smjjvrf.apps.googleusercontent.com",
  // The default app loaded when no ?config= URL param is present.
  // Update these to wherever the built app-landing bundle is deployed.
  defaultAppBucket: "my-org-shell-assets",
  defaultAppConfigPath: "apps/landing/config.json",
};
