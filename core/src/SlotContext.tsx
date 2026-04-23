import { createContext } from "react";

/**
 * Provided by SlotContainer to its loaded child module.
 * Allows the child to update its own slot's meta in the parent config without
 * knowing where the parent config lives — SlotContainer handles the S3 write.
 * Does NOT dispatch shell:navigate; the module decides whether to navigate.
 */
export type SlotContextValue = {
  slotId: string;
  targetId: string;
  updateSlotMeta: (newMeta: Record<string, unknown>) => Promise<void>;
  updateSlotChildren: (children: import("./types.ts").ChildSlot[]) => Promise<void>;
};

export const SlotContext = createContext<SlotContextValue | null>(null);
