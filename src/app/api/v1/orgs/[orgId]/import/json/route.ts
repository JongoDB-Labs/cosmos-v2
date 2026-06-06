import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

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

    // For each entity, strip id/orgId/createdAt and let Prisma assign fresh ones.
    // Skip silently on any per-row failure (don't abort whole import).
    if (body.notes) for (const n of body.notes) {
      try {
        const { id: _id, orgId: _o, createdAt: _c, updatedAt: _u, ...rest } = n as Record<string, unknown>;
        void _id; void _o; void _c; void _u;
        await prisma.note.create({ data: { ...rest, orgId: ctx.orgId } as never });
        counts.notes++;
      } catch { /* skip */ }
    }
    if (body.partners) for (const p of body.partners) {
      try {
        const { id: _id, orgId: _o, createdAt: _c, updatedAt: _u, ...rest } = p as Record<string, unknown>;
        void _id; void _o; void _c; void _u;
        await prisma.partner.create({ data: { ...rest, orgId: ctx.orgId } as never });
        counts.partners++;
      } catch { /* skip */ }
    }
    if (body.products) for (const p of body.products) {
      try {
        const { id: _id, orgId: _o, createdAt: _c, updatedAt: _u, ...rest } = p as Record<string, unknown>;
        void _id; void _o; void _c; void _u;
        await prisma.product.create({ data: { ...rest, orgId: ctx.orgId } as never });
        counts.products++;
      } catch { /* skip */ }
    }
    if (body.expenses) for (const e of body.expenses) {
      try {
        const { id: _id, orgId: _o, createdAt: _c, updatedAt: _u, ...rest } = e as Record<string, unknown>;
        void _id; void _o; void _c; void _u;
        await prisma.expense.create({ data: { ...rest, orgId: ctx.orgId } as never });
        counts.expenses++;
      } catch { /* skip */ }
    }
    if (body.revenues) for (const r of body.revenues) {
      try {
        const { id: _id, orgId: _o, createdAt: _c, updatedAt: _u, ...rest } = r as Record<string, unknown>;
        void _id; void _o; void _c; void _u;
        await prisma.revenue.create({ data: { ...rest, orgId: ctx.orgId } as never });
        counts.revenues++;
      } catch { /* skip */ }
    }

    return success({ imported: counts });
  } catch (e) {
    return handleApiError(e);
  }
}
