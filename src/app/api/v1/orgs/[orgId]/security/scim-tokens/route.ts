import { NextRequest } from "next/server";
import { randomBytes, createHash } from "crypto";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const createTokenSchema = z.object({
  label: z.string().max(200).nullish(),
  expiresAt: z.string().datetime().nullish(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SCIM_MANAGE);

    const tokens = await prisma.scimToken.findMany({
      where: { orgId },
      select: {
        id: true,
        prefix: true,
        label: true,
        expiresAt: true,
        lastUsed: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return success(tokens);
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
    requirePermission(ctx, Permission.SCIM_MANAGE);

    const body = await request.json();
    const data = createTokenSchema.parse(body);

    const rawToken = randomBytes(32).toString("hex");
    const prefix = rawToken.substring(0, 8);
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    const token = await prisma.scimToken.create({
      data: {
        orgId,
        tokenHash,
        prefix,
        label: data.label ?? "",
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "scim_token.created",
      entity: "scim_token",
      entityId: token.id,
      metadata: { prefix } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created({
      id: token.id,
      token: rawToken,
      prefix: token.prefix,
      label: token.label,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
