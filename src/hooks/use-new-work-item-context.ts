"use client";

import { useEffect } from "react";
import {
  clearNewWorkItemContext,
  setNewWorkItemContext,
  type NewWorkItemContext,
} from "@/lib/boards/new-work-item-context";

/**
 * Publish this surface's "new work item, here" context for the command palette
 * (COSMOS-166), and retract it on unmount.
 *
 * `ctx` must be memoised by the caller — it is the effect's only dependency, so
 * an object rebuilt every render would republish on every render.
 */
export function usePublishNewWorkItemContext(ctx: NewWorkItemContext | null): void {
  useEffect(() => {
    if (!ctx) return;
    setNewWorkItemContext(ctx);
    return () => clearNewWorkItemContext(ctx);
  }, [ctx]);
}
