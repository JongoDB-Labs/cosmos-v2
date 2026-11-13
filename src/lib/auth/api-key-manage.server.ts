import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { logAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/rbac/check";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import { ProblemError } from "@/lib/openapi/problem";
import {
  MINT_REFUSAL_TEXT,
  effectiveExpiry,
  keyInactiveReason,
  managesAllApiKeys,
  mayManageOwnApiKeys,
  type KeyInactiveReason,
  type KeyPolicy,
} from "./api-key-policy";
import { loadKeyPolicy } from "./api-key";
import { refuseApiKey } from "./key-gate";
import { requiredIdpConnectionId } from "./sso-enforcement";

/** What a key that tries to create, list or revoke keys is told. */
export const KEY_MANAGEMENT_REFUSAL = "An API key can't create, list or revoke API keys. Sign in to manage keys.";

/**
 * The gate every key-management route (mint, list, revoke) runs first.
 *
 * A key is refused outright, whatever its scopes: a leaked key must never be
 * able to mint itself a successor or revoke the others. No scope mask carries
 * an API_KEY_* bit, so the permission check below would refuse it too; this
 * says so on purpose rather than by arithmetic.
 *
 * Then the person needs API_KEY_CREATE (their own keys) or API_KEY_MANAGE
 * (every key in the org), judged on their session's permissions: listing and
 * revoking are things a person does in a browser. Whether they may MINT, and
 * what, is judged as the verifier will judge the key: `mintStanding`.
 */
export function keyManagementAccess(ctx: AuthContext): { managesAll: boolean } {
  refuseApiKey(ctx, KEY_MANAGEMENT_REFUSAL);
  if (!mayManageOwnApiKeys(ctx.permissions)) {
    throw new ProblemError(403, "forbidden", "Your role can't use API keys.");
  }
  return { managesAll: managesAllApiKeys(ctx.permissions) };
}

/** What the caller may mint, judged as the verifier will judge the key. */
export interface MintStanding {
  /** The caller's own permissions as a key sees them (forApiKey: no break-glass). */
  permissions: bigint;
  /** May make a key that never expires, or lasts past 366 days. */
  managesAll: boolean;
  /** Why they may not mint at all, or null. */
  refusal: string | null;
  policy: KeyPolicy;
  /** What the new key records as its IdP: the caller's session's, if single sign-on. */
  idpConnId: string | null;
}

/**
 * Whether, and what, the caller may mint, from the same rule the verifier
 * applies to the key once it exists (`keyInactiveReason`), asked of a key made
 * now from this session. So a key is never minted that the verifier would then
 * refuse: an owner whose API_KEY_MANAGE an org restriction removes is treated
 * as someone who can't manage keys here too (a 366-day limit), and a session
 * that didn't come through the org's required single sign-on can't make a
 * member's key. The page asks the same question, so it offers what this allows.
 */
export async function mintStanding(
  ctx: Pick<AuthContext, "orgId" | "userId">,
  /** The caller's session's IdP connection (Session.idpConnId), if single sign-on. */
  sessionIdpConnId: string | null,
): Promise<MintStanding> {
  const eff = await loadEffectivePermissions(ctx.orgId, ctx.userId, { forApiKey: true });
  const permissions = eff?.permissions ?? 0n;
  const managesAll = managesAllApiKeys(permissions);
  const policy = await loadKeyPolicy(ctx.orgId);
  const now = new Date();
  const reason = keyInactiveReason(
    {
      creatorPermissions: eff ? permissions : null,
      policy,
      requiredIdpConnId: managesAll ? null : await requiredIdpConnectionId(ctx.orgId),
    },
    { createdAt: now, idpConnId: sessionIdpConnId },
    now,
  );
  return { permissions, managesAll, refusal: reason ? MINT_REFUSAL_TEXT[reason] : null, policy, idpConnId: sessionIdpConnId };
}

/** A key as the API keys page shows it. */
export type ApiKeyListRow = Awaited<ReturnType<typeof listApiKeysFor>>[number];

/**
 * The keys this person may see: every key in the org for an administrator of
 * keys, otherwise only their own. The route and the page's prefetch both call
 * this, so the two can't drift apart.
 *
 * NEVER selects `keyHash`. The creator is named by id and display name only,
 * never by email address.
 */
export async function listApiKeysFor(ctx: Pick<AuthContext, "orgId" | "userId">, managesAll: boolean) {
  const rows = await prisma.apiKey.findMany({
    where: { orgId: ctx.orgId, ...(managesAll ? {} : { createdById: ctx.userId }) },
    select: {
      id: true,
      name: true,
      prefix: true,
      scopes: true,
      projectIds: true,
      expiresAt: true,
      lastUsed: true,
      createdAt: true,
      idpConnId: true,
      createdBy: { select: { id: true, displayName: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  // Each creator's permissions as their keys see them (no break-glass, as in
  // apiKeyAuthContext), once per creator: what decides whether, and until
  // when, a key works. Null: no longer a member.
  const creatorIds = [...new Set(rows.flatMap((r) => (r.createdBy ? [r.createdBy.id] : [])))];
  const creatorPerms = new Map<string, bigint | null>(
    await Promise.all(
      creatorIds.map(async (id) => [id, (await loadEffectivePermissions(ctx.orgId, id, { forApiKey: true }))?.permissions ?? null] as const),
    ),
  );
  const policy = rows.length > 0 ? await loadKeyPolicy(ctx.orgId) : { memberApiKeysEnabled: true };
  const needsIdp = [...creatorPerms.values()].some((p) => p !== null && !managesAllApiKeys(p));
  const requiredIdpConnId = needsIdp ? await requiredIdpConnectionId(ctx.orgId) : null;
  const now = new Date();
  return rows.map(({ createdBy, idpConnId, ...row }) => {
    const perms = createdBy ? (creatorPerms.get(createdBy.id) ?? null) : null;
    // The verifier's own rule (keyInactiveReason), so the list says a key
    // works exactly when it does.
    const inactiveReason: KeyInactiveReason | null = keyInactiveReason(
      { creatorPermissions: perms, policy, requiredIdpConnId },
      { createdAt: row.createdAt, expiresAt: row.expiresAt, idpConnId },
      now,
    );
    return {
      ...row,
      // When the key really stops: its own expiry, or 366 days after it was
      // made once its creator can't manage keys (keyLapsedFor). The stored
      // `expiresAt` stays as it was set.
      effectiveExpiresAt: perms === null ? row.expiresAt : effectiveExpiry(perms, row.createdAt, row.expiresAt),
      inactiveReason,
      // Null when the creator's account was deleted (the key then authenticates
      // nobody: verifyApiKeyHeader refuses a key without a creator).
      createdBy: createdBy ? { id: createdBy.id, name: createdBy.displayName } : null,
    };
  });
}

/**
 * Delete the keys `where` names, inside `tx`, and return their prefixes for
 * the audit entry the caller writes in the same transaction. Prefixes identify
 * a key; the token itself is never stored, only its hash.
 */
export async function deleteApiKeysIn(
  tx: Pick<Prisma.TransactionClient, "apiKey">,
  where: Prisma.ApiKeyWhereInput,
): Promise<string[]> {
  const keys = await tx.apiKey.findMany({ where, select: { id: true, prefix: true } });
  if (keys.length > 0) await tx.apiKey.deleteMany({ where: { id: { in: keys.map((k) => k.id) } } });
  return keys.map((k) => k.prefix);
}

/**
 * Delete every key `userId` made in `orgId`, inside `tx`, and record it as
 * "member.api_keys_revoked" on their membership. Removing a member calls this,
 * and so does every path that reinstates one (re-adding them, or an SSO
 * sign-in the identity provider still vouches for). Reinstating clears
 * `removedAt` on the same row, so a key that survived the removal (one made by
 * someone removed before removal deleted keys) would otherwise work again.
 * Returns how many went.
 */
export async function deleteMemberKeysIn(
  tx: Pick<Prisma.TransactionClient, "apiKey" | "auditLog">,
  p: {
    orgId: string;
    userId: string;
    memberId: string;
    /** Who did it: the admin, or the person themselves on an SSO sign-in. */
    actorUserId: string;
    reason: "removed" | "reinstated";
    ipAddress?: string;
  },
): Promise<number> {
  const prefixes = await deleteApiKeysIn(tx, { orgId: p.orgId, createdById: p.userId });
  if (prefixes.length > 0) {
    await logAudit({
      orgId: p.orgId,
      userId: p.actorUserId,
      action: "member.api_keys_revoked",
      entity: "org_member",
      entityId: p.memberId,
      metadata: { targetUserId: p.userId, reason: p.reason, revokedCount: prefixes.length, prefixes },
      ipAddress: p.ipAddress,
    }, tx);
  }
  return prefixes.length;
}

/**
 * The people in `orgId` who hold keys there but can't manage keys
 * (API_KEY_MANAGE), judged as their keys are (forApiKey: an owner whose
 * API_KEY_MANAGE an org restriction removes counts), work roles included.
 * Someone who is no longer a member counts: their keys work for nobody, and
 * nothing should bring them back.
 */
export async function keyHoldersWithoutManage(orgId: string): Promise<string[]> {
  const creators = await prisma.apiKey.findMany({
    where: { orgId, createdById: { not: null } },
    select: { createdById: true },
    distinct: ["createdById"],
  });
  const out: string[] = [];
  for (const { createdById } of creators) {
    const eff = await loadEffectivePermissions(orgId, createdById!, { forApiKey: true });
    if (!eff || !managesAllApiKeys(eff.permissions)) out.push(createdById!);
  }
  return out;
}
