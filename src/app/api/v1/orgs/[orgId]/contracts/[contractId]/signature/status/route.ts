import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { getEnvelopeStatus } from "@/lib/integrations/docusign";

type RouteParams = { params: Promise<{ orgId: string; contractId: string }> };

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
      select: { id: true, docusignEnvelopeId: true, docusignStatus: true, signedAt: true },
    });
    if (!contract) return new Response("Contract not found", { status: 404 });
    if (!contract.docusignEnvelopeId) {
      return success({ status: null, signedAt: null });
    }

    let liveStatus: string;
    try {
      liveStatus = await getEnvelopeStatus(contract.docusignEnvelopeId);
    } catch (e) {
      if (e instanceof Error && e.message.includes("DocuSign env vars not configured")) {
        return success({ status: contract.docusignStatus, signedAt: contract.signedAt, stale: true });
      }
      throw e;
    }

    const wasCompleted = contract.docusignStatus !== "completed" && liveStatus === "completed";
    const updated = await prisma.contract.update({
      where: { id: contractId },
      data: {
        docusignStatus: liveStatus,
        signedAt: wasCompleted ? new Date() : contract.signedAt,
      },
    });

    return success({ status: updated.docusignStatus, signedAt: updated.signedAt });
  } catch (e) {
    return handleApiError(e);
  }
}
