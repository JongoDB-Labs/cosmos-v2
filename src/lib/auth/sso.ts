import crypto from "node:crypto";
import * as oidc from "openid-client";
import { OrgRole, Prisma, type IdpConnection } from "@prisma/client";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { emailDomainListed } from "@/lib/auth/allowed-domains";
import { isInternalAdmin } from "@/lib/internal/access";
import { logAudit } from "@/lib/audit";
import { deleteMemberKeysIn } from "@/lib/auth/api-key-manage.server";
import { autoJoinGeneral } from "@/lib/chat/seed-general";
import { SESSION_MAX_AGE_SECONDS } from "@/lib/auth/client";
import { openSecret } from "@/lib/crypto/vault";
import { escapeLike } from "@/lib/query/like";

/**
 * In-app OIDC Relying Party — the security core. cosmos remains the single
 * session + OrgMember + audit authority; the IdP only asserts identity.
 *
 * The three load-bearing invariants enforced here:
 *  1. Identity is matched on (idpConnId, subject), from the same token issuer —
 *     NEVER email. `User.email` is not unique, so email-only matching would be
 *     account-takeover. Email is a *linking hint* only (see step 2 below), and an
 *     org's IdP is trusted for that org alone: it links only an account the org
 *     holds or invited, accepts only the org's own invitations, never makes a
 *     system admin, and the session it mints opens only this org (enforced in
 *     getAuthContext, see lib/auth/org-session-scope).
 *  2. Claim-derived roles are capped at ADMIN — OWNER is never minted from a
 *     claim (the grant-ceiling invariant; OWNER stays human-assigned).
 *  3. GOV AAL floor: if the org is GOV and the connection sets `requiredAcr`,
 *     the IdP must assert an acr/amr that satisfies it, else the login is
 *     rejected (no in-app step-up this slice).
 */

/**
 * The address a JIT-created account gets when its IdP's claim can't be trusted
 * for the org (not verified, or outside the org's allowed domains). Storing the
 * claimed address would park it on an IdP-made account, where it blocks its real
 * owner's first Google or Microsoft sign-in. Derived from the binding, so it is
 * stable per (connection, subject), carries none of the IdP's text, and is not
 * an address any provider can verify.
 */
export function ssoPlaceholderEmail(idpConnId: string, subject: string): string {
  const id = crypto.createHash("sha256").update(`${idpConnId}\u0000${subject}`).digest("hex").slice(0, 24);
  return `sso-${id}@sso.local`;
}

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
  /** The validated token `iss`. A binding only matches tokens from the issuer
   *  that made it. */
  issuer?: string | null;
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
        | "jit_disabled"
        /** The binding was made by a different issuer than this token's. */
        | "issuer_mismatch"
        /** An account already holds the address, and this org neither holds nor
         *  invited it. */
        | "account_exists"
        /** An account already holds the address, and this IdP is not trusted for
         *  it (not verified, or not in a domain the org lists). */
        | "email_untrusted";
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
  // openid-client is HTTPS-only by default (the correct production posture; real
  // IdPs — Entra/Okta/Ping — are https). SSO_ALLOW_INSECURE_ISSUER=1 opts a stack
  // into permitting an http issuer for discovery + token requests. It exists for
  // (a) in-boundary / air-gapped issuers reached over an isolated internal network
  // without public TLS, and (b) the throwaway dex Docker-acceptance stack. It is
  // DEFAULT-OFF and must never be set for an internet-facing tenant.
  const allowInsecure = process.env.SSO_ALLOW_INSECURE_ISSUER === "1";
  const promise = oidc
    .discovery(
      new URL(conn.issuerUrl),
      conn.clientId,
      undefined,
      oidc.ClientSecretPost(clientSecret),
      allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
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

  // openid-client has already checked `iss` against the discovered issuer.
  const issVal = raw["iss"];
  const issuer = typeof issVal === "string" && issVal ? issVal : null;

  // `sub` is the protocol subject — never overridden by attributeMapping.
  const subVal = raw["sub"];
  const subject = typeof subVal === "string" ? subVal : "";

  return { subject, email, emailVerified, groups, acr, amr, displayName, issuer };
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

  const security = await prisma.orgSecuritySettings.findUnique({
    where: { orgId: org.id },
    select: { allowedDomains: true },
  });
  // The IdP is trusted for an address only when it says the address is verified
  // AND the org has listed that domain. An org that lists no domains has claimed
  // no address, so its IdP is trusted for none: a new account gets a placeholder,
  // and its claim can never park someone else's address on an IdP-made account.
  const emailTrusted =
    claims.emailVerified &&
    !!claims.email &&
    emailDomainListed(claims.email, security?.allowedDomains);

  const isGov = org.tenantClass === "GOV";
  const floorSatisfied = aalFloorSatisfied(conn.requiredAcr, claims);
  if (isGov && conn.requiredAcr && !floorSatisfied) {
    return { ok: false, reason: "aal_floor_unmet" };
  }

  // 2. Identity match — (idpConnId, subject) ONLY, from the same issuer. Email is
  //    never the authenticator.
  let userId: string;
  const issuer = claims.issuer ?? null;
  const existing = await prisma.federatedIdentity.findUnique({
    where: {
      idpConnId_subject: { idpConnId: conn.id, subject: claims.subject },
    },
    select: { id: true, userId: true, issuer: true },
  });

  if (existing) {
    if (existing.issuer != null && existing.issuer !== issuer) {
      // The connection now points at a different IdP than the one that made
      // this binding. A matching subject string from another issuer is not the
      // same person.
      return { ok: false, reason: "issuer_mismatch" };
    }
    if (existing.issuer == null && issuer) {
      // Bound before issuers were recorded: record it now, so from here on a
      // token from any other issuer cannot use this binding.
      await prisma.federatedIdentity.update({ where: { id: existing.id }, data: { issuer } });
    }
    userId = existing.userId;
  } else {
    if (!conn.jitProvisioning) {
      return { ok: false, reason: "jit_disabled" };
    }

    // A system admin's address is reserved for first-party sign-in: an IdP
    // neither links to that account nor creates one under that address,
    // whatever it says about verification.
    if (claims.email && isInternalAdmin(claims.email, process.env.INTERNAL_ADMINS)) {
      return { ok: false, reason: "account_exists" };
    }

    const holders = claims.email
      ? await prisma.user.findMany({
          where: {
            email: { equals: escapeLike(claims.email), mode: "insensitive" },
            isBot: false,
            deactivatedAt: null,
          },
          select: { id: true },
        })
      : [];

    // Email may LINK a never-before-federated account only when ALL hold:
    //  - the IdP vouches for the address (verified, in a domain the org lists);
    //  - exactly one account holds it;
    //  - this org already holds that account (a live member; a removed one is
    //    filtered out, as the auth chokepoint does) or has a pending, unexpired
    //    invitation for the address. The org's admin chose this person; the
    //    IdP only proves it is them. The account's other orgs are safe however
    //    many it has: the session this mints opens THIS org only.
    //  - it has no binding to this connection yet (a second subject for the
    //    same account would be a takeover).
    let linkedUserId: string | null = null;
    if (emailTrusted && claims.email && holders.length === 1) {
      const candidate = holders[0].id;
      const [member, invited, alreadyFederated] = await Promise.all([
        prisma.orgMember.findUnique({
          where: { orgId_userId: { orgId: org.id, userId: candidate } },
          select: { id: true },
        }),
        prisma.invitation.findFirst({
          where: {
            orgId: org.id,
            email: { equals: escapeLike(claims.email), mode: "insensitive" },
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        }),
        prisma.federatedIdentity.findFirst({
          where: { userId: candidate, idpConnId: conn.id },
          select: { id: true },
        }),
      ]);
      if ((member || invited) && !alreadyFederated) linkedUserId = candidate;
    }

    // Never mint a second account under an address someone already holds: the
    // duplicate would carry that address into every email-keyed decision.
    if (!linkedUserId && holders.length > 0) {
      return { ok: false, reason: emailTrusted ? "account_exists" : "email_untrusted" };
    }

    try {
      if (linkedUserId) {
        await prisma.federatedIdentity.create({
          data: { userId: linkedUserId, idpConnId: conn.id, subject: claims.subject, issuer },
        });
        await prisma.user.update({
          where: { id: linkedUserId },
          data: { lastActiveAt: new Date() },
          select: { id: true },
        });
        userId = linkedUserId;
      } else {
        // A new account, bound in the same write. `ssoProvisioned` marks that it
        // came from this IdP: never a system admin, and Google or Microsoft
        // sign-in never links to it by email. It gets the claimed address only
        // when the IdP is trusted for it; otherwise a placeholder.
        const created = await prisma.user.create({
          data: {
            email: emailTrusted && claims.email ? claims.email : ssoPlaceholderEmail(conn.id, claims.subject),
            displayName:
              claims.displayName ||
              claims.email?.split("@")[0] ||
              claims.subject,
            lastActiveAt: new Date(),
            ssoProvisioned: true,
            federatedIdentities: {
              create: { idpConnId: conn.id, subject: claims.subject, issuer },
            },
          },
          select: { id: true },
        });
        userId = created.id;
      }
    } catch (err) {
      // A concurrent first sign-in (a second tab) bound this subject a moment ago.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      const raced = await prisma.federatedIdentity.findUnique({
        where: { idpConnId_subject: { idpConnId: conn.id, subject: claims.subject } },
        select: { userId: true, issuer: true },
      });
      if (!raced || (raced.issuer != null && raced.issuer !== issuer)) throw err;
      userId = raced.userId;
    }
  }

  // 3. Role mapping — capped at ADMIN, never OWNER.
  const role = mapRoleCapped(conn, claims.groups);
  // Never DOWNGRADE a human-assigned OWNER on SSO re-login: if the member is
  // already OWNER, the claim-derived (capped) role must not strip it. OWNER is
  // human-only in both directions — not mintable AND not removable by a claim.
  // Unfiltered on purpose: a removed member still HAS a row, and this must see it for
  // both lines below — so a removed OWNER is still recognised as OWNER, and so the
  // upsert's update branch is the one that runs.
  const existingMember = await prismaUnfiltered.orgMember.findUnique({
    where: { orgId_userId: { orgId: org.id, userId } },
    select: { role: true, removedAt: true },
  });
  const updateRole =
    existingMember?.role === OrgRole.OWNER ? OrgRole.OWNER : role;
  // `removedAt: null` reinstates someone the IdP still vouches for. This keeps the
  // behaviour that existed when removal was a hard delete — the upsert simply created
  // the row again — rather than quietly becoming a lockout, where SSO accepts the
  // login and then every membership read filters the person away.
  const membership = {
    where: { orgId_userId: { orgId: org.id, userId } },
    update: { role: updateRole, removedAt: null },
    create: { orgId: org.id, userId, role },
  };
  if (existingMember?.removedAt != null) {
    // Reinstating brings the membership back, never the API keys made before
    // the removal: any left on the row go in the same transaction.
    await prismaUnfiltered.$transaction(async (tx) => {
      const member = await tx.orgMember.upsert({ ...membership, select: { id: true } });
      await deleteMemberKeysIn(tx, {
        orgId: org.id,
        userId,
        memberId: member.id,
        actorUserId: userId,
        reason: "reinstated",
      });
    });
  } else {
    await prismaUnfiltered.orgMember.upsert(membership);
  }

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

  // 4. Consume pending invitations to THIS org addressed to the email, and only
  //    when the IdP is trusted for the address (verified, in the org's allowed
  //    domains). Another org's invitations are never this IdP's to accept: the
  //    invitee joins those through their own sign-in. The membership already
  //    exists (step 3), so this clears the invitation without raising the role
  //    above the IdP-derived one.
  if (emailTrusted && claims.email) {
    const pendingInvites = await prisma.invitation.findMany({
      where: {
        orgId: org.id,
        email: { equals: escapeLike(claims.email), mode: "insensitive" },
        expiresAt: { gt: new Date() },
      },
    });
    for (const invite of pendingInvites) {
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
