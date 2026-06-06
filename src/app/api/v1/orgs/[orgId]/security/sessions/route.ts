import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
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
      orderBy: { lastActiveAt: "desc" },
    });

    return success(
      sessions.map((s) => ({ ...s, isCurrent: s.sessionToken === currentToken })),
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
      select: { sessionToken: true },
    });
    const tokens = targets.map((t) => t.sessionToken);
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
