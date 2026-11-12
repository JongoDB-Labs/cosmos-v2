import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { readableContractsWhere } from "@/lib/crm/contract-scope";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { moneyGate, projectMoney, projectMoneyEach } from "@/lib/rbac/money-fields";
import { z } from "zod";
import { assertRefsInScope, withoutForeign } from "@/lib/rbac/foreign-refs";

const createContractSchema = z.object({
  title: z.string().min(1).max(500),
  partnerId: z.string().uuid().nullish(),
  productId: z.string().uuid().nullish(),
  value: z.number().optional(),
  currency: z.string().max(10).nullish(),
  status: z.string().nullish(),
  startDate: z.string().datetime().nullish(),
  endDate: z.string().datetime().nullish(),
  terms: z.string().nullish(),
  notes: z.string().nullish(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_READ);

    const status = request.nextUrl.searchParams.get("status");
    const partnerId = request.nextUrl.searchParams.get("partnerId");
    const productId = request.nextUrl.searchParams.get("productId");

    // CRM_READ is held by MEMBER and VIEWER, so it authorises reading SOME
    // contracts and says nothing about WHICH. `Contract.projectId` is real (and
    // nullable, with an index), so an org-only filter listed contracts on
    // projects with `teamScopedAccess` that the caller cannot open — along with
    // their terms and values. The rule lives in one place because partner and
    // product detail list the same rows (lib/crm/contract-scope.ts).
    const contracts = await prisma.contract.findMany({
      where: {
        ...(await readableContractsWhere(ctx)),
        ...(status ? { status } : {}),
        ...(partnerId ? { partnerId } : {}),
        ...(productId ? { productId } : {}),
      },
      include: {
        partner: true,
        product: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // A partner or product from another org, linked before writes were
    // checked, reads as none. A contract's value, funded and invoiced figures
    // are finance data, as on the vendor register: each one needs finance
    // access to ITS project (an org-level contract, the org-wide grant).
    // Without it the contract still arrives, with those fields left out.
    return success(
      projectMoneyEach(
        "vendor",
        contracts.map((c) => withoutForeign(c, orgId, ["partner", "product"])),
        await moneyGate(ctx),
      ),
    );
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_CREATE);

    const body = await request.json();
    const data = createContractSchema.parse(body);
    // The foreign keys are single-column: without this a contract could link
    // another org's partner or product and the response would carry it back.
    await assertRefsInScope({ orgId }, { partner: data.partnerId, product: data.productId });

    const contract = await prisma.contract.create({
      data: {
        orgId,
        title: data.title,
        partnerId: data.partnerId ?? null,
        productId: data.productId ?? null,
        value: data.value ?? null,
        currency: data.currency ?? "USD",
        status: data.status ?? "draft",
        startDate: data.startDate ? new Date(data.startDate) : null,
        endDate: data.endDate ? new Date(data.endDate) : null,
        terms: data.terms ?? null,
        notes: data.notes ?? null,
      },
      include: {
        partner: true,
        product: true,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "contract.created",
      entity: "contract",
      entityId: contract.id,
      metadata: { title: data.title } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // The creator typed the value, but the answer follows the read rule: the
    // list they are about to reload will say "Restricted" too.
    return created(projectMoney("vendor", contract, (await moneyGate(ctx))(contract.projectId)));
  } catch (error) {
    return handleApiError(error);
  }
}
