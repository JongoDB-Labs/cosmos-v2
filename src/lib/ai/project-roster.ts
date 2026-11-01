// src/lib/ai/project-roster.ts
//
// "Which projects does this person work in?" — resolved ONCE per agent run and handed to
// the model as context, instead of left for the model to discover.
//
// WHY: nothing told Cosmo which projects the caller belongs to. assistant-prompt.ts
// instructs it to "call list_projects with a `query`" to resolve a project the user named,
// so every project-bound request began with a discovery round-trip, and a model that
// guessed instead got a bare "Project not found" it had to interpret. Worse, with an agent
// policy's project allowlist now riding on the AuthContext (policy/project-scope.ts), a
// model with no roster cannot tell "this project does not exist" from "this project is
// outside what I am allowed to touch".
//
// TWO RULES THIS MUST NOT BREAK:
//
//  1. THE ROSTER IS THE ACTOR'S, NOT THE ORG'S. It is resolved from the SAME
//     `AuthContext` the tools are authorised against — the one already narrowed by the
//     agent policy — so what the model is TOLD can never exceed what it can REACH. A
//     roster built from `orgId` alone would be a disclosure channel that every gate in the
//     RBAC layer is bypassed to feed.
//
//  2. PROJECT NAMES ARE DATA AND GO THROUGH THE EGRESS GATE. `EXPOSABLE_FIELDS.project` is
//     `["id", "archived", "createdAt", "updatedAt"]` — `name` and `key` are deliberately
//     NOT exposable, and `list_projects` already returns "the project's id even when the
//     name is withheld from you". So this roster is gated as `valueKind: "tool_result"`
//     under `toolName: "list_projects"`, the same way that tool's own result is gated.
//     It must NOT be gated as `valueKind: "system"`: the gate treats system prompts as
//     non-data and exposes them unconditionally, which would hand a gov tenant exactly the
//     names the projection withholds.
//
// Below the ceiling on a commercial tenant the model gets names and keys (what it needs to
// resolve "the Acme project" without a lookup). At or above FOUO, or on a gov tenant, it
// degrades to the structural projection — ids only — which still lets it scope tool calls
// and still tells it how many projects it may touch.

import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import type { ClassificationLevel } from "@prisma/client";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { getVisibleProjectIds } from "@/lib/rbac/project-access";
import { projectForModel, projectResult, logEgressDecision, type TenantClass } from "./egress";
import { conservativeCeiling } from "@/lib/classification/effective";

/** One project as the roster carries it before gating. */
interface RosterProject {
  id: string;
  key: string;
  name: string;
  archived: boolean;
}

export interface ProjectRosterOptions {
  auth: AuthContext;
  orgId: string;
  tenantClass: TenantClass;
  conversationId: string;
  /**
   * The run's read ceiling. Normally omitted: this module resolves
   * `conservativeCeiling(orgId)` itself, and ONLY once it has a non-empty roster to gate.
   *
   * That laziness is deliberate. Resolving it eagerly at the call site meant an extra
   * `conservativeCeiling` call on every run, including runs with no projects at all — which
   * perturbed the call ORDER the C1 red-team spec sequences its ceilings by
   * (handles-loop.redteam.test.ts drives turn-1 vs turn-2 off a call counter). A ceiling
   * nobody needs should not be computed, and a security spec should not have to be rewritten
   * to absorb a prompt feature's bookkeeping.
   */
  ceiling?: ClassificationLevel;
}

/**
 * The actor's projects, as a block to append to the system prompt — or `null` when there
 * is nothing useful to say (no readable projects, or the gate left nothing renderable).
 *
 * `null` rather than an empty block on purpose: "you have access to no projects" is a
 * sentence worth saying, but an EMPTY list in the prompt reads to a model as an
 * authoritative "this org has no projects" and invites it to tell the user so. The caller
 * decides; this returns text only when there is text.
 */
export async function projectRosterBlock(opts: ProjectRosterOptions): Promise<string | null> {
  const rows = await resolveRoster(opts.auth, opts.orgId);
  if (rows.length === 0) return null;

  // Resolved HERE, after the roster is known non-empty — see `ceiling` in the options.
  const ceiling = opts.ceiling ?? (await conservativeCeiling(opts.orgId));

  // Gated EXACTLY as a `list_projects` result is: same valueKind, same toolName, same
  // ceiling. Reusing the chokepoint rather than re-deriving the rule is the whole point —
  // a second copy of "may the model see a project name" is a second thing to get wrong.
  const gated = projectForModel(rows, {
    orgId: opts.orgId,
    userId: opts.auth.userId,
    conversationId: opts.conversationId,
    turn: 0,
    tenantClass: opts.tenantClass,
    mode: "enforced",
  }, { valueKind: "tool_result", toolName: "list_projects", ceiling });

  // Audited like any other egress decision, so "what was the assistant shown" has a row
  // for the roster too rather than a silent injection.
  logEgressDecision(gated.decision);

  if (gated.decision.exposed) {
    const lines = rows.map((p) => `- ${p.name} (key ${p.key}, id ${p.id})${p.archived ? " [archived]" : ""}`);
    return [
      `The person you are helping works in these ${rows.length} project${rows.length === 1 ? "" : "s"}, and you can only read and write within them:`,
      ...lines,
      "Use these ids directly — do not call list_projects to rediscover them. If the person names a project that is not in this list, say you do not have access to it rather than searching for it.",
    ].join("\n");
  }

  // WITHHELD: ids only, via the same structural projection a withheld tool result gets.
  const structural = projectResult(rows, "project");
  const ids = Array.isArray(structural)
    ? structural.map((p) => (p as { id?: string }).id).filter((id): id is string => typeof id === "string")
    : [];
  if (ids.length === 0) return null;
  return [
    `The person you are helping works in these ${ids.length} project${ids.length === 1 ? "" : "s"}, and you can only read and write within them. Their names are withheld at this data classification; use the ids:`,
    ...ids.map((id) => `- ${id}`),
    "Do not call list_projects to rediscover them — the names are withheld there too. If the person names a project, match it by asking them rather than guessing.",
  ].join("\n");
}

/**
 * The actor's projects: readable for work items AND visible as projects.
 *
 * The intersection, not either alone, following the precedent in
 * `query/resolve.server.ts` (the `hasAttachments` predicate) — `getReadableProjectIds`
 * answers "may I read items here" (ITEM_READ, which a GUEST holds) while
 * `getVisibleProjectIds` answers "may I see this project at all" (PROJECT_READ, which a
 * GUEST does not). A roster is project METADATA, so it takes the narrower of the two: a
 * GUEST gets no roster, which is fail-closed and the right direction for a name channel.
 *
 * Both helpers consult `projectScope` ahead of every role short-circuit, so an agent
 * policy's allowlist — and a project-scoped API key's ceiling — already bind here.
 */
async function resolveRoster(auth: AuthContext, orgId: string): Promise<RosterProject[]> {
  const readable = await getReadableProjectIds(auth);
  if (readable.length === 0) return [];
  const visible = await getVisibleProjectIds(auth, readable);
  if (visible.size === 0) return [];

  const rows = await prisma.project.findMany({
    where: { orgId, id: { in: [...visible] } },
    select: { id: true, key: true, name: true, archivedAt: true },
    orderBy: { key: "asc" },
  });
  return rows.map((p) => ({ id: p.id, key: p.key, name: p.name, archived: p.archivedAt !== null }));
}
