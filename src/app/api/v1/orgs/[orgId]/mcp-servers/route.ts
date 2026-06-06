import { NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db/client";
import { sealMcpJson } from "@/lib/integrations/mcp-secrets";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import {
  success,
  created,
  handleApiError,
  getIpAddress,
} from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

// Transport-aware schema. We require `command` for stdio and `url` for
// http/sse. Zod's discriminated unions don't play nicely with `superRefine`
// here because the rest of the columns overlap, so we use a single object
// with a refinement instead.
const createMcpServerSchema = z
  .object({
    name: z.string().min(1).max(200),
    transport: z.enum(["stdio", "http", "sse"]),
    command: z.string().min(1).max(500).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    url: z.string().url().max(1000).optional(),
    headers: z.record(z.string(), z.string()).default({}),
    enabled: z.boolean().default(true),
  })
  .superRefine((val, ctx) => {
    if (val.transport === "stdio") {
      if (!val.command || !val.command.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "command is required for stdio transport",
          path: ["command"],
        });
      }
    } else if (val.transport === "http" || val.transport === "sse") {
      if (!val.url || !val.url.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "url is required for http/sse transport",
          path: ["url"],
        });
      }
    }
  });

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const servers = await prisma.mcpServer.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
    });

    return success(servers);
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
    requirePermission(ctx, Permission.MCP_MANAGE);

    const body = await request.json();
    const data = createMcpServerSchema.parse(body);

    const server = await prisma.mcpServer.create({
      data: {
        orgId,
        name: data.name,
        transport: data.transport,
        command: data.command ?? null,
        args: data.args,
        // env/headers (API tokens / auth headers) are SEALED at rest (3.13.16):
        // the *_enc columns hold the vault envelope of JSON.stringify(map).
        envEnc: sealMcpJson(data.env),
        url: data.url ?? null,
        headersEnc: sealMcpJson(data.headers),
        enabled: data.enabled,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "mcp_server.created",
      entity: "mcpServer",
      entityId: server.id,
      metadata: {
        name: data.name,
        transport: data.transport,
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(server);
  } catch (error) {
    return handleApiError(error);
  }
}
