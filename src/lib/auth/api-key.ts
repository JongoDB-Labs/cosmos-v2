import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { loadEffectivePermissions } from "@/lib/rbac/effective-permissions";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { API_KEY_SCOPES, type ApiKeyScope } from "./api-key-scopes";
import { classifyBearer, parseKeyToken } from "./bearer";

// Re-exported so existing server importers of `@/lib/auth/api-key` keep working.
// Client components MUST import these from `./api-key-scopes` directly — this
// module pulls in prisma/session and cannot be in the browser bundle.
export { API_KEY_SCOPES };
export type { ApiKeyScope };

const SCOPE_MASK: Record<ApiKeyScope, bigint> = {
  // COMMENT_READ belongs in `read` for the same reason the others do: a
  // conversation is part of reading an item, and without it a key could POST a
  // comment (with items:write) and then be denied its own reply on the way back
  // out — "Access denied by policy" on a GET the caller had just written to.
  //
  // Deliberately NOT ORG_READ or ANALYTICS_READ. The mask is recomputed from a
  // key's scopes on every request, so a bit added here reaches every existing
  // read key on every route, including writes that gate on ORG_READ alone
  // (scope-compat.test.ts checks that no bit here gates a write). The reads that
  // need ORG_READ ask a key for PROJECT_READ instead (labels, custom fields).
  read:
    Permission.PROJECT_READ | Permission.ITEM_READ | Permission.COMMENT_READ |
    Permission.OKR_READ | Permission.SPRINT_READ,
  // Write means write: CREATE alone let a key file an item and then never touch
  // it again — no status change, no re-assign, no comment — which is most of
  // what "work the board without a browser" actually is. ITEM_UPDATE and
  // COMMENT_CREATE are what the item PUT and the comment POST gate on.
  //
  // ITEM_DELETE is deliberately NOT here. Destroying work is a different
  // decision from editing it, and a scope named for writing should not quietly
  // carry it; a key that needs to delete should say so with a scope of its own.
  "items:write":
    Permission.PROJECT_READ | Permission.PROJECT_UPDATE | Permission.ITEM_READ |
    Permission.ITEM_CREATE | Permission.ITEM_UPDATE |
    Permission.COMMENT_CREATE | Permission.COMMENT_READ |
    Permission.OKR_READ | Permission.OKR_CREATE |
    Permission.SPRINT_READ | Permission.SPRINT_CREATE,
  // The delete half of items:write, as its own decision: work items and OKRs.
  // A planning delete (milestone, goal, KPI) needs planning:write as well.
  "items:delete": Permission.ITEM_DELETE | Permission.OKR_DELETE,
  // Milestones, goals, KPIs and interval changes, split out of items:write so a
  // reporting integration can plan without being able to edit work.
  "planning:write":
    Permission.PROJECT_READ | Permission.PROJECT_UPDATE | Permission.ITEM_READ |
    Permission.OKR_READ | Permission.OKR_CREATE | Permission.OKR_UPDATE |
    Permission.SPRINT_READ | Permission.SPRINT_CREATE | Permission.SPRINT_UPDATE,
  // Time is its own domain: hours are payroll and billing data, not work items.
  // Rates stay behind canSeeRate (own rows, or FINANCE_READ) whatever the scope.
  "time:read": Permission.TIME_READ,
  "time:write": Permission.TIME_READ | Permission.TIME_CREATE | Permission.TIME_UPDATE,
  // A disclosure scope, not a permission: it adds no bits. A token sees
  // members' email addresses (member list, project members) only when it holds
  // it, because integrations match people by email and the key's owner should
  // opt into handing a script everyone's address. Contracts name the fields
  // (`scopedFields`); respond() removes them for tokens without it.
  "members:read": 0n,
  "webhooks:manage": Permission.WEBHOOK_MANAGE,
  "audit:read": Permission.AUDIT_LOG_READ,
  "documents:write":
    Permission.PROJECT_READ | Permission.PROJECT_UPDATE | Permission.ITEM_READ | Permission.ITEM_CREATE,
  // Exactly one permission, and deliberately no read: a scheduler needs to
  // TRIGGER rules, not to browse the org. Anything wider would hand a key that
  // sits on a cron box the ability to read projects.
  "rules:run": Permission.RULES_RUN,
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
  orgId: string; name: string; scopes: string[]; createdById: string;
  expiresAt?: Date | null;
  /** Projects the key may touch. Omit or pass [] for org-wide. */
  projectIds?: string[];
}) {
  // Prefix is HEX (no `_`/`-`) so the token splits unambiguously at the prefix's
  // `_` delimiter — the secret (base64url) may contain `_`/`-`, and as the final
  // segment that's fine. (A base64url prefix made parsing ambiguous: a greedy
  // split mis-read any token whose secret held an underscore — ~3 in 4 of them.)
  const prefix = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const token = `cosmos_${prefix}_${secret}`;
  const record = await prisma.apiKey.create({
    data: {
      orgId: input.orgId, name: input.name, prefix, keyHash: sha256(secret),
      scopes: input.scopes, createdById: input.createdById, expiresAt: input.expiresAt ?? null,
      projectIds: input.projectIds ?? [],
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
 * a key whose minting user was removed (createdById null), or a user who no
 * longer has a membership in the org. The acting principal is `createdById`, and
 * the returned permissions are that user's effective permissions ∩ scope mask.
 */
export async function verifyApiKey(req: Request, orgId: string): Promise<AuthContext | null> {
  return verifyApiKeyHeader(req.headers.get("authorization"), orgId);
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
): Promise<AuthContext | null> {
  const parsed = parseKeyToken(authorization);
  if (!parsed) return null;
  const key = await prisma.apiKey.findUnique({
    where: { orgId_prefix: { orgId, prefix: parsed.prefix } },
    select: {
      id: true, keyHash: true, scopes: true, projectIds: true,
      expiresAt: true, createdById: true,
    },
  });
  if (!key || !key.createdById) return null;
  const a = Buffer.from(sha256(parsed.secret)); const b = Buffer.from(key.keyHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return null;
  const ctx = await apiKeyAuthContext(orgId, {
    createdById: key.createdById, scopes: key.scopes, projectIds: key.projectIds,
  });
  if (!ctx) return null;
  void prisma.apiKey.update({ where: { id: key.id }, data: { lastUsed: new Date() } }).catch(() => {});
  return ctx;
}

/**
 * The AuthContext an AUTHENTICATED key acts with: its minting user's effective
 * permissions ∩ the key's scope mask, its project ceiling, and `isApiKey`.
 * `null` when the minting user is no longer a member of the org.
 *
 * Split out of `verifyApiKeyHeader` so the rule lives in exactly one place and
 * can be exercised directly. It does NOT authenticate anything — the caller
 * must already have matched the secret against `keyHash` and checked expiry,
 * which is what `verifyApiKeyHeader` does before it gets here.
 */
export async function apiKeyAuthContext(
  orgId: string,
  key: { createdById: string; scopes: string[]; projectIds: string[] | null },
): Promise<AuthContext | null> {
  const eff = await loadEffectivePermissions(orgId, key.createdById);
  if (!eff) return null;
  const mask = scopeMask(key.scopes);
  return {
    userId: key.createdById, orgId, orgRole: eff.orgRole,
    permissions: eff.permissions & mask, basePermissions: eff.basePermissions & mask,
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
