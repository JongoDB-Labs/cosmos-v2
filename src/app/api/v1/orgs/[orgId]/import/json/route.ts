import { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";
import { assertRefsInScope } from "@/lib/rbac/foreign-refs";

/** Set by the database or by this route, never taken from a row. */
const SERVER_SET = new Set(["id", "orgId", "createdAt", "updatedAt", "searchVector"]);

/**
 * A row reduced to the model's own columns (`fields` is Prisma's list of
 * them). Anything else in the row is dropped, and that is the point: Prisma's
 * create input also takes RELATION fields, so a row passed through whole could
 * carry `contracts: { connect: [...] }` and re-point another org's contracts
 * at the new partner, or `create` rows inside another org outright.
 */
function columnsOf(row: Record<string, unknown>, fields: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    if (!SERVER_SET.has(key) && key in row) out[key] = row[key];
  }
  return out;
}

const schema = z.object({
  notes: z.array(z.record(z.string(), z.unknown())).optional(),
  partners: z.array(z.record(z.string(), z.unknown())).optional(),
  products: z.array(z.record(z.string(), z.unknown())).optional(),
  expenses: z.array(z.record(z.string(), z.unknown())).optional(),
  revenues: z.array(z.record(z.string(), z.unknown())).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_IMPORT);

    const body = schema.parse(await request.json());
    const counts = { notes: 0, partners: 0, products: 0, expenses: 0, revenues: 0 };

    // For each entity, keep its own columns (columnsOf) and let Prisma assign
    // a fresh id. Skip silently on any per-row failure (don't abort whole import).
    if (body.notes) for (const n of body.notes) {
      try {
        await prisma.note.create({ data: { ...columnsOf(n, Prisma.NoteScalarFieldEnum), orgId: ctx.orgId } as never });
        counts.notes++;
      } catch { /* skip */ }
    }
    if (body.partners) for (const p of body.partners) {
      try {
        await prisma.partner.create({ data: { ...columnsOf(p, Prisma.PartnerScalarFieldEnum), orgId: ctx.orgId } as never });
        counts.partners++;
      } catch { /* skip */ }
    }
    if (body.products) for (const p of body.products) {
      try {
        await prisma.product.create({ data: { ...columnsOf(p, Prisma.ProductScalarFieldEnum), orgId: ctx.orgId } as never });
        counts.products++;
      } catch { /* skip */ }
    }
    if (body.expenses) for (const e of body.expenses) {
      try {
        const row = columnsOf(e, Prisma.ExpenseScalarFieldEnum);
        const projectId = row.projectId == null ? null : String(row.projectId);
        // A row filed under a project must name one of this org's that the
        // importer can see, and its CLIN and invoice must be this org's (the
        // CLIN its project's); otherwise it is skipped like any other bad row.
        if (projectId) await requireProjectVisible(ctx, projectId);
        await assertRefsInScope(
          { orgId: ctx.orgId, projectId, viewer: ctx },
          { clin: row.clinId as string | null | undefined, invoice: row.invoiceId as string | null | undefined },
        );
        await prisma.expense.create({ data: { ...row, orgId: ctx.orgId } as never });
        counts.expenses++;
      } catch { /* skip */ }
    }
    if (body.revenues) for (const r of body.revenues) {
      try {
        await prisma.revenue.create({ data: { ...columnsOf(r, Prisma.RevenueScalarFieldEnum), orgId: ctx.orgId } as never });
        counts.revenues++;
      } catch { /* skip */ }
    }

    return success({ imported: counts });
  } catch (e) {
    return handleApiError(e);
  }
}
