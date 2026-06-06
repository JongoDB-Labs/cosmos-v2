import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { createEnvelope } from "@/lib/integrations/docusign";

const schema = z.object({
  signerEmail: z.string().email(),
  signerName: z.string().min(1),
  documentBase64: z.string().min(1),
  documentName: z.string().min(1).default("contract.pdf"),
});

type RouteParams = { params: Promise<{ orgId: string; contractId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, contractId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_UPDATE);

    const contract = await prisma.contract.findFirst({
      where: { id: contractId, orgId: ctx.orgId },
    });
    if (!contract) return new Response("Contract not found", { status: 404 });

    const body = schema.parse(await request.json());
    let envelopeId: string;
    try {
      envelopeId = await createEnvelope({
        contractId,
        signerEmail: body.signerEmail,
        signerName: body.signerName,
        documentBase64: body.documentBase64,
        documentName: body.documentName,
      });
    } catch (e) {
      if (e instanceof Error && e.message.includes("DocuSign env vars not configured")) {
        return new Response("DocuSign not configured", { status: 503 });
      }
      throw e;
    }

    const updated = await prisma.contract.update({
      where: { id: contractId },
      data: { docusignEnvelopeId: envelopeId, docusignStatus: "sent" },
    });

    return success({ envelopeId, contract: updated });
  } catch (e) {
    return handleApiError(e);
  }
}
