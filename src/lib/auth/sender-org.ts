import { prisma } from "@/lib/db/client";

/** Where the sending org came from — recorded in the operator log, never shown to the caller. */
export type SenderOrgSource = "named" | "membership" | "invitation";

export type SenderOrg = { id: string; slug: string; source: SenderOrgSource };

/**
 * Resolve which organisation's email configuration should send transactional mail
 * to an address.
 *
 * WHY THIS EXISTS: the obvious answer — "an org the user belongs to" — has a hole
 * exactly where it matters most. Someone who has been invited but has not yet
 * accepted belongs to NOTHING, so every reset for them resolved no org, fell
 * through to the deployment-wide env config, and failed wherever that is unset.
 * The people most likely to need a reset link (they have never signed in) were
 * the only people structurally guaranteed not to get one.
 *
 * A pending invitation is a perfectly good answer to "who is trying to reach this
 * person": an org asked for them by name and owns the address of record. So when
 * membership yields nothing we fall back to the org that invited them.
 *
 * Order matters. Membership beats invitation, because someone who has actually
 * joined should hear from the org they joined rather than one still courting
 * them. A named org (the login screen they came from) beats both, but only when
 * they really belong to it — otherwise `orgSlug` would be a way to ask any org to
 * send mail on your behalf.
 */
export async function resolveSenderOrg(params: {
  email: string;
  orgSlug?: string | null;
  memberships: { org: { id: string; slug: string } }[];
}): Promise<SenderOrg | null> {
  const orgs = params.memberships.map((m) => m.org);

  // Only ever honours a slug the user is actually a member of.
  const named = params.orgSlug ? orgs.find((o) => o.slug === params.orgSlug) : undefined;
  if (named) return { ...named, source: "named" };
  if (orgs[0]) return { ...orgs[0], source: "membership" };

  // No membership: fall back to whoever invited them, newest invitation first —
  // that is the org whose message they are most likely waiting on.
  const invitation = await prisma.invitation.findFirst({
    where: {
      email: { equals: params.email, mode: "insensitive" },
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: { org: { select: { id: true, slug: true } } },
  });
  if (invitation?.org) return { ...invitation.org, source: "invitation" };

  return null;
}
