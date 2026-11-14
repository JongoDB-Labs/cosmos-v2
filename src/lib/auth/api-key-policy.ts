/**
 * Who may hold API keys, and what they may put on one.
 *
 * PURE and client-safe (no prisma, no request), because three places ask the
 * same questions and must never answer them differently:
 *   - the key verifier (`apiKeyAuthContext`), on every request a key makes;
 *   - the mint route, before it writes a key;
 *   - the Settings page, to decide what to offer.
 * A page that offers what the server refuses, or a server that mints what the
 * verifier then refuses, is the failure this file exists to prevent. Nothing
 * here restates a rule held elsewhere: the scope masks come from
 * `api-key-scopes.ts`, the bits from `permissions.ts`.
 */
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { API_KEY_SCOPES, scopeMask, type ApiKeyScope } from "./api-key-scopes";

export const API_KEY_LIMITS = {
  /** Unexpired keys one person may hold in one org. */
  maxActivePerCreator: 20,
  /** How far ahead a key may expire for someone without API_KEY_MANAGE, in days. */
  maxDaysWithoutManage: 366,
  /** What the create form suggests. */
  defaultDays: 90,
} as const;

/** The org's switch, as the rules read it. A missing settings row is the default: on. */
export interface KeyPolicy {
  /** OrgSecuritySettings.memberApiKeysEnabled — "Members can create their own API keys". */
  memberApiKeysEnabled: boolean;
}

/**
 * An administrator of keys: sees and revokes every key in the org, may mint a
 * key that never expires, and keeps their keys whatever the switch says.
 */
export function managesAllApiKeys(permissions: bigint): boolean {
  return hasPermission(permissions, Permission.API_KEY_MANAGE);
}

/**
 * May open the API keys page, and list and revoke their OWN keys. Deliberately
 * not conditioned on the switch: with member keys turned off, a member can
 * still see and clean up the keys that stopped working.
 */
export function mayManageOwnApiKeys(permissions: bigint): boolean {
  return managesAllApiKeys(permissions) || hasPermission(permissions, Permission.API_KEY_CREATE);
}

/**
 * Whether a person holding `permissions` may hold API keys at all: the part of
 * `keyInactiveReason` that doesn't depend on a particular key. Because the
 * verifier asks it of the creator on every request, the org's switch, a
 * demotion to GUEST, and removing API_KEY_CREATE from a role take effect on
 * existing keys at once rather than only on new ones.
 *
 * `permissions` must be the person's own effective permissions, never a key's
 * masked ones: no scope carries an API_KEY_* bit, so a masked set would refuse
 * every key.
 */
export function mayHoldApiKeys(permissions: bigint, policy: KeyPolicy): boolean {
  if (managesAllApiKeys(permissions)) return true;
  return policy.memberApiKeysEnabled && hasPermission(permissions, Permission.API_KEY_CREATE);
}

// ─── Whether a key works ─────────────────────────────────────────────────────

/** Why a key authenticates nobody right now. */
export type KeyInactiveReason = "creator_gone" | "expired" | "role" | "switch_off" | "lapsed" | "sso";

/** What a key's standing depends on besides the key itself. */
export interface KeyStanding {
  /**
   * The creator's own effective permissions AS A KEY SEES THEM
   * (`loadEffectivePermissions(..., { forApiKey: true })`: no owner
   * break-glass), or null when they are no longer a member of the org.
   */
  creatorPermissions: bigint | null;
  policy: KeyPolicy;
  /**
   * The IdP connection the org requires sign-in through
   * (lib/auth/sso-enforcement.ts `requiredIdpConnectionId`), or null when it
   * requires none. Callers may pass null for a creator who manages keys: it
   * is never read for them.
   */
  requiredIdpConnId: string | null;
}

/**
 * THE rule for whether a key works, and if not, why. The verifier
 * (`apiKeyAuthContext`) refuses a key exactly when this is non-null, the key
 * list shows the same answer, and minting asks it of the key about to be made,
 * so the three can't disagree.
 *
 * Someone who manages keys (API_KEY_MANAGE, as a key sees it) keeps every key
 * they made until its own expiry. Anyone else's key also needs, right now:
 * API_KEY_CREATE, the org's switch on, to be within 366 days of being made,
 * and, where the org requires single sign-on, to have been made from a
 * session of that org's IdP. A key with no recorded IdP fails that last check:
 * there is no sign-in behind it to vouch for.
 */
export function keyInactiveReason(
  standing: KeyStanding,
  key: { createdAt: Date; expiresAt?: Date | null; idpConnId?: string | null },
  now: Date,
): KeyInactiveReason | null {
  const p = standing.creatorPermissions;
  if (p === null) return "creator_gone";
  // The same comparison the verifier's secret check makes (api-key.ts matchedKey).
  if (key.expiresAt && key.expiresAt.getTime() < now.getTime()) return "expired";
  if (managesAllApiKeys(p)) return null;
  if (!hasPermission(p, Permission.API_KEY_CREATE)) return "role";
  if (!standing.policy.memberApiKeysEnabled) return "switch_off";
  if (keyLapsedFor(p, key.createdAt, now)) return "lapsed";
  if (!madeThroughRequiredIdp(standing.requiredIdpConnId, key.idpConnId)) return "sso";
  return null;
}

/**
 * Whether a credential made from a session of `idpConnId` (null: not single
 * sign-on) may act in an org that requires sign-in through `requiredIdpConnId`
 * (null: it requires none). A credential has no sign-in of its own, so the
 * session it was made from is what the requirement is held to, and one with
 * no recorded IdP fails it: there is no sign-in behind it to vouch for.
 * API keys (above) and calendar feed links (lib/calendar/feed.server.ts
 * `feedMeetsSso`) both ask it.
 */
export function madeThroughRequiredIdp(requiredIdpConnId: string | null, idpConnId: string | null | undefined): boolean {
  return requiredIdpConnId === null || (idpConnId ?? null) === requiredIdpConnId;
}

/** Why a key in the list doesn't work, in the list's words. */
export const KEY_INACTIVE_TEXT: Record<KeyInactiveReason, string> = {
  creator_gone: "Not active: its creator is no longer in this organization",
  expired: "Not active: it has expired",
  role: "Not active: its creator's role can't use API keys",
  switch_off: "Not active: an admin has turned off API keys for members",
  lapsed: `Not active: it passed the ${API_KEY_LIMITS.maxDaysWithoutManage}-day limit`,
  sso: "Not active: it wasn't made through this organization's single sign-on",
};

/** Why someone may not mint a key right now, from their side. */
export const MINT_REFUSAL_TEXT: Record<KeyInactiveReason, string> = {
  creator_gone: "You aren't a member of this organization.",
  expired: "Choose an expiry date in the future.",
  role: "Your role can't use API keys.",
  switch_off: "Your organization only lets admins create API keys.",
  lapsed: `A key can last at most ${API_KEY_LIMITS.maxDaysWithoutManage} days.`,
  sso: "This organization requires single sign-on. Sign in through it to create an API key.",
};

// ─── Scopes ──────────────────────────────────────────────────────────────────

/**
 * The scopes that only read. Writing implies reading (time:write carries
 * TIME_READ), so a write scope's read bits say nothing about whether its owner
 * can write.
 */
const READ_ONLY_SCOPES: readonly ApiKeyScope[] = ["read", "time:read"];
const READ_ONLY_MASK = scopeMask([...READ_ONLY_SCOPES]);

/**
 * `members:read` adds no permission bits: it lets a key see the email addresses
 * that the member list and a project's member list carry. A key may have it when
 * its creator can already see those addresses with a browser session, and
 * today every member can: GET /orgs/{orgId}/members checks no permission bit and
 * returns `user.email` to every session ("a browser session always does", says
 * its contract). So anyone who may mint at all may take it.
 *
 * If that route ever withholds emails from some role, this must become a real
 * check on the same bit. member-keys.db.test.ts drives the route as every role
 * and fails when the two disagree.
 */
const EVERY_SESSION_SEES_MEMBER_EMAILS = true;

/** What a scope lets a key do, in the words a refusal uses. */
export const SCOPE_PURPOSE: Record<ApiKeyScope, string> = {
  read: "read projects and work items",
  "items:write": "create or edit work items",
  "items:delete": "delete work items",
  "planning:write": "change plans",
  "documents:write": "add documents",
  "time:read": "see time",
  "time:write": "log time",
  "members:read": "see members' email addresses",
  "webhooks:manage": "manage webhooks",
  "audit:read": "read the audit log",
  "rules:run": "run checks",
};

/**
 * Whether a person holding `permissions` gets from `scope` what it is named
 * for, which is what decides if they may put it on a key:
 *   - `read`, `time:read`: they hold at least one of its bits;
 *   - `members:read`: they can already see members' email addresses (above);
 *   - any other scope: they hold at least one of its bits that no read-only
 *     scope carries. A viewer holds TIME_READ, which time:write also carries,
 *     but can't log time, so time:write is refused them.
 * A scope that would give them nothing it is named for is refused, so a key
 * never claims to do what its owner can't.
 */
export function scopeGrantable(permissions: bigint, scope: ApiKeyScope): boolean {
  if (scope === "members:read") return EVERY_SESSION_SEES_MEMBER_EMAILS;
  if (READ_ONLY_SCOPES.includes(scope)) return (permissions & scopeMask([scope])) !== 0n;
  return (permissions & scopeMask([scope]) & ~READ_ONLY_MASK) !== 0n;
}

/** Null when the person may put `scope` on a key; otherwise a short reason, from their side. */
export function scopeRefusal(permissions: bigint, scope: ApiKeyScope): string | null {
  return scopeGrantable(permissions, scope) ? null : `Your role can't ${SCOPE_PURPOSE[scope]}.`;
}

/** Every scope's verdict, in display order, for the create form. */
export function scopeVerdicts(permissions: bigint): { scope: ApiKeyScope; refusal: string | null }[] {
  return API_KEY_SCOPES.map((scope) => ({ scope, refusal: scopeRefusal(permissions, scope) }));
}

/** The scopes among `scopes` this person may not put on a key, in the order asked. */
export function refusedScopes(permissions: bigint, scopes: readonly ApiKeyScope[]): ApiKeyScope[] {
  return scopes.filter((s) => !scopeGrantable(permissions, s));
}

// ─── Expiry ──────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** yyyy-mm-dd of an instant, in UTC: the value a date input holds. */
export function utcDateInput(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The latest expiry someone without API_KEY_MANAGE may choose: the end of the
 * day, in UTC, 366 days from today. A whole day rather than an instant, because
 * the form picks a date and sends the end of it.
 */
export function latestExpiryWithoutManage(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + API_KEY_LIMITS.maxDaysWithoutManage, 23, 59, 59, 999),
  );
}

/** The date the create form starts with. */
export function defaultExpiryDate(now: Date): string {
  return utcDateInput(new Date(now.getTime() + API_KEY_LIMITS.defaultDays * DAY_MS));
}

/**
 * Whether a key made at `createdAt` has outlived what its creator may hold now.
 * Without API_KEY_MANAGE a key must end within 366 days of being made, so a key
 * made while they could manage keys (one that never expires, or ends later)
 * ends for them where one made that day would have had to.
 */
export function keyLapsedFor(permissions: bigint, createdAt: Date, now: Date): boolean {
  return !managesAllApiKeys(permissions) && now.getTime() > latestExpiryWithoutManage(createdAt).getTime();
}

/**
 * When a key really stops working, given its creator's permissions now: its
 * own expiry, or for a creator without API_KEY_MANAGE, at the latest the end of
 * the 366th day after it was made (`keyLapsedFor`). Null: it never expires.
 * What the key list shows, so a key that lapses there doesn't read "No expiry".
 */
export function effectiveExpiry(permissions: bigint, createdAt: Date, expiresAt: Date | null): Date | null {
  if (managesAllApiKeys(permissions)) return expiresAt;
  const cap = latestExpiryWithoutManage(createdAt);
  return expiresAt && expiresAt.getTime() < cap.getTime() ? expiresAt : cap;
}

/** Null when `expiresAt` is acceptable for this person; otherwise why not, from their side. */
export function expiryRefusal(expiresAt: Date | null, managesAll: boolean, now: Date): string | null {
  if (expiresAt === null) return managesAll ? null : "Choose when this key expires.";
  if (Number.isNaN(expiresAt.getTime())) return "That expiry date isn't valid.";
  if (expiresAt.getTime() <= now.getTime()) return "Choose an expiry date in the future.";
  if (!managesAll && expiresAt.getTime() > latestExpiryWithoutManage(now).getTime()) {
    return `A key can last at most ${API_KEY_LIMITS.maxDaysWithoutManage} days. Choose an earlier date.`;
  }
  return null;
}
