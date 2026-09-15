import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { NOT_VOIDED } from "@/lib/time/not-voided";
import { z } from "zod";

const billedSchema = z.object({
  /**
   * Hours to bill. NULL clears the decision and reverts to billing what was
   * logged; 0 is a decision in its own right -- "worked, not billed".
   *
   * Capped at 24 per entry for the same reason `hours` is: a day is the unit,
   * and a four-digit figure here is a typo that would reach an invoice.
   */
  billedHours: z.number().min(0).max(24).nullable(),
});

type RouteParams = { params: Promise<{ orgId: string; entryId: string }> };

/**
 * Set the billed hours on a time entry.
 *
 * Billing is a SECOND decision, taken from the approved log rather than in place
 * of it: approving says "these hours were worked", billing says "this is what
 * the client pays for". Holding them apart is what lets the two numbers differ
 * and still both be auditable -- which is the whole reason billed is its own
 * column instead of an edit to `hours`.
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, entryId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TIME_BILL);

    const existing = await prisma.timeEntry.findFirst({
      where: { id: entryId, orgId, ...NOT_VOIDED },
      select: { id: true, status: true, hours: true, billedHours: true },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // "Billed hours FROM approved logged hours" -- there is nothing to bill from
    // until the log has been approved, and billing a draft would let a number
    // reach an invoice that nobody has yet agreed was worked.
    if (existing.status !== "APPROVED") {
      return new Response(
        JSON.stringify({ error: "Only approved entries can be billed" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const data = billedSchema.parse(await request.json());

    const updated = await prisma.timeEntry.update({
      where: { id: entryId },
      data: {
        billedHours: data.billedHours,
        // Cleared together with the value: a stamp left behind on a null would
        // claim a decision that no longer exists.
        billedById: data.billedHours === null ? null : ctx.userId,
        billedAt: data.billedHours === null ? null : new Date(),
      },
      select: { id: true, hours: true, billedHours: true, billedAt: true, status: true },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "time_entry.billed_set",
      entity: "time_entry",
      entityId: entryId,
      // Both numbers, because the gap between them is the thing worth being able
      // to account for later.
      metadata: {
        loggedHours: String(existing.hours),
        previousBilled: existing.billedHours === null ? "as_logged" : String(existing.billedHours),
        billedHours: data.billedHours === null ? "as_logged" : String(data.billedHours),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}
