import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import {
  success,
  noContent,
  handleApiError,
  getIpAddress,
} from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

// PATCH allows partial updates without the transport-coupling check — we
// re-validate the resulting row's invariant (stdio→command, http/sse→url)
// against the merged record. If transport is being changed, the caller must
// also supply the matching identifier.
const patchMcpServerSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  transport: z.enum(["stdio", "http", "sse"]).optional(),
  command: z.string().max(500).nullable().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().max(1000).nullable().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

type RouteParams = {
  params: Promise<{ orgId: string; serverId: string }>;
};

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, serverId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const server = await prisma.mcpServer.findFirst({
      where: { id: serverId, orgId },
    });
    if (!server) return new Response("Not found", { status: 404 });

    return success(server);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, serverId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.MCP_MANAGE);

    const existing = await prisma.mcpServer.findFirst({
      where: { id: serverId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = patchMcpServerSchema.parse(body);

    // Compute the post-patch transport + identifiers and enforce the
    // stdio→command / http|sse→url invariant.
    const nextTransport = data.transport ?? existing.transport;
    const nextCommand =
      data.command !== undefined ? data.command : existing.command;
    const nextUrl = data.url !== undefined ? data.url : existing.url;
    if (nextTransport === "stdio" && (!nextCommand || !nextCommand.trim())) {
      return new Response(
        JSON.stringify({
          error: "command is required for stdio transport",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    if (
      (nextTransport === "http" || nextTransport === "sse") &&
      (!nextUrl || !nextUrl.trim())
    ) {
      return new Response(
        JSON.stringify({
          error: "url is required for http/sse transport",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const updated = await prisma.mcpServer.update({
      where: { id: serverId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.transport !== undefined && { transport: data.transport }),
        ...(data.command !== undefined && { command: data.command }),
        ...(data.args !== undefined && { args: data.args }),
        ...(data.env !== undefined && {
          env: data.env as Prisma.InputJsonValue,
        }),
        ...(data.url !== undefined && { url: data.url }),
        ...(data.headers !== undefined && {
          headers: data.headers as Prisma.InputJsonValue,
        }),
        ...(data.enabled !== undefined && { enabled: data.enabled }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "mcp_server.updated",
      entity: "mcpServer",
      entityId: serverId,
      metadata: { name: updated.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, serverId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.MCP_MANAGE);

    const existing = await prisma.mcpServer.findFirst({
      where: { id: serverId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.mcpServer.delete({ where: { id: serverId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "mcp_server.deleted",
      entity: "mcpServer",
      entityId: serverId,
      metadata: { name: existing.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
