import { prisma } from "@/lib/db/client";

/**
 * Platform-admin "delete a user account" — implemented as an in-place
 * ANONYMIZATION + full access revocation rather than a hard `user.delete`.
 *
 * WHY NOT A REAL ROW DELETE (see prisma/schema.prisma User.deactivatedAt):
 *   - `chat_bot_runs.triggered_by_user_id` is ON DELETE RESTRICT, so a raw delete
 *     FAILS at the database for anyone who ever triggered a chat-bot run;
 *   - the authored-content columns (`work_items.created_by_id`,
 *     `comments.author_id`, `notes.author_id`, `journal_lines`/`invoices`/
 *     `payments`/`time_entries.created_by_id`, `documents.uploaded_by_id`,
 *     `chat_messages.author_id`, …) are REQUIRED and carry NO foreign key, so a
 *     delete would silently ORPHAN business + financial records (dangling
 *     `createdById`s the app resolves back to a now-missing user).
 * A safe hard delete would need a large, invasive migration (nullable author FKs
 * across ~20 tables, or a reassign-to-system-user pass touching financial rows).
 * That is explicitly out of scope, so we take the non-destructive route.
 *
 * WHAT THIS DOES, in one transaction:
 *   1. Revokes every access + identity grant — deletes the user's Sessions
 *      (kills live logins), OrgMembers (cascades ProjectMember +
 *      OrgMemberWorkRole), FederatedIdentities (no SSO re-match), and
 *      PushSubscriptions; plus their AllowedEmail rows and any pending
 *      Invitations addressed to their email (so a stale grant can't re-admit
 *      them).
 *   2. Wipes credentials + presence and anonymizes the identity to a "Deleted
 *      user" tombstone, and FREES the email by rewriting it to an unroutable,
 *      per-user sentinel (`deleted-<id>@deleted.invalid`; `.invalid` is
 *      RFC-2606 reserved). The original address then resolves to NO User, so it
 *      can be invited fresh — including a brand-new email/password account.
 *
 * Authored business/financial content is deliberately LEFT attributed to the
 * anonymized tombstone user: no record is deleted or orphaned.
 *
 * Callers MUST enforce the guards first (platform-admin, not self, not the last
 * owner of any org, not a bot). This function performs no authorization.
 */
export type DeleteUserResult = {
  userId: string;
  originalEmail: string;
  sentinelEmail: string;
  sessionsRevoked: number;
  membershipsRemoved: number;
  federatedIdentitiesRemoved: number;
  pushSubscriptionsRemoved: number;
  allowlistEntriesRemoved: number;
  invitationsRemoved: number;
};

export async function deleteUserAccount(params: {
  userId: string;
  email: string;
}): Promise<DeleteUserResult> {
  const { userId } = params;
  const originalEmail = params.email;
  const emailLower = originalEmail.trim().toLowerCase();
  // `.invalid` is RFC-2606 reserved (never routable); the id keeps it unique so
  // it can never collide with another tombstone or a live address.
  const sentinelEmail = `deleted-${userId}@deleted.invalid`;

  return prisma.$transaction(async (tx) => {
    // 1) Revoke access + identity. Sequential (not Promise.all): an interactive
    // transaction runs on a single connection and can't service parallel queries.
    const sessions = await tx.session.deleteMany({ where: { userId } });
    const memberships = await tx.orgMember.deleteMany({ where: { userId } });
    const federatedIdentities = await tx.federatedIdentity.deleteMany({
      where: { userId },
    });
    const pushSubscriptions = await tx.pushSubscription.deleteMany({
      where: { userId },
    });
    const allowlistEntries = await tx.allowedEmail.deleteMany({
      where: { email: { equals: emailLower, mode: "insensitive" } },
    });
    const invitations = await tx.invitation.deleteMany({
      where: { email: { equals: emailLower, mode: "insensitive" } },
    });

    // 2) Neutralize credentials + presence, anonymize identity, free the email.
    await tx.user.update({
      where: { id: userId },
      data: {
        email: sentinelEmail,
        displayName: "Deleted user",
        avatarUrl: null,
        customStatus: null,
        customStatusEmoji: null,
        dndUntilAt: null,
        lastActiveAt: null,
        // Break every sign-in path onto this account.
        googleId: null,
        auth0UserId: null,
        passwordHash: null,
        passwordSetAt: null,
        mustChangePassword: false,
        mfaEnabled: false,
        mfaSecret: null,
        mfaRecoveryCodes: [],
        mfaEnrolledAt: null,
        mfaRequired: false,
        deactivatedAt: new Date(),
      },
    });

    return {
      userId,
      originalEmail,
      sentinelEmail,
      sessionsRevoked: sessions.count,
      membershipsRemoved: memberships.count,
      federatedIdentitiesRemoved: federatedIdentities.count,
      pushSubscriptionsRemoved: pushSubscriptions.count,
      allowlistEntriesRemoved: allowlistEntries.count,
      invitationsRemoved: invitations.count,
    };
  });
}
