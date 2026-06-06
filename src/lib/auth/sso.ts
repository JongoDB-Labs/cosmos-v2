import crypto from "node:crypto";
import * as oidc from "openid-client";
import { OrgRole, type IdpConnection } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { logAudit } from "@/lib/audit";
import { autoJoinGeneral } from "@/lib/chat/seed-general";
import { SESSION_MAX_AGE_SECONDS } from "@/lib/auth/client";
import { openSecret } from "@/lib/crypto/vault";

/**
 * In-app OIDC Relying Party — the security core. cosmos remains the single
 * session + OrgMember + audit authority; the IdP only asserts identity.
 *
 * The three load-bearing invariants enforced here:
 *  1. Identity is matched on (idpConnId, subject) — NEVER email. `User.email`
 *     is not unique, so email-only matching would be account-takeover. Email is
 *     a *linking hint* only, and only for exactly one verified-email match.
 *  2. Claim-derived roles are capped at ADMIN — OWNER is never minted from a
 *     claim (the grant-ceiling invariant; OWNER stays human-assigned).
 *  3. GOV AAL floor: if the org is GOV and the connection sets `requiredAcr`,
 *     the IdP must assert an acr/amr that satisfies it, else the login is
 *     rejected (no in-app step-up this slice).
 */

/**
 * The per-request SSO transaction cookie carrying state/nonce/PKCE between the
 * login-initiation redirect and the callback. httpOnly + short-TTL.
 */
export const SSO_TX_COOKIE = "sso_tx";
export const SSO_TX_MAX_AGE_SECONDS = 600; // 10 minutes to complete the round-trip

/** Shape of the JSON stored in the SSO transaction cookie. */
export interface SsoTransaction {
  orgSlug: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** Normalized claims extracted from the validated ID token via attributeMapping. */
export interface SsoClaims {
  /** The IdP `sub` — the stable, security-critical match key. Required. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  groups: string[];
  /** Authentication Context Class Reference asserted by the IdP. */
  acr: string | null;
  /** Authentication Methods References asserted by the IdP. */
  amr: string[];
  /** Optional display name hint for JIT-created users. */
  displayName?: string | null;
}

/** Minimal request context for audit (IP). Routes pass the NextRequest-derived bits. */
export interface SsoRequestContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export type SsoLoginResult =
  | { ok: true; sessionId: string; userId: string; mfaSatisfied: boolean }
  | {
      ok: false;
      reason:
        | "org_not_found"
        | "missing_subject"
        | "aal_floor_unmet"
        | "jit_disabled";
    };

// ─────────────────────────────────────────────
// openid-client discovery (cached per issuer+client)
// ─────────────────────────────────────────────

const configCache = new Map<string, Promise<oidc.Configuration>>();

/**
 * Discover + configure the RP for a connection. Cached per (issuer, clientId)
 * so repeated logins don't re-fetch the discovery document. The client secret
 * is opened from the vault only here, at use.
 */
export function getOidcConfig(conn: IdpConnection): Promise<oidc.Configuration> {
  const cacheKey = `${conn.issuerUrl}|${conn.clientId}`;
  const cached = configCache.get(cacheKey);
  if (cached) return cached;

  const clientSecret = openSecret(conn.clientSecretEnc);
  const promise = oidc
    .discovery(
      new URL(conn.issuerUrl),
      conn.clientId,
      undefined,
      oidc.ClientSecretPost(clientSecret),
    )
    .catch((err) => {
      // Don't cache a failed discovery — let the next attempt retry.
      configCache.delete(cacheKey);
      throw err;
    });
  configCache.set(cacheKey, promise);
  return promise;
}

/** Test seam: drop cached discovery configs (e.g. on connection rotation). */
export function clearOidcConfigCache(): void {
  configCache.clear();
}

// ─────────────────────────────────────────────
// claim extraction (called from the callback route)
// ─────────────────────────────────────────────

type AttributeMapping = {
  subject?: string;
  email?: string;
  emailVerified?: string;
  groups?: string;
};

/**
 * Extract normalized SsoClaims from a validated ID-token claims set, honoring
 * the connection's attributeMapping (with OIDC-standard fallbacks). `sub` is
 * always read from the standard `sub` claim — it's the protocol-level subject.
 */
export function extractClaims(
  raw: Record<string, unknown>,
  conn: IdpConnection,
): SsoClaims {
  const map = (conn.attributeMapping ?? {}) as AttributeMapping;

  const emailKey = map.email ?? "email";
  const emailVerifiedKey = map.emailVerified ?? "email_verified";
  const groupsKey = map.groups ?? "groups";

  const emailVal = raw[emailKey];
  const email =
    typeof emailVal === "string" ? emailVal.toLowerCase() : null;

  const verifiedVal = raw[emailVerifiedKey];
  // Treat email as verified only on an explicit truthy boolean/string.
  const emailVerified =
    verifiedVal === true || verifiedVal === "true";

  const groupsVal = raw[groupsKey];
  const groups = Array.isArray(groupsVal)
    ? groupsVal.filter((g): g is string => typeof g === "string")
    : [];

  const amrVal = raw["amr"];
  const amr = Array.isArray(amrVal)
    ? amrVal.filter((a): a is string => typeof a === "string")
    : [];

  const acrVal = raw["acr"];
  const acr = typeof acrVal === "string" ? acrVal : null;

  const nameVal = raw["name"];
  const displayName = typeof nameVal === "string" ? nameVal : null;

  // `sub` is the protocol subject — never overridden by attributeMapping.
  const subVal = raw["sub"];
  const subject = typeof subVal === "string" ? subVal : "";

  return { subject, email, emailVerified, groups, acr, amr, displayName };
}

// ─────────────────────────────────────────────
// security helpers
// ─────────────────────────────────────────────

/**
 * Does the IdP-asserted acr/amr satisfy the connection's required AAL floor?
 * The IdP MUST assert it — no in-app step-up this slice. Satisfied when the
 * required value matches the token's `acr` exactly OR appears in `amr`.
 */
export function aalFloorSatisfied(
  requiredAcr: string | null,
  claims: Pick<SsoClaims, "acr" | "amr">,
): boolean {
  if (!requiredAcr) return true; // no floor configured
  if (claims.acr === requiredAcr) return true;
  if (claims.amr.includes(requiredAcr)) return true;
  return false;
}

/**
 * Map an IdP group claim to an OrgRole, then CAP at ADMIN. OWNER is never
 * mintable from a claim — it stays human-assigned (grant-ceiling invariant).
 */
export function mapRoleCapped(
  conn: IdpConnection,
  groups: string[],
): OrgRole {
  const roleMapping = (conn.roleMapping ?? {}) as Record<string, string>;

  // First matching group wins; fall back to the connection default.
  let resolved: OrgRole = conn.defaultRole;
  for (const g of groups) {
    const mapped = roleMapping[g];
    // Object.values (not `in`) so prototype keys ("constructor"/"toString") on
    // an admin-editable roleMapping can't slip through as a "valid" role.
    if (mapped && Object.values(OrgRole).includes(mapped as OrgRole)) {
      resolved = mapped as OrgRole;
      break;
    }
  }

  // THE CAP: never OWNER from a claim.
  if (resolved === OrgRole.OWNER) return OrgRole.ADMIN;
  return resolved;
}

// ─────────────────────────────────────────────
// completeSsoLogin — the security-critical flow
// ─────────────────────────────────────────────

export async function completeSsoLogin(
  orgSlug: string,
  conn: IdpConnection,
  claims: SsoClaims,
  ctx: SsoRequestContext,
): Promise<SsoLoginResult> {
  // 0. The subject is the only safe match key — bail if the IdP didn't send one.
  if (!claims.subject) {
    return { ok: false, reason: "missing_subject" };
  }

  // 1. Resolve the org. GOV AAL floor is enforced BEFORE any provisioning so a
  //    floor-failing login leaves no trace (no user, no member, no session).
  const org = await prisma.organization.findUnique({
    where: { slug: orgSlug },
    select: { id: true, tenantClass: true },
  });
  if (!org || org.id !== conn.orgId) {
    return { ok: false, reason: "org_not_found" };
  }

  const isGov = org.tenantClass === "GOV";
  const floorSatisfied = aalFloorSatisfied(conn.requiredAcr, claims);
  if (isGov && conn.requiredAcr && !floorSatisfied) {
    return { ok: false, reason: "aal_floor_unmet" };
  }

  // 2. Identity match — (idpConnId, subject) ONLY. Email is never the authenticator.
  let userId: string;
  const existing = await prisma.federatedIdentity.findUnique({
    where: {
      idpConnId_subject: { idpConnId: conn.id, subject: claims.subject },
    },
    select: { userId: true },
  });

  if (existing) {
    userId = existing.userId;
  } else {
    if (!conn.jitProvisioning) {
      return { ok: false, reason: "jit_disabled" };
    }

    // Email may LINK a never-before-federated local account, but ONLY when it
    // is verified AND there is EXACTLY ONE matching user. Any ambiguity (zero
    // or 2+ matches) → create a fresh user. This is the account-takeover guard:
    // two users sharing the claim email with a NEW subject must NOT be hijacked.
    let linkedUserId: string | null = null;
    if (claims.emailVerified && claims.email) {
      const matches = await prisma.user.findMany({
        where: { email: claims.email },
        select: { id: true },
      });
      if (matches.length === 1) {
        // C1 guard: only email-link a user that is NOT already federated to
        // THIS connection. If they already have a FederatedIdentity here (under
        // a different subject), linking would bind a SECOND subject to the same
        // user = account takeover. Any conflict → fall through to create a fresh
        // user (subject stays the sole authenticator).
        const alreadyFederated = await prisma.federatedIdentity.findFirst({
          where: { userId: matches[0].id, idpConnId: conn.id },
          select: { id: true },
        });
        if (!alreadyFederated) {
          linkedUserId = matches[0].id;
        }
      }
    }

    if (linkedUserId) {
      const updated = await prisma.user.update({
        where: { id: linkedUserId },
        data: { lastActiveAt: new Date() },
        select: { id: true },
      });
      userId = updated.id;
    } else {
      const created = await prisma.user.create({
        data: {
          email: claims.email ?? `${claims.subject}@sso.local`,
          displayName:
            claims.displayName ||
            claims.email?.split("@")[0] ||
            claims.subject,
          lastActiveAt: new Date(),
        },
        select: { id: true },
      });
      userId = created.id;
    }

    // Bind the (verified-or-new) user to this IdP subject. From now on this
    // login is matched by subject, never email.
    await prisma.federatedIdentity.create({
      data: { userId, idpConnId: conn.id, subject: claims.subject },
    });
  }

  // 3. Role mapping — capped at ADMIN, never OWNER.
  const role = mapRoleCapped(conn, claims.groups);
  // Never DOWNGRADE a human-assigned OWNER on SSO re-login: if the member is
  // already OWNER, the claim-derived (capped) role must not strip it. OWNER is
  // human-only in both directions — not mintable AND not removable by a claim.
  const existingMember = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId: org.id, userId } },
    select: { role: true },
  });
  const updateRole =
    existingMember?.role === OrgRole.OWNER ? OrgRole.OWNER : role;
  await prisma.orgMember.upsert({
    where: { orgId_userId: { orgId: org.id, userId } },
    update: { role: updateRole },
    create: { orgId: org.id, userId, role },
  });

  try {
    await autoJoinGeneral(
      org.id,
      userId,
      updateRole === OrgRole.OWNER || updateRole === OrgRole.ADMIN,
    );
  } catch (err) {
    console.warn(
      "[sso] failed to auto-join #general",
      { orgId: org.id, userId },
      err,
    );
  }

  // 4. Consume pending invitations addressed to the (verified) email — mirrors
  //    the Google branch. Only when we actually have an email to match on.
  if (claims.email) {
    const pendingInvites = await prisma.invitation.findMany({
      where: { email: claims.email, expiresAt: { gt: new Date() } },
    });
    for (const invite of pendingInvites) {
      // Don't let an invitation escalate above the IdP-derived (capped) role for
      // THIS org; for other orgs, honor the invite role (also never OWNER-mintable
      // since invitations carry their own role). Use upsert to avoid races.
      const inviteRole =
        invite.role === OrgRole.OWNER ? OrgRole.ADMIN : invite.role;
      const newMember = await prisma.orgMember
        .upsert({
          where: { orgId_userId: { orgId: invite.orgId, userId } },
          update: {},
          create: { orgId: invite.orgId, userId, role: inviteRole },
        })
        .catch(() => undefined);
      if (newMember) {
        try {
          await autoJoinGeneral(
            invite.orgId,
            userId,
            // inviteRole is already capped (never OWNER); ADMIN gets channel-admin.
            inviteRole === OrgRole.ADMIN,
          );
        } catch (err) {
          console.warn(
            "[sso] failed to auto-join invited member to #general",
            { orgId: invite.orgId, userId },
            err,
          );
        }
      }
      await prisma.invitation
        .delete({ where: { id: invite.id } })
        .catch(() => undefined);
    }
  }

  // 5. Audit — append-only store (INSERT only). Records the assurance context.
  await logAudit({
    orgId: org.id,
    userId,
    action: "auth.sso.login",
    entity: "session",
    metadata: {
      idpConnId: conn.id,
      issuer: conn.issuerUrl,
      subject: claims.subject,
      amr: claims.amr,
      acr: claims.acr,
      mfaSatisfied: floorSatisfied,
    },
    ipAddress: ctx.ipAddress ?? undefined,
  });

  // 6. Mint the session — byte-identical tail to google/callback, PLUS the
  //    assurance columns (authMethod / idpConnId / amr / mfaSatisfied).
  const sessionId = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await prisma.session.create({
    data: {
      id: sessionId,
      userId,
      expiresAt,
      authMethod: "oidc",
      idpConnId: conn.id,
      amr: claims.amr,
      mfaSatisfied: floorSatisfied,
    },
  });

  // Org-scoped session record (SSO knows the org, unlike the lazily-populated
  // Google path). Best-effort — never block login on the audit-view mirror.
  await prisma.sessionRecord
    .create({
      data: {
        orgId: org.id,
        userId,
        sessionToken: sessionId,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
        expiresAt,
      },
    })
    .catch(() => undefined);

  return { ok: true, sessionId, userId, mfaSatisfied: floorSatisfied };
}
