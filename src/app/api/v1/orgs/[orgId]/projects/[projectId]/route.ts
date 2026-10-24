import { NextRequest } from "next/server";
import { withStatusCategories } from "@/lib/workflow/column-categories.server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { inKeyProjectScope, requirePermission } from "@/lib/rbac/check";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { canManageProject } from "@/lib/rbac/scope";
import { noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { revalidateOrgProjects } from "@/lib/cache/queries";
import { Prisma } from "@prisma/client";
import { isToggleableFeature } from "@/lib/project-features";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { getProject, updateProject } from "./route.contract";

// Project features that drive the optional board tabs (see board-tabs.tsx).
// Toggleable from Project Settings; validated here so only known flags persist.
// The list itself lives in @/lib/project-features so the settings UI and the org
// template editor validate against the same keys this route accepts — three
// hand-synced copies is what let "risk"/"decision"/"meeting_note" ship.
export { TOGGLEABLE_FEATURES } from "@/lib/project-features";

// `status` used to live in this JSON blob. The migration moved it to a column
// and removed the key; a client still round-tripping an old settings object
// would otherwise put it straight back, leaving a stale string sitting next to
// the column that superseded it. Dropped on write rather than rejected, since
// the caller is echoing what we once gave it, not asking for anything.
function stripLegacyKeys(settings: Record<string, unknown>): Record<string, unknown> {
  if (!("status" in settings)) return settings;
  const rest = { ...settings };
  delete rest.status;
  return rest;
}

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, getProject);
    const { params: { orgId, projectId } } = await parseRequest(getProject, request, params);
    await requireProjectRead(ctx, projectId, "PROJECT_READ");

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
      include: {
        boards: {
          include: { columns: { orderBy: { sortOrder: "asc" } } },
          orderBy: { sortOrder: "asc" },
        },
        intervals: { orderBy: { number: "desc" } },
        members: {
          include: {
            orgMember: {
              select: {
                id: true,
                role: true,
                user: {
                  select: { id: true, email: true, displayName: true, avatarUrl: true },
                },
              },
            },
          },
        },
        _count: { select: { boards: true, intervals: true, members: true } },
      },
    });

    if (!project) return problem(404, "not_found", undefined, { request });

    // Each status column's category is its status's (column-categories.server.ts).
    const boards = await withStatusCategories(prisma, projectId, project.boards);
    return respond(getProject, 200, { ...project, boards }, { ctx });
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, updateProject);
    const { params: { orgId, projectId }, body } = await parseRequest(updateProject, request, params);
    // Inheriting authority: an org-wide PROJECT_UPDATE holder OR a MANAGER of
    // THIS project may edit it — so a project-admin can run their own project
    // without org-wide grants.
    if (
      !hasPermission(ctx.permissions, Permission.PROJECT_UPDATE) &&
      !(await canManageProject(ctx, projectId, Permission.PROJECT_UPDATE))
    ) {
      return problem(403, "forbidden", undefined, { request });
    }

    const existing = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!existing) return problem(404, "not_found", undefined, { request });

    const data = {
      ...body,
      // Keep only the known toggleable features; see the contract.
      ...(body.enabledFeatures && { enabledFeatures: body.enabledFeatures.filter(isToggleableFeature) }),
    };

    // teamScopedAccess needs MORE than the gate above. That gate admits an
    // org-wide PROJECT_UPDATE holder, but this flag decides who can SEE the
    // project — flipping it on can hide a live project from everyone who is not
    // a member. Restrict it to the people who administer this project.
    if (data.teamScopedAccess !== undefined && !(await canManageProject(ctx, projectId, Permission.PROJECT_MANAGE))) {
      return problem(403, "forbidden", "Only a project manager or org admin can change who this project is visible to.", { request });
    }

    const updated = await prisma.project.update({
      where: { id: projectId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description ?? "" }),
        // MERGE settings (don't clobber): a partial patch like
        // `{ settings: { defaultBoardId } }` keeps every other setting intact.
        ...((data.settings !== undefined || data.disabledBoardTypes !== undefined) && {
          settings: stripLegacyKeys({
            ...((existing.settings as Record<string, unknown> | null) ?? {}),
            ...data.settings,
            ...(data.disabledBoardTypes !== undefined && {
              disabledBoardTypes: data.disabledBoardTypes,
            }),
          }) as Prisma.InputJsonValue,
        }),
        ...(data.clientId !== undefined && { clientId: data.clientId }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.archived !== undefined && { archived: data.archived }),
        ...(data.enabledFeatures !== undefined && { enabledFeatures: data.enabledFeatures }),
        ...(data.krLinkTypeId !== undefined && { krLinkTypeId: data.krLinkTypeId }),
        ...(data.objectiveLinkTypeId !== undefined && {
          objectiveLinkTypeId: data.objectiveLinkTypeId,
        }),
        ...(data.teamScopedAccess !== undefined && { teamScopedAccess: data.teamScopedAccess }),
      },
      include: {
        _count: { select: { boards: true, intervals: true, members: true } },
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "project.updated",
      entity: "project",
      entityId: projectId,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // Name change or archive toggle both affect the cached project list.
    revalidateOrgProjects(orgId);

    return respond(updateProject, 200, updated);
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return problem(404, "not_found", undefined, { request });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return problem(401, "unauthorized", undefined, { request });
    requirePermission(ctx, Permission.PROJECT_DELETE);
    // A project-scoped key can't delete a project outside its scope.
    if (!inKeyProjectScope(ctx, projectId)) return problem(403, "forbidden", "Access denied by policy", { request });

    const existing = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!existing) return problem(404, "not_found", undefined, { request });

    await prisma.project.delete({ where: { id: projectId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "project.deleted",
      entity: "project",
      entityId: projectId,
      metadata: { name: existing.name, key: existing.key } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    revalidateOrgProjects(orgId);

    return noContent();
  } catch (error) {
    return handleApiError(error, request);
  }
}
