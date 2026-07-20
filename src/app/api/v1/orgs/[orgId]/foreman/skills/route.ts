import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission, ConflictError } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError } from "@/lib/api-helpers";
import { slugify } from "@/lib/templates/slugify";
import { parseSkillMarkdown } from "@/lib/foreman/skill-import";

/**
 * Foreman skills manager: create/import build skills the build agent reads
 * every pass. Mirrors the foreman/supervisor route's gate idiom. Skills are
 * either project-wide (`orgId: null`, seeded/authored for all orgs) or
 * org-scoped (`orgId`) — GET lists both, POST creates one scoped by the
 * caller's `orgScope` choice. Postgres treats NULL as distinct in the
 * `@@unique([orgId, name])` index, so project-scope uniqueness is enforced
 * here in app code (see skill-import.ts's seed-script comment).
 */
type RouteParams = { params: Promise<{ orgId: string }> };

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
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
    const skills = await prisma.foremanSkill.findMany({
      where: { OR: [{ orgId: null }, { orgId: g.orgId }] },
      orderBy: [{ orgId: "asc" }, { name: "asc" }],
      select: {
        id: true,
        orgId: true,
        name: true,
        description: true,
        enabled: true,
        source: true,
      },
    });
    return success({ skills });
  } catch (error) {
    return handleApiError(error);
  }
}

const postSchema = z.object({
  mode: z.enum(["create", "import"]),
  name: z.string().optional(),
  description: z.string().optional(),
  body: z.string().min(1),
  orgScope: z.boolean(),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const g = await gate(params);
    if ("error" in g) return g.error;
    const input = postSchema.parse(await request.json());

    let name: string;
    let description: string;
    let body: string;
    if (input.mode === "import") {
      const parsed = parseSkillMarkdown(input.body);
      name = parsed.name;
      description = parsed.description;
      body = parsed.body;
    } else {
      if (!input.name || !input.description) {
        return badRequest("name and description are required for mode:create");
      }
      name = input.name;
      description = input.description;
      body = input.body;
    }

    const slug = slugify(name);
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
      return badRequest("Could not derive a valid skill name");
    }

    const scopedOrgId = input.orgScope ? g.orgId : null;
    const existing = await prisma.foremanSkill.findFirst({
      where: { orgId: scopedOrgId, name: slug },
    });
    if (existing) {
      throw new ConflictError(`A ${input.orgScope ? "org" : "project"} skill named "${slug}" already exists`);
    }

    const skill = await prisma.foremanSkill.create({
      data: {
        orgId: scopedOrgId,
        name: slug,
        description,
        body,
        source: input.mode === "import" ? "imported" : "authored",
        createdById: g.userId,
      },
    });
    return created(skill);
  } catch (error) {
    return handleApiError(error);
  }
}
