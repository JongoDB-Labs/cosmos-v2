/**
 * An org's workflow settings, on Organization.settings.workflow.
 *
 * `blockParentWithOpenChildren` (default on) puts the parent guard the board
 * has always applied on the server, on every path: a parent cannot move into a
 * Done status while a child is still open. `resolutions` is the list a
 * transition asking for a resolution offers.
 */
export interface WorkflowSettings {
  blockParentWithOpenChildren: boolean;
  /** The outcomes a transition into Done or Cancelled offers (design §3.7). Stored as text. */
  resolutions: string[];
}

export const DEFAULT_RESOLUTIONS = ["Fixed", "Won't do", "Duplicate", "Cannot reproduce"];

export function workflowSettings(settings: unknown): WorkflowSettings {
  const s = (settings ?? {}) as { workflow?: { blockParentWithOpenChildren?: unknown; resolutions?: unknown } };
  const resolutions = s.workflow?.resolutions;
  return {
    blockParentWithOpenChildren: s.workflow?.blockParentWithOpenChildren !== false,
    resolutions:
      Array.isArray(resolutions) && resolutions.length > 0 && resolutions.every((r) => typeof r === "string")
        ? resolutions
        : DEFAULT_RESOLUTIONS,
  };
}

export function withWorkflowSettings(settings: unknown, patch: Partial<WorkflowSettings>): Record<string, unknown> {
  const s = { ...((settings ?? {}) as Record<string, unknown>) };
  s.workflow = { ...((s.workflow as Record<string, unknown>) ?? {}), ...patch };
  return s;
}
