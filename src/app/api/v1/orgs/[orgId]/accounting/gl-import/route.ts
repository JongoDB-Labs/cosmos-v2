import { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getAuthContext } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { ClosedPeriodError } from "@/lib/ledger/posting";
import { GlImportError, planGlImport } from "@/lib/ledger/gl-import";
import { currentBalances, importTrialBalance } from "@/lib/ledger/gl-import-service";
import { parseTrialBalanceCsv } from "@/lib/ledger/trial-balance-csv";

type RouteParams = { params: Promise<{ orgId: string }> };

const rowSchema = z.object({
  code: z.string().min(1).max(32),
  debit: z.union([z.string(), z.number()]).optional(),
  credit: z.union([z.string(), z.number()]).optional(),
});

/**
 * Either paste a CSV export or send parsed rows. `commit` is what separates a
 * dry run from a posting: everything else about the two is identical, so the
 * numbers on the preview are the numbers that post.
 */
const bodySchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "asOf must be an ISO date, yyyy-mm-dd"),
  csv: z.string().max(2_000_000).optional(),
  rows: z.array(rowSchema).max(2000).optional(),
  memo: z.string().max(500).optional(),
  commit: z.boolean().default(false),
});

const dec = (v: string | number | undefined) => new Prisma.Decimal(v ?? 0);

/**
 * Import a trial balance into the ledger.
 *
 * POST with `commit: false` (the default) previews: it returns the adjusting
 * entry that WOULD be posted, the balancing figure headed for Opening Balance
 * Equity, and the submitted file's own imbalance — three numbers a person
 * should see before any of this reaches the books.
 *
 * ACCOUNTING_MANAGE either way. A preview reads every account balance in the
 * org, which is not something a viewer should be able to do by asking nicely.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ACCOUNTING_MANAGE);

    const body = bodySchema.parse(await request.json());
    if (!body.csv && !body.rows) {
      return new Response(JSON.stringify({ error: "Send either csv or rows" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const parsed = body.csv ? parseTrialBalanceCsv(body.csv) : { rows: [], skipped: [] };
    const submitted = body.rows
      ? body.rows.map((r) => ({ code: r.code, debit: dec(r.debit), credit: dec(r.credit) }))
      : parsed.rows;

    const asOf = new Date(`${body.asOf}T00:00:00.000Z`);

    try {
      if (!body.commit) {
        const plan = planGlImport(submitted, await currentBalances(orgId, asOf));
        return success({
          posted: false,
          preview: true,
          asOf: body.asOf,
          skipped: parsed.skipped,
          plan: serializePlan(plan),
        });
      }

      const result = await importTrialBalance({
        orgId,
        asOf,
        submitted,
        createdById: ctx.userId,
        memo: body.memo,
      });

      return success({
        posted: result.posted,
        ...(result.posted ? { entryId: result.entryId, entryNumber: result.entryNumber } : { reason: result.reason }),
        asOf: body.asOf,
        skipped: parsed.skipped,
        plan: serializePlan(result.plan),
      });
    } catch (err) {
      if (err instanceof ClosedPeriodError) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      // A bad file is the caller's to fix, and the message says which row.
      if (err instanceof GlImportError) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      throw err;
    }
  } catch (error) {
    return handleApiError(error);
  }
}

/** Decimals cross the wire as strings — JSON numbers would round the money. */
function serializePlan(plan: {
  lines: { code: string; name: string; current: Prisma.Decimal; target: Prisma.Decimal; delta: Prisma.Decimal }[];
  residual: Prisma.Decimal;
  submittedImbalance: Prisma.Decimal;
  unchanged: boolean;
}) {
  return {
    unchanged: plan.unchanged,
    residual: plan.residual.toString(),
    submittedImbalance: plan.submittedImbalance.toString(),
    lines: plan.lines.map((l) => ({
      code: l.code,
      name: l.name,
      current: l.current.toString(),
      target: l.target.toString(),
      delta: l.delta.toString(),
    })),
  };
}
