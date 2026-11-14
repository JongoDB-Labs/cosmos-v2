import { Prisma, type User } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { isInternalAdmin } from "@/lib/internal/access";
import { escapeLike } from "@/lib/query/like";

/**
 * Account resolution for the FIRST-PARTY sign-in providers (Google, Microsoft):
 * the providers an instance admin configures for the whole instance, as opposed
 * to an organization's own IdP (SSO, lib/auth/sso.ts).
 *
 * The rule, the same for both:
 *  1. The provider's stable subject decides. Google: `sub` (User.googleId).
 *     Microsoft: the token's tenant id + object id (MicrosoftIdentity). Once an
 *     account is bound, email is never used to find it again, so a changed
 *     address still reaches it and a second account with the same address can't.
 *  2. Email links a FIRST sign-in to an existing account only when ALL hold:
 *     - the provider vouches for the address (the caller passes only verified
 *       addresses; an empty list means "nothing verified" and refuses);
 *     - the address is on the sign-in allowlist;
 *     - exactly one live, non-bot account holds it (case-insensitively);
 *     - that account has no identity from this provider yet;
 *     - that account was not created by an organization's IdP (`ssoProvisioned`):
 *       its address came from an unverified claim, and linking would hand the
 *       IdP a login to whoever really owns the address.
 *     - Microsoft only: the account has no Google identity, and its address is
 *       not a platform admin's (INTERNAL_ADMINS). Those accounts already have a
 *       first-party sign-in, and Microsoft's word for an address is the weaker
 *       one, so they connect Microsoft explicitly from a signed-in session
 *       (connectFirstPartyIdentity) instead.
 *     The link then binds the subject, and email is never consulted again.
 *  3. No account holds the address → a new account, bound in the same write
 *     (never, for Microsoft, at a platform admin's address).
 *
 * `User.email` is not unique, which is why rule 2 counts matches rather than
 * taking `findFirst`.
 */

export type FirstPartyIdentity =
  | { provider: "google"; subject: string }
  | { provider: "microsoft"; tenantId: string; objectId: string };

export type FirstPartyRefusal =
  /** Not bound, and the provider vouched for no address. */
  | "email_unverified"
  /** The address (or a bound account's own address) is not on the allowlist. */
  | "not_allowed"
  /** The matching account is already bound to a different identity from this provider. */
  | "identity_conflict"
  /** More than one account holds the address, so it can't say which one. */
  | "account_ambiguous"
  /** The only account with the address was created by an organization's SSO. */
  | "sso_account"
  /** Not bound, and nothing could vouch for an address because the deployment
   *  isn't set up for it yet (Microsoft: no `xms_edov`, no trusted domains). */
  | "ms_setup_incomplete"
  /** The account may only gain this provider explicitly, from a signed-in
   *  session (Microsoft onto a Google-bound or platform-admin account). */
  | "link_from_profile";

export type FirstPartyResult =
  | { ok: true; user: User; outcome: "bound" | "linked" | "created" }
  | { ok: false; reason: FirstPartyRefusal };

type Profile = { displayName: string; avatarUrl?: string | null };

function envAllowlist(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** True when `email` may sign in: the ALLOWED_EMAILS bootstrap list or the
 *  DB-managed allowlist. */
export async function isEmailAllowlisted(email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (!e) return false;
  if (envAllowlist().includes(e)) return true;
  const row = await prisma.allowedEmail.findFirst({
    where: { email: { equals: escapeLike(e), mode: "insensitive" } },
    select: { id: true },
  });
  return row != null;
}

async function findBound(identity: FirstPartyIdentity): Promise<User | null> {
  if (identity.provider === "google") {
    return prisma.user.findUnique({ where: { googleId: identity.subject } });
  }
  const row = await prisma.microsoftIdentity.findUnique({
    where: {
      tenantId_objectId: { tenantId: identity.tenantId, objectId: identity.objectId },
    },
    select: { user: true },
  });
  return row?.user ?? null;
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

export async function resolveFirstPartyUser(input: {
  identity: FirstPartyIdentity;
  /** Addresses the provider vouches for. Never pass an unverified one. */
  verifiedEmails: string[];
  profile: Profile;
  /** The refusal when no address is vouched for (default email_unverified). */
  noVerifiedEmail?: Extract<FirstPartyRefusal, "email_unverified" | "ms_setup_incomplete">;
}): Promise<FirstPartyResult> {
  const { identity, profile } = input;
  const now = new Date();

  // 1. Bound: the subject decides. The allowlist still applies, to the
  //    ACCOUNT's address, so removing someone from it still keeps them out, while
  //    a change of address at the provider does not.
  const bound = await findBound(identity);
  if (bound && !bound.deactivatedAt) {
    if (!(await isEmailAllowlisted(bound.email))) return { ok: false, reason: "not_allowed" };
    const user = await prisma.user.update({
      where: { id: bound.id },
      data: { lastActiveAt: now, ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}) },
    });
    return { ok: true, user, outcome: "bound" };
  }
  if (bound) return { ok: false, reason: "not_allowed" }; // a deactivated tombstone

  // 2. Not bound: a verified, allowlisted address may link or create.
  const verified = [...new Set(input.verifiedEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (verified.length === 0) return { ok: false, reason: input.noVerifiedEmail ?? "email_unverified" };

  let email: string | null = null;
  for (const candidate of verified) {
    if (await isEmailAllowlisted(candidate)) {
      email = candidate;
      break;
    }
  }
  if (!email) return { ok: false, reason: "not_allowed" };

  const holders = await prisma.user.findMany({
    where: {
      email: { equals: escapeLike(email), mode: "insensitive" },
      isBot: false,
      deactivatedAt: null,
    },
    select: { id: true, googleId: true, ssoProvisioned: true, microsoftIdentity: { select: { id: true } } },
  });
  const firstParty = holders.filter((h) => !h.ssoProvisioned);
  if (firstParty.length > 1) return { ok: false, reason: "account_ambiguous" };
  if (firstParty.length === 0 && holders.length > 0) return { ok: false, reason: "sso_account" };

  // Microsoft never reaches a platform admin's address by email, to link or to
  // create: that account connects Microsoft from a signed-in session.
  if (identity.provider === "microsoft" && isInternalAdmin(email, process.env.INTERNAL_ADMINS)) {
    return { ok: false, reason: "link_from_profile" };
  }

  if (firstParty.length === 1) {
    const target = firstParty[0];
    const alreadyBound =
      identity.provider === "google" ? target.googleId != null : target.microsoftIdentity != null;
    if (alreadyBound) return { ok: false, reason: "identity_conflict" };
    if (identity.provider === "microsoft" && target.googleId != null) {
      return { ok: false, reason: "link_from_profile" };
    }
    try {
      if (identity.provider === "google") {
        const existing = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
        // Conditional on the account still having no Google identity: two
        // first sign-ins racing (different Google accounts, same address) must
        // not let the second overwrite the first's binding.
        const won = await prisma.user.updateMany({
          where: { id: target.id, googleId: null },
          data: {
            googleId: identity.subject,
            displayName: existing.displayName || profile.displayName,
            avatarUrl: profile.avatarUrl ?? existing.avatarUrl,
            lastActiveAt: now,
          },
        });
        if (won.count !== 1) return raceOutcome(identity, target.id);
        const user = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
        return { ok: true, user, outcome: "linked" };
      }
      await prisma.microsoftIdentity.create({
        data: { userId: target.id, tenantId: identity.tenantId, objectId: identity.objectId },
      });
      const user = await prisma.user.update({ where: { id: target.id }, data: { lastActiveAt: now } });
      return { ok: true, user, outcome: "linked" };
    } catch (err) {
      // A concurrent first sign-in (a second tab) bound it a moment ago.
      if (isUniqueViolation(err)) return raceOutcome(identity, target.id);
      throw err;
    }
  }

  // 3. Nobody holds the address: a new account, bound in the same write.
  try {
    const user = await prisma.user.create({
      data: {
        email,
        displayName: profile.displayName || email.split("@")[0],
        avatarUrl: profile.avatarUrl ?? null,
        lastActiveAt: now,
        ...(identity.provider === "google"
          ? { googleId: identity.subject }
          : {
              microsoftIdentity: {
                create: { tenantId: identity.tenantId, objectId: identity.objectId },
              },
            }),
      },
    });
    return { ok: true, user, outcome: "created" };
  } catch (err) {
    if (isUniqueViolation(err)) return raceOutcome(identity, null);
    throw err;
  }
}

/** After a unique violation: succeed only if the identity is now bound to the
 *  account we meant to bind it to (or, on create, to any account it now names). */
async function raceOutcome(
  identity: FirstPartyIdentity,
  expectedUserId: string | null,
): Promise<FirstPartyResult> {
  const now = await findBound(identity);
  if (now && !now.deactivatedAt && (expectedUserId == null || now.id === expectedUserId)) {
    return { ok: true, user: now, outcome: "bound" };
  }
  return { ok: false, reason: "identity_conflict" };
}

export type ConnectRefusal =
  /** This provider identity is already bound to a different account. */
  | "identity_conflict"
  /** This account already has a different identity from this provider. */
  | "already_connected";

/**
 * Bind a provider identity to the signed-in account, by the person's explicit
 * request from that account (Profile, Sign-in methods). No email is consulted:
 * the person proved both sides, the session and the provider sign-in. The
 * caller decides whether the session may do this (connectSignInRefusal).
 */
export async function connectFirstPartyIdentity(
  userId: string,
  identity: FirstPartyIdentity,
): Promise<{ ok: true; outcome: "connected" | "already" } | { ok: false; reason: ConnectRefusal }> {
  const bound = await findBound(identity);
  if (bound) {
    return bound.id === userId ? { ok: true, outcome: "already" } : { ok: false, reason: "identity_conflict" };
  }
  try {
    if (identity.provider === "google") {
      const won = await prisma.user.updateMany({
        where: { id: userId, googleId: null },
        data: { googleId: identity.subject },
      });
      if (won.count === 1) return { ok: true, outcome: "connected" };
    } else {
      const existing = await prisma.microsoftIdentity.findUnique({ where: { userId }, select: { id: true } });
      if (!existing) {
        await prisma.microsoftIdentity.create({
          data: { userId, tenantId: identity.tenantId, objectId: identity.objectId },
        });
        return { ok: true, outcome: "connected" };
      }
    }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const now = await findBound(identity);
    if (now && now.id !== userId) return { ok: false, reason: "identity_conflict" };
    if (now) return { ok: true, outcome: "already" };
  }
  return { ok: false, reason: "already_connected" };
}
