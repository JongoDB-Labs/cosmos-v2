import { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission, ConflictError } from "@/lib/rbac/check";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError } from "@/lib/api-helpers";
import { slugify } from "@/lib/templates/slugify";
import { sealMcpJson } from "@/lib/integrations/mcp-secrets";

/**
 * Foreman MCP servers manager: add/manage remote (http/https ONLY — no local
 * commands, that's RCE) MCP servers the build agent can reach. Mirrors
 * foreman/skills/route.ts's gate/scope idiom exactly. Servers are either
 * project-wide (`orgId: null`, wired into every org's builds) or org-scoped
 * (`orgId`) — GET lists both, POST creates one scoped by the caller's
 * `orgScope` choice. Postgres treats NULL as distinct in the
 * `@@unique([orgId, name])` index, so project-scope uniqueness is enforced
 * here in app code (same as skills).
 */
type RouteParams = { params: Promise<{ orgId: string }> };

function unprocessable(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 422,
    headers: { "Content-Type": "application/json" },
  });
}

async function gate(
  params: RouteParams["params"],
): Promise<{ orgId: string; userId: string } | { error: Response }> {
  const { orgId } = await params;
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, slug: true },
  });
  if (!org) return { error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { error: new Response("Unauthorized", { status: 401 }) };
  requirePermission(ctx, Permission.ORG_MANAGE_SETTINGS);
  return { orgId, userId: ctx.userId };
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const g = await gate(params);
    if ("error" in g) return g.error;
    const servers = await prisma.foremanMcpServer.findMany({
      where: { OR: [{ orgId: null }, { orgId: g.orgId }] },
      orderBy: [{ orgId: "asc" }, { name: "asc" }],
      select: {
        id: true,
        orgId: true,
        name: true,
        url: true,
        enabled: true,
      },
    });
    // NEVER select/return `headers` here — it's the sealed secret column.
    return success({ servers });
  } catch (error) {
    return handleApiError(error);
  }
}

const HTTP_URL_RE = /^https?:\/\//i;

const postSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  orgScope: z.boolean(),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const g = await gate(params);
    if ("error" in g) return g.error;
    const input = postSchema.parse(await request.json());

    // Defense in depth even though z.string().url() catches most bad input:
    // no local/stdio commands — remote http(s) MCP servers only.
    if (!HTTP_URL_RE.test(input.url)) {
      return unprocessable(
        "Only remote http(s) MCP servers are allowed — no local commands.",
      );
    }

    const slug = slugify(input.name);
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
      return unprocessable("Could not derive a valid server name");
    }

    const scopedOrgId = input.orgScope ? g.orgId : null;
    // A project-wide MCP server (orgId null) is wired into EVERY org's builds ⇒
    // platform admin only.
    if (scopedOrgId === null && !(await requireSystemAdmin())) {
      return new Response("Only a platform admin can create a project-wide MCP server", {
        status: 403,
      });
    }
    const existing = await prisma.foremanMcpServer.findFirst({
      where: { orgId: scopedOrgId, name: slug },
    });
    if (existing) {
      throw new ConflictError(
        `A ${input.orgScope ? "org" : "project"} MCP server named "${slug}" already exists`,
      );
    }

    // The `headers` column is Json — a genuinely absent value must be the SQL
    // NULL sentinel `Prisma.DbNull`, not the JS `null` (which Prisma's Json
    // input type treats as ambiguous between "no row value" and "a JSON null").
    const sealedHeaders = sealMcpJson(input.headers ?? null);
    const server = await prisma.foremanMcpServer.create({
      data: {
        orgId: scopedOrgId,
        name: slug,
        url: input.url,
        headers: sealedHeaders === null ? Prisma.DbNull : sealedHeaders,
        createdById: g.userId,
      },
      select: { id: true, orgId: true, name: true, url: true, enabled: true },
    });
    // Never echo the sealed headers back, even right after create.
    return created(server);
  } catch (error) {
    return handleApiError(error);
  }
}
