import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext, getCurrentUser } from "@/lib/auth/session";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { API_KEY_SCOPES, mintApiKey } from "@/lib/auth/api-key";
import {
  API_KEY_LIMITS,
  SCOPE_PURPOSE,
  effectiveExpiry,
  expiryRefusal,
  refusedScopes,
} from "@/lib/auth/api-key-policy";
import {
  KEY_MANAGEMENT_REFUSAL,
  keyManagementAccess,
  listApiKeysFor,
  mintStanding,
} from "@/lib/auth/api-key-manage.server";
import { refuseApiKey } from "@/lib/auth/key-gate";
import { getVisibleProjectIds } from "@/lib/rbac/project-access";
import { ProblemError } from "@/lib/openapi/problem";
import { Uuid } from "@/lib/openapi/schemas/common";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string }> };

const createSchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
  /** Projects the key may touch. Omitted or empty = org-wide. Capped so a
   *  caller cannot post an unbounded array. */
  projectIds: z.array(z.string().uuid()).max(200).optional(),
  expiresAt: z.string().datetime().nullish(),
});

/** Resolve the org and the caller, then hold them to the key-management gate. */
async function caller(orgId: string) {
  if (!Uuid.safeParse(orgId).success) throw new ProblemError(400, "invalid_request", "orgId must be a UUID");
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
  if (!org) throw new ProblemError(404, "not_found", "Organization not found");
  const ctx = await getAuthContext(org.slug);
  if (!ctx) throw new ProblemError(401, "unauthorized");
  // A key, before anything is read (bitless-routes.table.ts).
  refuseApiKey(ctx, KEY_MANAGEMENT_REFUSAL);
  return { ctx, ...keyManagementAccess(ctx) };
}

/**
 * The keys this person may see. Everyone who may use keys sees their own; an
 * administrator of keys (API_KEY_MANAGE) sees every key in the org, with who
 * made it.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { ctx, managesAll } = await caller(orgId);
    return success(await listApiKeysFor(ctx, managesAll));
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * Mint a key for the caller. The key acts as its creator, with at most the
 * scopes named here (apiKeyAuthContext), so every check below is about what
 * the CREATOR may do: a key can never be a way to do more.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { ctx } = await caller(orgId);

    // Judged as the verifier will judge the key once made (keyInactiveReason),
    // from the caller's permissions as a key sees them, so a key minted here is
    // never one the verifier then refuses. The session's IdP is recorded on
    // the key: where the org requires single sign-on, that is what lets a
    // member's key work.
    const session = await getCurrentUser();
    const standing = await mintStanding(ctx, session?.idpConnId ?? null);
    if (standing.refusal) throw new ProblemError(403, "forbidden", standing.refusal);

    const body = createSchema.parse(await request.json());
    const scopes = [...new Set(body.scopes)];

    const refused = refusedScopes(standing.permissions, scopes);
    if (refused.length > 0) {
      throw new ProblemError(
        400,
        "invalid_request",
        `Your role can't use ${refused.length === 1 ? "this scope" : "these scopes"}: ` +
          refused.map((s) => `${s} (${SCOPE_PURPOSE[s]})`).join(", ") +
          ". Remove " + (refused.length === 1 ? "it" : "them") + " and try again.",
      );
    }

    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    const expiryProblem = expiryRefusal(expiresAt, standing.managesAll, new Date());
    if (expiryProblem) throw new ProblemError(400, "invalid_request", expiryProblem);

    // Each named project must be one the caller can see. Unknown, other-org
    // and hidden ids all get the same answer, so the refusal can't be used to
    // learn which hidden projects exist.
    const projectIds = [...new Set(body.projectIds ?? [])];
    if (projectIds.length > 0) {
      const visible = await getVisibleProjectIds(ctx, projectIds);
      if (projectIds.some((id) => !visible.has(id))) {
        throw new ProblemError(400, "invalid_request", "You can only limit a key to projects you can see.");
      }
    }

    // The cap is counted and the key written under a lock on the creator's
    // membership row, so two requests at once can't both pass the count.
    // Requests from one person queue on that lock; the waits are raised from
    // Prisma's 2s/5s so a burst (a script minting 25 at once) gets its 201s
    // and 409s rather than a 500 for a transaction that couldn't start in time.
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM org_members WHERE org_id = ${orgId}::uuid AND user_id = ${ctx.userId}::uuid FOR UPDATE`;
      const now = new Date();
      // Counted by when each key really stops (effectiveExpiry), so a former
      // admin's never-expiring keys stop counting once they pass the 366-day
      // limit, as they stop working.
      const unexpired = await tx.apiKey.findMany({
        where: { orgId, createdById: ctx.userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { createdAt: true, expiresAt: true },
      });
      const active = unexpired.filter((k) => {
        const end = effectiveExpiry(standing.permissions, k.createdAt, k.expiresAt);
        return end === null || end.getTime() > now.getTime();
      }).length;
      if (active >= API_KEY_LIMITS.maxActivePerCreator) {
        throw new ProblemError(
          409,
          "conflict",
          `You already have ${API_KEY_LIMITS.maxActivePerCreator} API keys that still work. Revoke one you no longer use, then try again.`,
        );
      }
      return mintApiKey(
        { orgId, name: body.name, scopes, projectIds, createdById: ctx.userId, expiresAt, idpConnId: standing.idpConnId },
        tx,
      );
    }, { maxWait: 10_000, timeout: 10_000 });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "api_key.created",
      entity: "api_key",
      entityId: result.record.id,
      // Never the token: only what identifies the key and what it may do.
      metadata: {
        name: result.record.name,
        prefix: result.record.prefix,
        scopes: result.record.scopes,
        projectIds: result.record.projectIds,
        expiresAt: result.record.expiresAt?.toISOString() ?? null,
      },
      ipAddress: getIpAddress(request),
    });

    // The plaintext `token` is returned exactly once — here — and never again.
    return created({ ...result.record, token: result.token });
  } catch (e) {
    return handleApiError(e);
  }
}
