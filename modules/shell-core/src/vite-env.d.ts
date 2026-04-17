/// <reference types="vite/client" />

declare module "app-landing" {
  import type React from "react";
  import type { ModuleProps } from "module-core";

  const Component: React.ComponentType<ModuleProps>;
  export default Component;
}
