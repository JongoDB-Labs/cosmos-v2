import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { mintApiKey, projectCeiling } from "@/lib/auth/api-key";
import { visibleProjectIdsForActor } from "@/lib/rbac/project-access";
import { handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { ProblemError } from "@/lib/openapi/problem";
import { createMyToken, listMyTokens } from "./route.contract";
import { sessionUser } from "./session-only";

const DAY = 86_400;
/** Lifetime cap, in days. Org-configurable once API-access settings land. */
const MAX_DAYS = { COMMERCIAL: 90, GOV: 30 } as const;
const DEFAULT_DAYS = 30;

const TOKEN_SELECT = {
  id: true, orgId: true, name: true, prefix: true, scopes: true, projectIds: true,
  expiresAt: true, lastUsed: true, createdAt: true,
} as const;

export async function GET(request: NextRequest) {
  try {
    const { query } = await parseRequest(listMyTokens, request);
    const user = await sessionUser();
    const tokens = await prisma.apiKey.findMany({
      where: { createdById: user.id, kind: "PERSONAL", ...(query.orgId && { orgId: query.orgId }) },
      select: TOKEN_SELECT,
      orderBy: { createdAt: "desc" },
    });
    return respond(listMyTokens, 200, tokens);
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { body } = await parseRequest(createMyToken, request);
    const user = await sessionUser();

    const org = await prisma.organization.findUnique({
      where: { id: body.orgId },
      select: { id: true, slug: true, tenantClass: true },
    });
    // Through getAuthContext, so the org's floors (MFA, IP allowlist, SSO)
    // apply to minting exactly as to everything else. Not a member reads the
    // same as no such org.
    const ctx = org && (await getAuthContext(org.slug));
    if (!org || !ctx || ctx.userId !== user.id) {
      throw new ProblemError(404, "not_found", "Organization not found");
    }

    const maxDays = MAX_DAYS[org.tenantClass];
    const lifetime = body.expiresIn ?? DEFAULT_DAYS * DAY;
    if (lifetime > maxDays * DAY) {
      throw new ProblemError(400, "invalid_request", `A personal token can live at most ${maxDays} days in this organization`);
    }

    // A project the member can't see answers as one that doesn't exist, so the
    // reply never confirms it. Naming only such projects is still the 400: an
    // empty ceiling would mean org-wide.
    const named = body.projectIds?.length
      ? [...(await visibleProjectIdsForActor(org.id, user.id, body.projectIds))]
      : undefined;
    const projectIds = named?.length === 0 ? null : await projectCeiling(org.id, named);
    if (projectIds === null) throw new ProblemError(400, "invalid_request", "None of those projects exist in this org");

    const { token, record } = await mintApiKey({
      orgId: org.id,
      name: body.name,
      scopes: body.scopes,
      projectIds,
      createdById: user.id,
      expiresAt: new Date(Date.now() + lifetime * 1000),
      kind: "PERSONAL",
    });

    await logAudit({
      orgId: org.id,
      userId: user.id,
      action: "pat.created",
      entity: "api_key",
      entityId: record.id,
      metadata: { name: body.name, scopes: body.scopes.join(" "), expiresAt: record.expiresAt!.toISOString() },
      ipAddress: getIpAddress(request),
    });

    // `kind` is always PERSONAL here; the token record doesn't repeat it.
    const { kind, ...summary } = record;
    void kind;
    return respond(createMyToken, 201, {
      token,
      record: { ...summary, orgId: org.id, lastUsed: null },
    });
  } catch (e) {
    return handleApiError(e, request);
  }
}
