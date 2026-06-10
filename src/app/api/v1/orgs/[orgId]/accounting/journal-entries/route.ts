import { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError } from "@/lib/api-helpers";
import { postEntry, ClosedPeriodError } from "@/lib/ledger/posting";

type RouteParams = { params: Promise<{ orgId: string }> };

// Amounts arrive as strings (Decimal-safe) or numbers; coerce to a positive
// Prisma.Decimal. The balance check lives in postEntry/assertBalanced.
const lineSchema = z.object({
  accountId: z.string().uuid(),
  direction: z.enum(["DEBIT", "CREDIT"]),
  amount: z.union([z.string(), z.number()]),
  description: z.string().max(500).nullish(),
});

const createSchema = z.object({
  date: z.string(),
  memo: z.string().max(500).optional(),
  lines: z.array(lineSchema).min(2).max(100),
});

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ACCOUNTING_READ);

    const take = Math.min(Number(request.nextUrl.searchParams.get("limit")) || 50, 200);
    const entries = await prisma.journalEntry.findMany({
      where: { orgId, status: "POSTED" },
      orderBy: { entryNumber: "desc" },
      take,
      include: {
        lines: {
          include: {
            account: { select: { code: true, name: true } },
          },
        },
      },
    });
    return success({ data: entries, total: entries.length });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * POST — create a MANUAL journal entry (manage gate). Delegates to the tested
 * `postEntry` primitive, which enforces balanced double-entry (>=2 lines, each
 * positive, debits == credits), the closed-period guard, and atomic posting.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ACCOUNTING_MANAGE);

    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response("Bad Request", { status: 400 });

    const date = new Date(parsed.data.date);
    if (Number.isNaN(date.getTime())) return new Response("Bad Request", { status: 400 });

    // Every line's account must belong to this org (no cross-tenant posting).
    const accountIds = [...new Set(parsed.data.lines.map((l) => l.accountId))];
    const okCount = await prisma.account.count({
      where: { orgId, id: { in: accountIds } },
    });
    if (okCount !== accountIds.length) {
      return new Response(JSON.stringify({ error: "Unknown account in entry" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    let lines;
    try {
      lines = parsed.data.lines.map((l) => ({
        accountId: l.accountId,
        direction: l.direction,
        amount: new Prisma.Decimal(l.amount),
        description: l.description ?? null,
      }));
    } catch {
      return new Response(JSON.stringify({ error: "Invalid line amount" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    try {
      const entry = await postEntry({
        orgId,
        createdById: ctx.userId,
        date,
        memo: parsed.data.memo,
        source: "MANUAL",
        lines,
      });
      return created(entry);
    } catch (err) {
      if (err instanceof ClosedPeriodError) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      // assertBalanced + positivity errors are user-fixable → 400 with message.
      const message = err instanceof Error ? err.message : "Couldn't post the entry";
      return new Response(JSON.stringify({ error: message }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
  } catch (error) {
    return handleApiError(error);
  }
}
