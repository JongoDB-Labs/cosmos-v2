import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireEmployeeAdmin } from "@/lib/rbac/employee-admin";
import { createEmployeesForMembers } from "@/lib/payroll/service";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * A sanity bound, not a product limit. Real orgs onboarding onto payroll send
 * their whole member list at once, so the cap has to clear that comfortably;
 * it exists only so a hostile body cannot ask for an unbounded INSERT.
 */
const MAX_PER_BATCH = 200;

const bodySchema = z.object({
  /** Org member USER ids — not employee ids; these people have no employee row yet. */
  userIds: z.array(z.string().uuid()).min(1).max(MAX_PER_BATCH),
});

/**
 * Give many org members employee records at once.
 *
 * Supervision, timesheet approval and labor costing all hang off `Employee`. An
 * org that has never used payroll has members and no employee rows at all,
 * which means nobody can be assigned a supervisor and the whole approval chain
 * is inert — and the only cure was adding people one at a time, each needing a
 * cost rate typed in. This is the bulk way in.
 *
 * Every new record starts on a cost rate of ZERO and is expected to. See
 * `createEmployeesForMembers` for why a guessed rate is the worse failure.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requireEmployeeAdmin(ctx.permissions);

    const { userIds } = bodySchema.parse(await request.json());
    const { createdUserIds, skippedUserIds } = await createEmployeesForMembers(
      orgId,
      ctx.userId,
      userIds,
    );

    if (createdUserIds.length > 0) {
      // ONE record for the batch, carrying who was created. An entry per person
      // would bury the fact that this was a single deliberate action, and the
      // question an auditor asks — "who was put on payroll, when, by whom" — is
      // answered by the list, not by replaying N events. Nothing is written
      // when nothing was created: a re-run that changes no state is not an
      // event, and logging it would make the audit trail lie about how many
      // times people were onboarded.
      await logAudit({
        orgId,
        userId: ctx.userId,
        action: "employee.bulk_created",
        entity: "employee",
        metadata: { userIds: createdUserIds, skippedCount: skippedUserIds.length },
        ipAddress: getIpAddress(request),
      });
    }

    return success({
      created: createdUserIds.length,
      skipped: skippedUserIds.length,
      createdUserIds,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
