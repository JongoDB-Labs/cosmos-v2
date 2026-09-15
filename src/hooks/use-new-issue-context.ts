"use client";

import { useEffect } from "react";
import {
  clearNewIssueContext,
  setNewIssueContext,
  type NewIssueContext,
} from "@/lib/boards/new-issue-context";

/**
 * Publish this surface's "new issue, here" context for the command palette
 * (COSMOS-166), and retract it on unmount.
 *
 * `ctx` must be memoised by the caller — it is the effect's only dependency, so
 * an object rebuilt every render would republish on every render.
 */
export function usePublishNewIssueContext(ctx: NewIssueContext | null): void {
  useEffect(() => {
    if (!ctx) return;
    setNewIssueContext(ctx);
    return () => clearNewIssueContext(ctx);
  }, [ctx]);
}
