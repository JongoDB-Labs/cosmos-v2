import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";
import { deleteUserAccount } from "@/lib/internal/delete-user";
import { handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

// PLATFORM-ADMIN account deletion. A global User account can span orgs, so a
// global delete is a SYSTEM-tier control (requireSystemAdmin / INTERNAL_ADMINS) —
// never a single org owner's self-service. Lives under /api/internal alongside
// the other platform-owner routes (orgs/plan, orgs/tenant-class).
//
// This does NOT hard-delete the row (see src/lib/internal/delete-user.ts for why:
// a RESTRICT FK on chat_bot_runs + required, FK-less authored-content columns
// make a raw delete either fail or orphan business/financial records). It
// ANONYMIZES the account in place, revokes all access, and frees the email.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ userId: string }> };

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { userId } = await params;

    // Gate: platform/system admin only.
    const admin = await requireSystemAdmin();
    if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    if (!UUID_RE.test(userId)) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, isBot: true, deactivatedAt: true },
    });
    if (!target) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Guard 1 — never delete your own account through this path (prevents
    // self-lockout of a platform admin; mirrors the members-table self guard).
    if (target.id === admin.id) {
      return NextResponse.json(
        { error: "You can't delete your own account." },
        { status: 403 },
      );
    }

    // Guard 2 — bot accounts are backed by a ChatBot (isBot=true) and are not
    // member-lifecycle accounts; anonymizing one would break chat. Out of scope.
    if (target.isBot) {
      return NextResponse.json(
        { error: "Bot accounts can't be deleted here." },
        { status: 400 },
      );
    }

    // Guard 3 — idempotency: already an anonymized tombstone.
    if (target.deactivatedAt) {
      return NextResponse.json(
        { error: "This account has already been deleted." },
        { status: 409 },
      );
    }

    // Guard 4 — never delete the SOLE OWNER of an org (that would orphan the org
    // with no owner). Ownership transfer is a separate, deliberate flow and is
    // out of scope here — block and tell the admin to transfer first.
    const ownerMemberships = await prisma.orgMember.findMany({
      where: { userId, role: "OWNER" },
      select: { orgId: true, org: { select: { name: true } } },
    });
    const soleOwnerOrgs: string[] = [];
    for (const m of ownerMemberships) {
      const ownerCount = await prisma.orgMember.count({
        where: { orgId: m.orgId, role: "OWNER" },
      });
      if (ownerCount <= 1) soleOwnerOrgs.push(m.org.name);
    }
    if (soleOwnerOrgs.length > 0) {
      return NextResponse.json(
        {
          error:
            `This user is the only owner of ${soleOwnerOrgs.join(", ")}. ` +
            "Transfer ownership to another member before deleting the account.",
        },
        { status: 409 },
      );
    }

    // Capture the orgs the user belonged to BEFORE deletion so each tenant's
    // audit trail records the offboarding (audit_logs.org_id is required).
    const memberships = await prisma.orgMember.findMany({
      where: { userId },
      select: { orgId: true },
    });
    const affectedOrgIds = [...new Set(memberships.map((m) => m.orgId))];

    const result = await deleteUserAccount({
      userId: target.id,
      email: target.email,
    });

    // One audit row per org the user was a member of. Records the original email
    // (the offboarded identity) and the revocation counts.
    const metadata: Record<string, string> = {
      targetUserId: target.id,
      targetEmail: result.originalEmail,
      by: "platform_admin",
      method: "anonymize",
      sessionsRevoked: String(result.sessionsRevoked),
      membershipsRemoved: String(result.membershipsRemoved),
      invitationsRemoved: String(result.invitationsRemoved),
      allowlistEntriesRemoved: String(result.allowlistEntriesRemoved),
    };
    const ipAddress = getIpAddress(request);
    await Promise.all(
      affectedOrgIds.map((orgId) =>
        logAudit({
          orgId,
          userId: admin.id,
          action: "user.account_deleted",
          entity: "user",
          entityId: target.id,
          metadata,
          ipAddress,
        }),
      ),
    );

    return NextResponse.json({
      deactivated: true,
      // `email` is the freed original address (alias of result.originalEmail) so
      // the UI can confirm which address is now invitable again.
      email: result.originalEmail,
      ...result,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
