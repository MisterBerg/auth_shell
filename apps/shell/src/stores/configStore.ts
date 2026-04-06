// src/stores/configStore.ts
import { create } from "zustand";
import type { AppConfig } from "../config";

export type ConfigState = {
  config: AppConfig | null;
  setConfig: (cfg: AppConfig) => void;
};

export const useConfigStore = create<ConfigState>((set) => ({
  config: null,
  setConfig: (cfg) => set({ config: cfg }),
}));
