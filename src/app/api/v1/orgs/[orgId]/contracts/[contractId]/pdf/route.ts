import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { generateContractPdf } from "@/lib/pdf/contract";

type RouteParams = { params: Promise<{ orgId: string; contractId: string }> };

// cacheComponents enabled: `runtime` segment config not supported (Node is default).

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, contractId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_READ);

    const contract = await prisma.contract.findFirst({
      where: { id: contractId, orgId: ctx.orgId },
      include: { partner: true },
    });
    if (!contract) return new Response("Contract not found", { status: 404 });

    const pdfBuffer = await generateContractPdf({
      title: contract.title ?? "Contract",
      partyName: contract.partner?.name ?? "Unknown party",
      partyEmail: contract.partner?.contactEmail ?? null,
      value: typeof contract.value === "number" ? contract.value : null,
      startDate: contract.startDate ?? null,
      endDate: contract.endDate ?? null,
      body: contract.terms ?? null,
      signedAt: contract.signedAt ?? null,
    });

    const body = new Uint8Array(pdfBuffer);
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="contract-${contract.id.slice(0, 8)}.pdf"`,
        "Content-Length": String(body.byteLength),
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
