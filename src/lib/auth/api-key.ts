import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { API_KEY_SCOPES, scopeMask, type ApiKeyScope } from "./api-key-scopes";
import { keyInactiveReason, managesAllApiKeys, type KeyPolicy } from "./api-key-policy";
import { classifyBearer, parseKeyToken } from "./bearer";
import { ipAllowlistAdmits } from "./ip-allowlist";
import { requiredIdpConnectionId } from "./sso-enforcement";

// Re-exported so existing server importers of `@/lib/auth/api-key` keep working.
// Client components MUST import these from `./api-key-scopes` directly — this
// module pulls in prisma/session and cannot be in the browser bundle.
export { API_KEY_SCOPES, scopeMask };
export type { ApiKeyScope };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Mint a new org-scoped API key. The plaintext `token` is returned ONCE (only its
 * sha256 hash is stored), and is bound to `createdById` — the originating user the
 * key acts as. Effective permissions at verify time = that user's permissions
 * intersected with the key's scope mask.
 */
export async function mintApiKey(
  input: {
    orgId: string; name: string; scopes: string[]; createdById: string;
    expiresAt?: Date | null;
    /** Projects the key may touch. Omit or pass [] for org-wide. */
    projectIds?: string[];
    /** The IdP connection the minting session signed in through, if single sign-on. */
    idpConnId?: string | null;
  },
  /** A transaction to write in (the mint route counts and writes under one lock). */
  db: Pick<Prisma.TransactionClient, "apiKey"> = prisma,
) {
  // Prefix is HEX (no `_`/`-`) so the token splits unambiguously at the prefix's
  // `_` delimiter — the secret (base64url) may contain `_`/`-`, and as the final
  // segment that's fine. (A base64url prefix made parsing ambiguous: a greedy
  // split mis-read any token whose secret held an underscore — ~3 in 4 of them.)
  const prefix = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const token = `cosmos_${prefix}_${secret}`;
  const record = await db.apiKey.create({
    data: {
      orgId: input.orgId, name: input.name, prefix, keyHash: sha256(secret),
      scopes: input.scopes, createdById: input.createdById, expiresAt: input.expiresAt ?? null,
      projectIds: input.projectIds ?? [], idpConnId: input.idpConnId ?? null,
    },
    select: {
      id: true, name: true, prefix: true, scopes: true, projectIds: true,
      expiresAt: true, createdAt: true,
    },
  });
  return { token, record };
}

/** Cheap check (no DB) for whether a request even carries a cosmos bearer token,
 *  used to decide between the bearer and session auth paths. Any `cosmos_`
 *  bearer counts, valid or not, so a malformed one is refused rather than
 *  quietly retried as the cookie riding on the same request. */
export function hasBearer(req: Request): boolean {
  return classifyBearer(req.headers.get("authorization")) !== null;
}

/**
 * Verify a bearer API key against `orgId`, returning the SAME AuthContext the
 * session path produces (so downstream routes are unchanged). Returns null for:
 * a malformed/absent token, an unknown prefix, a hash mismatch, an expired key,
 * a key whose minting user was removed (createdById null), a user who no
 * longer has a membership in the org, a key that no longer works for its
 * creator (`keyInactiveReason`: their role, the org's switch, the 366-day
 * limit, the org's single sign-on), or a request from outside the org's IP
 * allowlist. The
 * acting principal is `createdById`, and the returned permissions are that
 * user's effective permissions ∩ scope mask.
 */
export async function verifyApiKey(req: Request, orgId: string): Promise<AuthContext | null> {
  return verifyApiKeyHeader(req.headers.get("authorization"), orgId, req.headers);
}

/**
 * The org's key switch, read once. A missing settings row means the default,
 * on. A caller that already holds the settings row can pass the switch to
 * `apiKeyAuthContext` instead.
 */
export async function loadKeyPolicy(orgId: string): Promise<KeyPolicy> {
  const sec = await prisma.orgSecuritySettings.findUnique({
    where: { orgId },
    select: { memberApiKeysEnabled: true },
  });
  return { memberApiKeysEnabled: sec?.memberApiKeysEnabled ?? true };
}

/**
 * The org's key an `Authorization` header names, when its secret matches and it
 * hasn't expired; null otherwise. The one test of "is this a valid key", shared
 * by authentication and by audit attribution so the two can't disagree.
 */
async function matchedKey(authorization: string | null, orgId: string) {
  const parsed = parseKeyToken(authorization);
  if (!parsed) return null;
  const key = await prisma.apiKey.findUnique({
    where: { orgId_prefix: { orgId, prefix: parsed.prefix } },
    select: {
      id: true, keyHash: true, scopes: true, projectIds: true,
      expiresAt: true, createdById: true, createdAt: true, idpConnId: true,
    },
  });
  if (!key) return null;
  const a = Buffer.from(sha256(parsed.secret)); const b = Buffer.from(key.keyHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return null;
  return key;
}

/** The id of the valid key this header carries, or null (no key, wrong secret, expired). */
export async function verifiedApiKeyId(authorization: string | null, orgId: string): Promise<string | null> {
  return (await matchedKey(authorization, orgId))?.id ?? null;
}

/**
 * The same verification, from the `Authorization` header alone.
 *
 * `getAuthContext` is the single place every org-scoped route authenticates,
 * and it has no `Request` — it reads `cookies()`/`headers()` from the request
 * context. Taking the header directly lets the key path live THERE, rather than
 * asking ~300 route handlers to opt in one at a time. That opt-in is exactly
 * what never happened: this module shipped complete and, until now, had no
 * caller outside its own test.
 */
export async function verifyApiKeyHeader(
  authorization: string | null,
  orgId: string,
  /** The request's headers: where the org's IP allowlist reads the client's address. */
  requestHeaders: Headers,
  /** The org's key switch when the caller already read it; read here otherwise. */
  policy?: KeyPolicy,
): Promise<AuthContext | null> {
  const key = await matchedKey(authorization, orgId);
  if (!key || !key.createdById) return null;
  const ctx = await apiKeyAuthContext(orgId, {
    createdById: key.createdById, scopes: key.scopes, projectIds: key.projectIds, createdAt: key.createdAt,
    idpConnId: key.idpConnId,
  }, policy);
  if (!ctx) return null;
  // Here, not in each caller, so every way a key is verified (getAuthContext,
  // and resolveAuth through verifyApiKey) meets the same allowlist.
  if (!(await ipAllowlistAdmits(orgId, requestHeaders))) return null;
  void prisma.apiKey.update({ where: { id: key.id }, data: { lastUsed: new Date() } }).catch(() => {});
  return ctx;
}

/**
 * The AuthContext an AUTHENTICATED key acts with: its minting user's effective
 * permissions ∩ the key's scope mask, its project ceiling, and `isApiKey`.
 * `null` when the minting user is no longer a member of the org, or the key
 * no longer works for them (`keyInactiveReason`).
 *
 * Split out of `verifyApiKeyHeader` so the rule lives in exactly one place and
 * can be exercised directly. It does NOT authenticate anything — the caller
 * must already have matched the secret against `keyHash` and checked expiry,
 * which is what `verifyApiKeyHeader` does before it gets here. Every key path
 * (`getAuthContext`, and `resolveAuth` through `verifyApiKey`) arrives here.
 */
export async function apiKeyAuthContext(
  orgId: string,
  key: {
    createdById: string; scopes: string[]; projectIds: string[] | null; createdAt: Date;
    /** The IdP the minting session came through (ApiKey.idpConnId). Omitted: none. */
    idpConnId?: string | null;
  },
  /** The org's key switch when the caller already read it; read here otherwise. */
  policy?: KeyPolicy,
): Promise<AuthContext | null> {
  // forApiKey: a key gets no OWNER break-glass, so the org's restrictions bind
  // an owner's key like anyone else's.
  const eff = await loadEffectivePermissions(orgId, key.createdById, { forApiKey: true });
  if (!eff) return null;
  // Whether the key still works for its creator, asked of their OWN
  // permissions (as a key sees them: no break-glass), before the mask below,
  // which never carries an API_KEY_* bit. Without API_KEY_MANAGE that means
  // API_KEY_CREATE and the org's switch now (so turning member keys off, or a
  // demotion to GUEST, switches existing keys off too), at most 366 days since
  // it was made, and, where the org requires single sign-on, a key made from a
  // session of that org's IdP: a key has no sign-in of its own, so the one it
  // was made from is what the requirement is held to. Keys of someone who
  // manages keys are not held to it, as no key was before: that person sees
  // and can revoke every key in the org.
  const refusal = keyInactiveReason({
    creatorPermissions: eff.permissions,
    policy: policy ?? (await loadKeyPolicy(orgId)),
    requiredIdpConnId: managesAllApiKeys(eff.permissions) ? null : await requiredIdpConnectionId(orgId),
  }, key, new Date());
  if (refusal) return null;
  const mask = scopeMask(key.scopes);
  return {
    userId: key.createdById, orgId, orgRole: eff.orgRole,
    permissions: eff.permissions & mask, basePermissions: eff.basePermissions & mask,
    // The creator's own bits, unmasked (as a key sees them: no break-glass):
    // what their session would be gated on. Only `keyMay` reads it, where a
    // route asks a key for a stand-in bit.
    ownerPermissions: eff.permissions,
    // Marks this context as a KEY, which suppresses the OWNER break-glass in
    // evaluateAccess. Without it the mask two lines above is computed and then
    // ignored for any key an owner minted.
    isApiKey: true,
    scopes: key.scopes,
    abacRules: eff.abacRules,
    // Empty means org-wide, so it must stay UNDEFINED rather than become an
    // empty allowlist — `[]` as a ceiling would deny everything, turning every
    // pre-existing key into a key that can reach nothing.
    projectScope: key.projectIds?.length ? key.projectIds : undefined,
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
