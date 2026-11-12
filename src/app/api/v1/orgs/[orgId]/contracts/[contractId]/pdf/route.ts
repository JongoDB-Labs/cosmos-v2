import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { mayReadContract } from "@/lib/crm/contract-scope";
import { generateContractPdf } from "@/lib/pdf/contract";
import { loadPdfLogo } from "@/lib/pdf/org-logo";
import { pickOrgBrand } from "@/lib/brand/resolve";
import { moneyGate } from "@/lib/rbac/money-fields";

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
    // The same answer GET /contracts/:id gives: a contract on a project the
    // caller cannot open is not found, and its PDF is the contract in full.
    if (!contract || !(await mayReadContract(ctx, contract.projectId)))
      return new Response("Contract not found", { status: 404 });
    // Never print another org's partner onto this org's contract.
    const partner = contract.partner?.orgId === contract.orgId ? contract.partner : null;
    // The value is finance data, as everywhere else it leaves the server.
    const seesMoney = (await moneyGate(ctx))(contract.projectId);

    const pdfBuffer = await generateContractPdf({
      title: contract.title ?? "Contract",
      partyName: partner?.name ?? "Unknown party",
      partyEmail: partner?.contactEmail ?? null,
      // A Decimal, never a number: the old typeof check printed "—" for everyone.
      value: seesMoney && contract.value != null ? Number(contract.value) : null,
      valueWithheld: !seesMoney,
      startDate: contract.startDate ?? null,
      endDate: contract.endDate ?? null,
      body: contract.terms ?? null,
      signedAt: contract.signedAt ?? null,
      brand: pickOrgBrand(org),
      // An uploaded logo lives in object storage, and pickOrgBrand only carries
      // the URL that points at it — so the bytes are resolved here.
      logo: await loadPdfLogo(org),
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
