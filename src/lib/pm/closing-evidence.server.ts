import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { documentVisibilityWhere } from "@/lib/files/access";
import { workflowSettings } from "@/lib/workflow/settings";
import { closingRuleOn } from "@/lib/workflow/closing-rule";
import { problem } from "@/lib/openapi/problem";
import { CLOSED_DELIVERABLE_STATUSES, type ClosingRefusal } from "./closing-evidence";

/** Is the closing rule on for this project? The org's switch, overridden by the project's own. */
export async function closingRuleForProject(orgId: string, projectId: string): Promise<boolean> {
  const [org, project] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } }),
    prisma.project.findFirst({ where: { id: projectId, orgId }, select: { settings: true } }),
  ]);
  return closingRuleOn(workflowSettings(org?.settings).closingRule, project?.settings);
}

/**
 * The supporting files on a deliverable or phase that this caller may see.
 *
 * Counted by the file rule, not in full: whether the "why is there no file"
 * question appears is itself an answer, so counting a restricted file the
 * caller cannot open told them it exists. The caller is already working in
 * `projectId` (the routes check it), which is the only project these files sit in.
 */
export function evidenceFiles(
  orgId: string,
  on: { deliverableId: string } | { phaseId: string },
  ctx: AuthContext,
  projectId: string,
): Promise<number> {
  return prisma.document.count({ where: { orgId, ...on, ...documentVisibilityWhere(ctx, new Set([projectId])) } });
}

/** A refusal as the response: 422, with a code a client can branch on. */
export function closingProblem(refusal: ClosingRefusal, request?: Request) {
  return problem(422, refusal.code, refusal.message, request ? { request } : undefined);
}

/** A phase as the close and reopen routes answer with it. */
export const PHASE_SELECT = { id: true, name: true, closedAt: true, closedById: true, closeEvidenceNote: true } as const;

/**
 * Is this file evidence on a closed deliverable or phase, under the rule?
 * Then taking it off (detaching, moving, deleting) would edit a closed record,
 * and is refused until the record is reopened. Adding a file is not refused:
 * more evidence never weakens a record.
 */
export async function evidenceLocked(
  orgId: string,
  doc: { deliverableId: string | null; phaseId: string | null },
): Promise<boolean> {
  const [deliverable, phase] = await Promise.all([
    doc.deliverableId
      ? prisma.deliverable.findFirst({ where: { id: doc.deliverableId, orgId }, select: { status: true, projectId: true } })
      : null,
    doc.phaseId
      ? prisma.projectPhase.findFirst({ where: { id: doc.phaseId, orgId }, select: { closedAt: true, projectId: true } })
      : null,
  ]);
  const closedOn = [
    deliverable && CLOSED_DELIVERABLE_STATUSES.includes(deliverable.status) ? deliverable.projectId : null,
    phase?.closedAt ? phase.projectId : null,
  ].filter((p): p is string => p !== null);
  for (const projectId of new Set(closedOn)) {
    if (await closingRuleForProject(orgId, projectId)) return true;
  }
  return false;
}
