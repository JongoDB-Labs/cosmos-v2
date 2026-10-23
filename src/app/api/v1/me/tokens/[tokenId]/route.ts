import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { ProblemError } from "@/lib/openapi/problem";
import { revokeMyToken } from "./route.contract";
import { sessionUser } from "../session-only";

type RouteParams = { params: Promise<{ tokenId: string }> };

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: { tokenId } } = await parseRequest(revokeMyToken, request, params);
    const user = await sessionUser();
    // Your own personal tokens only. An org key, or someone else's token, is
    // not yours to revoke here (admins do that in Settings → API keys).
    const key = await prisma.apiKey.findFirst({
      where: { id: tokenId, createdById: user.id, kind: "PERSONAL" },
      select: { id: true, orgId: true, name: true },
    });
    if (!key) throw new ProblemError(404, "not_found", "Token not found");
    await prisma.apiKey.delete({ where: { id: key.id } });
    await logAudit({
      orgId: key.orgId,
      userId: user.id,
      action: "pat.revoked",
      entity: "api_key",
      entityId: key.id,
      metadata: { name: key.name },
      ipAddress: getIpAddress(request),
    });
    return respond(revokeMyToken, 204, undefined);
  } catch (e) {
    return handleApiError(e, request);
  }
}
