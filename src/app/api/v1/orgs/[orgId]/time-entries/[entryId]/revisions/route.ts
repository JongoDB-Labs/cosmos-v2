import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { readableTimeUserIds, timeUserIdFilter } from "@/lib/time/scope";
import { canSeeRate } from "@/lib/time/visibility";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string; entryId: string }> };

/**
 * What this entry used to say — the audit trail, oldest first.
 *
 * Without a way to read them, revisions are a table nobody can answer a
 * question from, which is the same as not having them.
 *
 * Scoped exactly like the entry itself: you may read the history of an entry
 * you may read. Resolving the ENTRY first (under the read scope) and only then
 * fetching revisions means an unreadable entry is a 404 here too, rather than
 * leaking its existence through its history.
 *
 * VOIDED entries are deliberately still readable here. The void is the most
 * important thing in the trail — "these hours were removed, by whom, and why"
 * — and hiding it would defeat the point.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, entryId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TIME_READ);

    const entry = await prisma.timeEntry.findFirst({
      where: {
        id: entryId,
        orgId,
        userId: timeUserIdFilter(await readableTimeUserIds(ctx)),
      },
      select: { id: true, userId: true },
    });
    if (!entry) return new Response("Not found", { status: 404 });

    const revisions = await prisma.timeEntryRevision.findMany({
      where: { orgId, timeEntryId: entryId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        previous: true,
        changed: true,
        reason: true,
        actorId: true,
        createdAt: true,
        // actorIp is deliberately NOT selected: it is investigative data for
        // the audit log, not something to hand to every colleague who can see
        // the entry.
      },
    });

    // Rate history follows the same rule as the rate itself — own row, or
    // FINANCE_READ. Otherwise the trail becomes a way to read a colleague's
    // rate that the entry endpoint refuses to show.
    const maySeeRate = canSeeRate(ctx, entry.userId);
    const data = maySeeRate
      ? revisions
      : revisions.map((r) => ({
          ...r,
          previous: stripRate(r.previous),
          changed: stripRate(r.changed),
        }));

    return success({ data, total: data.length });
  } catch (error) {
    return handleApiError(error);
  }
}

function stripRate(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const copy = { ...(value as Record<string, unknown>) };
  if ("rate" in copy) copy.rate = null;
  return copy;
}
