import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canManageProject } from "@/lib/rbac/scope";
import { canReadProject } from "@/lib/rbac/project-access";
import { ForbiddenError } from "@/lib/rbac/check";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

/**
 * Teams within a project (#35). org -> projects -> teams -> members.
 *
 * Reading is gated like any other project-owned data. WRITING requires
 * canManageProject — org-wide PROJECT_MANAGE, or MANAGER of this project.
 * That is deliberately stricter than "can edit the project": once
 * teamScopedAccess is on, team membership decides who can see the project at
 * all, so editing teams is an access-control action.
 */

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  key: z.string().trim().max(20).nullish(),
});

async function resolve(orgId: string, projectId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return { ok: false as const, error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { ok: false as const, error: new Response("Unauthorized", { status: 401 }) };
  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId },
    select: { id: true },
  });
  if (!project) return { ok: false as const, error: new Response("Not found", { status: 404 }) };
  return { ok: true as const, ctx };
}

export async function GET(_request: NextRequest, { params }: RouteParams): Promise<Response> {
  try {
    const { orgId, projectId } = await params;
    const r = await resolve(orgId, projectId);
    if (!r.ok) return r.error;
    // Project-scoped: honours teamScopedAccess, so a member of a restricted
    // project cannot enumerate its teams from outside.
    if (!(await canReadProject(r.ctx, projectId))) throw new ForbiddenError();

    const teams = await prisma.team.findMany({
      where: { projectId },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        key: true,
        members: {
          select: {
            id: true,
            isLead: true,
            projectMemberId: true,
            projectMember: {
              select: {
                orgMember: {
                  select: {
                    userId: true,
                    // Explicit select — OrgMember.permissions is a permission
                    // mask and must never ride out in a payload.
                    user: { select: { displayName: true, email: true, avatarUrl: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    return success(
      teams.map((t) => ({
        id: t.id,
        name: t.name,
        key: t.key,
        members: t.members.map((m) => ({
          id: m.id,
          projectMemberId: m.projectMemberId,
          isLead: m.isLead,
          userId: m.projectMember.orgMember.userId,
          displayName: m.projectMember.orgMember.user.displayName,
          email: m.projectMember.orgMember.user.email,
          avatarUrl: m.projectMember.orgMember.user.avatarUrl,
        })),
      })),
    );
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams): Promise<Response> {
  try {
    const { orgId, projectId } = await params;
    const r = await resolve(orgId, projectId);
    if (!r.ok) return r.error;
    if (!(await canManageProject(r.ctx, projectId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: "A team needs a name." }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const { name, key } = parsed.data;

    // (projectId, name) is unique. Check first so a duplicate reads as a 409
    // the UI can explain, rather than a Prisma throw surfacing as a 500.
    const clash = await prisma.team.findFirst({
      where: { projectId, name },
      select: { id: true },
    });
    if (clash) {
      return new Response(
        JSON.stringify({ error: "A team with that name already exists in this project." }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }

    const team = await prisma.team.create({
      data: { orgId, projectId, name, key: key || null },
      select: { id: true, name: true, key: true },
    });

    await logAudit({
      orgId,
      userId: r.ctx.userId,
      action: "project_team.create",
      entity: "project",
      entityId: projectId,
      metadata: { teamId: team.id, name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created({ ...team, members: [] });
  } catch (e) {
    return handleApiError(e);
  }
}
