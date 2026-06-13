import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

export const API_KEY_SCOPES = ["read", "items:write", "documents:write"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

const SCOPE_MASK: Record<ApiKeyScope, bigint> = {
  read: Permission.PROJECT_READ | Permission.ITEM_READ | Permission.OKR_READ | Permission.SPRINT_READ,
  "items:write":
    Permission.PROJECT_READ | Permission.PROJECT_UPDATE | Permission.ITEM_READ |
    Permission.ITEM_CREATE | Permission.OKR_READ | Permission.OKR_CREATE |
    Permission.SPRINT_READ | Permission.SPRINT_CREATE,
  "documents:write":
    Permission.PROJECT_READ | Permission.PROJECT_UPDATE | Permission.ITEM_READ | Permission.ITEM_CREATE,
};

/** OR together the bit-masks for the given scope names; unknown scopes contribute
 *  nothing (0n) so an untrusted scope string can never widen the grant. */
export function scopeMask(scopes: string[]): bigint {
  return scopes.reduce((m, s) => m | (SCOPE_MASK[s as ApiKeyScope] ?? 0n), 0n);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Mint a new org-scoped API key. The plaintext `token` is returned ONCE (only its
 * sha256 hash is stored), and is bound to `createdById` — the originating user the
 * key acts as. Effective permissions at verify time = that user's permissions
 * intersected with the key's scope mask.
 */
export async function mintApiKey(input: {
  orgId: string; name: string; scopes: string[]; createdById: string; expiresAt?: Date | null;
}) {
  const prefix = randomBytes(6).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const token = `cosmos_${prefix}_${secret}`;
  const record = await prisma.apiKey.create({
    data: {
      orgId: input.orgId, name: input.name, prefix, keyHash: sha256(secret),
      scopes: input.scopes, createdById: input.createdById, expiresAt: input.expiresAt ?? null,
    },
    select: { id: true, name: true, prefix: true, scopes: true, expiresAt: true, createdAt: true },
  });
  return { token, record };
}

function parseToken(h: string | null): { prefix: string; secret: string } | null {
  if (!h) return null;
  const m = /^Bearer\s+cosmos_([A-Za-z0-9_-]+)_([A-Za-z0-9_-]+)$/.exec(h.trim());
  return m ? { prefix: m[1], secret: m[2] } : null;
}

/** Cheap check (no DB) for whether a request even carries a cosmos bearer token,
 *  used to decide between the API-key and session auth paths. */
export function hasBearer(req: Request): boolean {
  return /^Bearer\s+cosmos_/.test(req.headers.get("authorization") ?? "");
}

/**
 * Verify a bearer API key against `orgId`, returning the SAME AuthContext the
 * session path produces (so downstream routes are unchanged). Returns null for:
 * a malformed/absent token, an unknown prefix, a hash mismatch, an expired key,
 * a key whose minting user was removed (createdById null), or a user who no
 * longer has a membership in the org. The acting principal is `createdById`, and
 * the returned permissions are that user's effective permissions ∩ scope mask.
 */
export async function verifyApiKey(req: Request, orgId: string): Promise<AuthContext | null> {
  const parsed = parseToken(req.headers.get("authorization"));
  if (!parsed) return null;
  const key = await prisma.apiKey.findFirst({
    where: { orgId, prefix: parsed.prefix },
    select: { id: true, keyHash: true, scopes: true, expiresAt: true, createdById: true },
  });
  if (!key || !key.createdById) return null;
  const a = Buffer.from(sha256(parsed.secret)); const b = Buffer.from(key.keyHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return null;
  const eff = await loadEffectivePermissions(orgId, key.createdById);
  if (!eff) return null;
  void prisma.apiKey.update({ where: { id: key.id }, data: { lastUsed: new Date() } }).catch(() => {});
  const mask = scopeMask(key.scopes);
  return {
    userId: key.createdById, orgId, orgRole: eff.orgRole,
    permissions: eff.permissions & mask, basePermissions: eff.basePermissions & mask,
    abacRules: eff.abacRules,
  };
}

/**
 * Unified auth resolver for org-scoped routes: a cosmos bearer token takes the
 * API-key path; otherwise fall back to the cookie session. Both return the same
 * AuthContext shape (or null).
 */
export async function resolveAuth(
  req: Request, org: { id: string; slug: string },
): Promise<AuthContext | null> {
  if (hasBearer(req)) return verifyApiKey(req, org.id);
  const { getAuthContext } = await import("@/lib/auth/session");
  return getAuthContext(org.slug);
}
