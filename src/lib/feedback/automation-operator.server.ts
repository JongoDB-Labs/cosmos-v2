import type { Prisma } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";
import { logAudit, type AuditWriter } from "@/lib/audit";
import {
  OPERATOR_ONLY_MESSAGE,
  automationAuditDelta,
  automationWidening,
  type AutomationConfig,
} from "@/lib/feedback/automation-config";

/**
 * Who may widen feedback automation, and the record of every change to it.
 *
 * Turning on autonomous delivery or auto-triage, adding a project to either,
 * or raising the parallel build workers puts more of an org's work into the
 * deployment's shared build pool, which runs on the instance operator's host
 * (the pool runs the highest worker count any enabled org asks for). On an
 * instance with several organizations that is the operator's decision, not a
 * tenant admin's, so it needs the operator on top of ORG_UPDATE. Narrowing
 * (turning off, removing projects, fewer workers) stays with ORG_UPDATE and is
 * never refused here.
 *
 * The feedback automation config route is the only writer of
 * `settings.autoRemediation` and `settings.autonomousDelivery`. The general
 * organization update refuses any `settings`, and the other settings routes
 * write only their own key in one statement (patchOrgSettings), so none of
 * them can put back a config the operator has changed.
 */

/** True when the actor is the instance operator: a signed-in person (never an
 *  API key) on the INTERNAL_ADMINS allowlist, and the same person the request's
 *  auth context belongs to. */
export async function isInstanceOperator(ctx: AuthContext): Promise<boolean> {
  if (ctx.isApiKey) return false;
  const me = await requireSystemAdmin();
  return me !== null && me.id === ctx.userId;
}

/** The refusal for a widen by anyone but the operator. Nothing is stored. */
export function operatorOnlyResponse(): Response {
  return Response.json({ error: OPERATOR_ONLY_MESSAGE }, { status: 403 });
}

/** The org's settings as stored, read under a row lock so the widen decision
 *  and the write that follows it see the same row. */
export async function lockOrgSettings(tx: Prisma.TransactionClient, orgId: string): Promise<unknown> {
  const [row] = await tx.$queryRaw<{ settings: unknown }[]>`
    SELECT settings FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
  return row?.settings ?? {};
}

interface AutomationAuditEntry {
  orgId: string;
  userId: string;
  before: AutomationConfig;
  after: AutomationConfig;
  ipAddress?: string;
}

/** Audit a change to either enabled flag, either project list or the worker
 *  count. Writes nothing when none moved; records counts, never which
 *  projects. Pass the transaction that makes the change, so a row that can't
 *  be written rolls the change back rather than leaving it unrecorded. */
export async function auditAutomationChange(
  db: AuditWriter,
  entry: AutomationAuditEntry & { byOperator: boolean },
): Promise<void> {
  const delta = automationAuditDelta(entry.before, entry.after);
  if (!delta) return;
  await logAudit(
    {
      orgId: entry.orgId,
      userId: entry.userId,
      action: "feedback_automation.changed",
      entity: "organization",
      entityId: entry.orgId,
      metadata: { ...delta, byOperator: entry.byOperator },
      ipAddress: entry.ipAddress,
    },
    db,
  );
}

/** Audit a widen that was refused because the actor isn't the operator: who,
 *  and what they asked for as flags and counts. Nothing was changed, so this
 *  is written on its own, after the transaction that decided. */
export async function auditAutomationRefusal(entry: AutomationAuditEntry): Promise<void> {
  await logAudit({
    orgId: entry.orgId,
    userId: entry.userId,
    action: "feedback_automation.refused",
    entity: "organization",
    entityId: entry.orgId,
    metadata: { ...automationWidening(entry.before, entry.after) },
    ipAddress: entry.ipAddress,
  });
}
