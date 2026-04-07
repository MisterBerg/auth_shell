export type AppConfig = {
  region: string;
  identityPoolId: string;
  googleClientId: string;
  /** S3 bucket and config path for the default org landing page module. */
  defaultAppBucket: string;
  defaultAppConfigPath: string;
  /** DynamoDB table names — differ between local Docker dev and real AWS. */
  tables: {
    registry: string;
    projects: string;
  };
};

export const CONFIG: AppConfig = {
  region: "us-east-2",
  identityPoolId: "us-east-2:56ea9e92-144b-4c7c-993a-efc40288f4c2",
  googleClientId:
    "521862731900-p550uliqjs8r7jtgao1mlbj62smjjvrf.apps.googleusercontent.com",
  defaultAppBucket: "jeffspace-modules",
  defaultAppConfigPath: "apps/landing/config.json",
  tables: {
    registry: import.meta.env.DEV ? "module-registry"      : "jeffspace-module-registry",
    projects: import.meta.env.DEV ? "org-projects"         : "jeffspace-projects",
  },
};
