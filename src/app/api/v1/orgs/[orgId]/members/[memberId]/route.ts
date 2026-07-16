import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, noContent, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { publishToOrg } from "@/lib/realtime/broker";
import { z } from "zod";
import { OrgRole } from "@prisma/client";

const updateMemberSchema = z.object({
  role: z.nativeEnum(OrgRole),
});

type RouteParams = { params: Promise<{ orgId: string; memberId: string }> };

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, memberId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_MEMBERS);

    const member = await prisma.orgMember.findUnique({
      where: { id: memberId },
    });
    if (!member || member.orgId !== orgId) {
      return new Response("Not found", { status: 404 });
    }

    if (member.role === "OWNER" && ctx.orgRole !== "OWNER") {
      return new Response(
        JSON.stringify({ error: "Cannot modify the org owner" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await request.json();
    const data = updateMemberSchema.parse(body);

    // Only an OWNER may grant the OWNER role. Without this, an ADMIN holding
    // ORG_MANAGE_MEMBERS could promote anyone (incl. themselves) to OWNER and
    // gain the OWNER-only bits (ORG_DELETE, ORG_MANAGE_BILLING) — which also
    // breaks the assumption that bounds the work-role escalation model.
    if (data.role === "OWNER" && ctx.orgRole !== "OWNER") {
      return new Response(
        JSON.stringify({ error: "Only an owner can grant the owner role" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // You can't change your own role (prevents self-promotion and self-lockout).
    if (member.userId === ctx.userId) {
      return new Response(
        JSON.stringify({ error: "You can't change your own role" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const updated = await prisma.orgMember.update({
      where: { id: memberId },
      data: { role: data.role },
      select: {
        id: true,
        orgId: true,
        userId: true,
        role: true,
        joinedAt: true,
        user: {
          select: { id: true, email: true, displayName: true, avatarUrl: true },
        },
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "member.role_changed",
      entity: "org_member",
      entityId: memberId,
      metadata: { oldRole: member.role, newRole: data.role } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // Live-update the open members/roles views in this org (COSMOS-130).
    // Best-effort; org-scoped by the topic.
    try {
      publishToOrg(orgId, "member.updated", { orgId, memberId, role: data.role });
    } catch {
      /* never let a broker error break the update response */
    }

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, memberId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_MEMBERS);

    const member = await prisma.orgMember.findUnique({
      where: { id: memberId },
    });
    if (!member || member.orgId !== orgId) {
      return new Response("Not found", { status: 404 });
    }

    // You can't remove yourself (prevents self-lockout — mirrors the PUT guard).
    // Leaving an org is a separate, deliberate flow, not the admin members table.
    if (member.userId === ctx.userId) {
      return new Response(
        JSON.stringify({ error: "You can't remove yourself from the organization" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    if (member.role === "OWNER") {
      return new Response(
        JSON.stringify({ error: "Cannot remove the org owner" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    await prisma.orgMember.delete({ where: { id: memberId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "member.removed",
      entity: "org_member",
      entityId: memberId,
      metadata: { targetUserId: member.userId } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // Live-update the open members/roles views in this org (COSMOS-130).
    try {
      publishToOrg(orgId, "member.updated", { orgId, memberId, removed: true });
    } catch {
      /* never let a broker error break the delete response */
    }

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
