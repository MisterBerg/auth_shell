// src/config.ts
export type AppConfig = {
  region: string;
  identityPoolId: string;
  googleClientId: string;
  // future: userPoolId, appClientId, project metadata endpoints, etc.
};

export const CONFIG: AppConfig = {
  region: "us-east-2",
  identityPoolId: "us-east-2:56ea9e92-144b-4c7c-993a-efc40288f4c2",
  googleClientId:
    "521862731900-p550uliqjs8r7jtgao1mlbj62smjjvrf.apps.googleusercontent.com",
};
