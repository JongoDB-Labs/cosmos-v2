import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { HELD_WORK_ROLES, assertCanChangeCurrentAccess, heldBeyondRole } from "@/lib/rbac/grant-ceiling";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { SessionStatus } from "@prisma/client";

const revokeSessionsSchema = z.object({
  // When omitted, "revoke all" = the caller's OTHER sessions (not this device).
  sessionIds: z.array(z.string()).optional(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SESSION_MANAGE);

    const userId = request.nextUrl.searchParams.get("userId");
    const status = request.nextUrl.searchParams.get("status");

    // Sessions are created globally at login with no org context, so the
    // org-scoped SessionRecord is populated lazily here: record the caller's
    // current session on view so "Active Sessions" reflects reality instead of
    // showing empty while the user is plainly logged in. Idempotent upsert.
    const currentToken = request.cookies.get(SESSION_COOKIE)?.value ?? null;
    if (currentToken) {
      const live = await prisma.session.findUnique({
        where: { id: currentToken },
      });
      if (live && live.expiresAt > new Date()) {
        const ua = request.headers.get("user-agent");
        const ip = getIpAddress(request);
        await prisma.sessionRecord.upsert({
          where: { sessionToken: currentToken },
          create: {
            orgId,
            userId: ctx.userId,
            sessionToken: currentToken,
            ipAddress: ip,
            userAgent: ua,
            expiresAt: live.expiresAt,
          },
          update: {
            orgId,
            status: "ACTIVE",
            lastActiveAt: new Date(),
            ipAddress: ip,
            userAgent: ua,
          },
        });
      }
    }

    const sessions = await prisma.sessionRecord.findMany({
      where: {
        orgId,
        ...(userId ? { userId } : {}),
        ...(status ? { status: status as SessionStatus } : {}),
      },
      select: {
        id: true,
        orgId: true,
        userId: true,
        ipAddress: true,
        userAgent: true,
        status: true,
        lastActiveAt: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
        // Read only to mark the caller's own row; never sent. It is the value
        // of that person's sign-in cookie, so anyone who could read it could
        // be them, in every org they belong to. Revoking takes the record id.
        sessionToken: true,
      },
      orderBy: { lastActiveAt: "desc" },
    });

    return success(
      sessions.map(({ sessionToken, ...s }) => ({
        ...s,
        isCurrent: currentToken !== null && sessionToken === currentToken,
      })),
    );
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SESSION_MANAGE);

    const body = await request.json().catch(() => ({}));
    const data = revokeSessionsSchema.parse(body ?? {});

    const now = new Date();
    const currentToken = request.cookies.get(SESSION_COOKIE)?.value ?? null;

    // Specific sessions when given; otherwise revoke the caller's OTHER
    // sessions (never this device — that's what Logout is for).
    const where =
      data.sessionIds && data.sessionIds.length > 0
        ? { orgId, status: "ACTIVE" as SessionStatus, id: { in: data.sessionIds } }
        : {
            orgId,
            status: "ACTIVE" as SessionStatus,
            userId: ctx.userId,
            ...(currentToken ? { sessionToken: { not: currentToken } } : {}),
          };

    // Actually terminate the sessions: delete the global Session rows so the
    // revoked sessions stop authenticating (the record was only a status flag).
    const targets = await prisma.sessionRecord.findMany({
      where,
      select: { sessionToken: true, userId: true },
    });

    // The ceiling on current role: deleting a Session signs that person out of
    // every org, so the caller may revoke only the sessions of someone whose
    // access here (role, stored override and work roles) they could have
    // granted. Otherwise a member given SESSION_MANAGE by a work role could
    // sign an owner out everywhere. One refusal refuses the whole request,
    // before anything is deleted. See grant-ceiling.ts.
    const others = [...new Set(targets.map((t) => t.userId))].filter((id) => id !== ctx.userId);
    const members =
      others.length > 0
        ? await prisma.orgMember.findMany({
            where: { orgId, userId: { in: others }, removedAt: null },
            select: { userId: true, role: true, permissions: true, workRoles: HELD_WORK_ROLES },
          })
        : [];
    for (const m of members) assertCanChangeCurrentAccess(ctx, m.role, heldBeyondRole(m));

    // Only a current member's sign-in is ended everywhere. Someone removed from
    // this org, or never in it, may still belong to others, and nobody here
    // holds a role over them, so their session is only marked revoked here
    // (below). Without a membership they get no access here in any case.
    const membersHere = new Set([ctx.userId, ...members.map((m) => m.userId)]);
    const tokens = targets.filter((t) => membersHere.has(t.userId)).map((t) => t.sessionToken);
    if (tokens.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: tokens } } });
    }

    const result = await prisma.sessionRecord.updateMany({
      where,
      data: {
        status: "REVOKED",
        revokedAt: now,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "session.revoked",
      entity: "session_record",
      metadata: {
        revokedCount: String(result.count),
        sessionIds: data.sessionIds?.join(", ") ?? "others",
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success({ revokedCount: result.count });
  } catch (error) {
    return handleApiError(error);
  }
}
