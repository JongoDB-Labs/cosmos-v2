// src/lib/ai/policy/project-scope.ts
//
// The agent policy's project allowlist, applied as a CEILING ON THE ACTOR'S CONTEXT
// rather than as a check on a model-supplied argument.
//
// WHY THIS EXISTS (the bug it fixes):
// `checkAgentPolicy`'s arg axis enforced `allowedProjectIds` like this —
//
//     if (policy.allowedProjectIds !== null) {
//       const projectId = typeof args.projectId === "string" ? args.projectId : undefined;
//       if (projectId !== undefined && !policy.allowedProjectIds.includes(projectId)) deny;
//     }
//
// — i.e. ONLY when the call happened to carry a string `projectId`. Two ways past it:
//
//   1. A tool that takes no project at all. `get_work_item` takes only `itemId`, so an
//      item inside a project the admin excluded carried no `projectId` and the axis
//      never fired.
//   2. Omission. For a tool where the argument IS optional, a model that leaves it out
//      reads as "no project named" rather than "every project", so the allowlist that
//      was configured to narrow the agent silently stopped applying.
//
// Both are the same defect: a security decision keyed on a value the model supplies and
// can withhold. The same shape as the read-path ceiling fixed in 2.506.3, where
// `effectiveCeiling(orgId, projectId)` became `conservativeCeiling(orgId)` to take model
// input out of the decision.
//
// THE FIX: fold the allowlist into `AuthContext.projectScope` once, at the agent-loop
// boundary. `inKeyProjectScope` (rbac/check.ts) is consulted by every project gate in the
// RBAC layer — `isProjectVisible`, `getReadableProjectIds`, `getVisibleProjectIds`,
// `requireAccess`, `requireProjectManage`, `project-role`, `files/access` — always AHEAD
// of the role short-circuits, and it is NOT gated on `isApiKey`:
//
//     if (!ctx.projectScope) return true;
//     return !!projectId && ctx.projectScope.includes(projectId);
//
// So one narrowing here is enforced at every one of those sites, against the projectId the
// SERVER resolved from the row (`get_work_item` passes `item.projectId`), never against an
// argument. There is no argument to omit.
//
// NARROWING ONLY. A project-scoped API key may ALSO be driving the agent, so the two
// ceilings INTERSECT — this must never hand back a project the incoming context could not
// already reach, or an agent policy would become a privilege-escalation route.

import type { AuthContext } from "@/lib/rbac/check";

/**
 * Apply an agent policy's project allowlist to the actor's `AuthContext`.
 *
 * - `allowedProjectIds === null` (no restriction — the permissive default for an org that
 *   never opted in) ⇒ the context is returned UNCHANGED, so behavior is identical to
 *   before this existed.
 * - Otherwise `projectScope` becomes the INTERSECTION of the incoming scope (a
 *   project-scoped API key's ceiling, when there is one) and the allowlist.
 *
 * Returns a fresh object; never mutates `auth`. The result's `projectScope` can only ever
 * be a subset of the incoming one — `[]` (reach nothing) is a legitimate outcome and is
 * what an allowlist disjoint from a key's scope must produce.
 */
export function narrowAuthToPolicyProjects(
  auth: AuthContext,
  allowedProjectIds: string[] | null,
): AuthContext {
  // The permissive default. Returning `auth` itself (not a copy) keeps the no-policy path
  // allocation-free and makes "unchanged" literally true for callers comparing identity.
  if (allowedProjectIds === null) return auth;

  // Intersect, never replace. With no incoming scope the allowlist IS the new ceiling;
  // with one, only projects in BOTH survive. Deduplicated, because `projectScope` is
  // membership-tested and a duplicate would be a silent no-op that still costs a scan.
  const allowed = new Set(allowedProjectIds);
  const projectScope = auth.projectScope
    ? [...new Set(auth.projectScope.filter((id) => allowed.has(id)))]
    : [...allowed];

  return { ...auth, projectScope };
}
