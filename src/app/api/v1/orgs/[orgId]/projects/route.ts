import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requirePermission } from "@/lib/rbac/check";
import { getVisibleProjectIds } from "@/lib/rbac/project-access";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { revalidateOrgProjects } from "@/lib/cache/queries";
import { getEntitlements, isSectorEnabled } from "@/lib/entitlements";
import { seedSectorFields } from "@/lib/custom-fields/seed-sector-fields";
import { DEFAULT_COLUMNS } from "@/lib/boards/default-columns";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { cursorPage } from "@/lib/openapi/paginate";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { createProject, listProjects } from "./route.contract";
import { seedBoardColumns } from "@/lib/workflow/provision.server";
import { idempotent } from "@/lib/openapi/idempotency";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listProjects);
    const { params: p, query } = await parseRequest(listProjects, request, params);
    requirePermission(ctx, Permission.PROJECT_READ);

    // `1`/`0` as well as `true`/`false`: callers used to be able to send either.
    const archived = query.archived === "true" || query.archived === "1";

    // Visibility is decided BEFORE paging and goes into the WHERE. Filtering
    // after the fetch (as this route used to) let a hidden project end a page,
    // and the cursor is built from a page's last row, so its id and createdAt
    // went out in `Link` / `Cosmos-Next-Cursor` to exactly the caller it is
    // hidden from. In the WHERE, pages are also full.
    //
    // getVisibleProjectIds works on ids (it resolves memberships once and
    // short-circuits when nothing in the set is restricted), so it gets the
    // org's candidates first: an id-only query over one org's projects.
    const candidates = await prisma.project.findMany({
      where: { orgId: p.orgId, archived },
      select: { id: true },
    });
    const visible = await getVisibleProjectIds(ctx, candidates.map((c) => c.id));

    const page = cursorPage<{ createdAt: Date; id: string }>({
      request, query,
      order: [
        { field: "createdAt", dir: "desc", type: "date" },
        { field: "id", dir: "desc", type: "string" },
      ],
    });
    const fetched = await prisma.project.findMany({
      where: { AND: [{ orgId: p.orgId, archived, id: { in: [...visible] } }, page.where] },
      include: {
        _count: { select: { boards: true, intervals: true, members: true } },
        // The template's sector scopes the New-issue Type picker to the types
        // belonging to this project, rather than every type in the org.
        projectTemplate: { select: { sector: true } },
      },
      orderBy: page.orderBy,
      take: page.take,
    });
    const { rows: projects, headers } = page.finish(fetched);

    // The projects this actor may not see were excluded in the WHERE above.
    // The list is where a restricted project leaks its existence, name, key and
    // counts to the people it is hidden from, so the result is narrowed again
    // here: the rule must not depend on one predicate staying exactly as written.
    return respond(
      listProjects,
      200,
      projects
        .filter((p) => visible.has(p.id))
        // Flatten the template relation to a bare `sector`, so the client reads
        // one field rather than reaching through a join it has no other use for.
        .map(({ projectTemplate, ...p }) => ({
          ...p,
          sector: projectTemplate?.sector ?? null,
        })),
      { headers },
    );
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, createProject);
    const { params: { orgId }, body: data } = await parseRequest(createProject, request, params);
    return await idempotent({ request, ctx, orgId, body: data }, async () => {
      requirePermission(ctx, Permission.PROJECT_CREATE);

      const existing = await prisma.project.findUnique({
        where: { orgId_key: { orgId, key: data.key } },
      });
      if (existing) {
        return problem(409, "conflict", "Project key already exists", { request });
      }

      // Optionally load the template
      type TemplateWithBoards = {
        id: string;
        isBuiltIn: boolean;
        orgId: string | null;
        sector: string;
        defaultConfig: unknown;
        boardTemplates: { id: string; name: string; boardType: string; sortOrder: number; defaultConfig: unknown }[];
      };
      let template: TemplateWithBoards | null = null;

      if (data.templateId) {
        const tpl = await prisma.projectTemplate.findUnique({
          where: { id: data.templateId },
          include: { boardTemplates: true },
        });
        if (!tpl) {
          return problem(404, "not_found", "Template not found", { request });
        }
        // Allow built-in templates or org-owned templates
        if (!tpl.isBuiltIn && tpl.orgId !== orgId) {
          return problem(404, "not_found", "Template not found", { request });
        }
        // Sector entitlement boundary: a tenant restricted to certain sectors
        // (e.g. an example vertical → AEC only) cannot instantiate a template from a disabled
        // sector even by POSTing its id directly — the listing filter is cosmetic
        // without this. 404 (not 403) to avoid revealing the template exists.
        const ent = await getEntitlements(orgId);
        if (!isSectorEnabled(ent, tpl.sector)) {
          return problem(404, "not_found", "Template not found", { request });
        }
        template = tpl;
      }

      const project = await prisma.$transaction(async (tx) => {
        // Extract enabledFeatures from template defaultConfig if available
        let enabledFeatures: string[] = [];
        if (template) {
          const cfg = template.defaultConfig as Record<string, unknown> | null;
          if (cfg && Array.isArray(cfg.enabledFeatures)) {
            enabledFeatures = cfg.enabledFeatures as string[];
          }
        }

        const proj = await tx.project.create({
          data: {
            orgId,
            name: data.name,
            key: data.key,
            description: data.description ?? null,
            projectTemplateId: template?.id ?? null,
            enabledFeatures,
          },
        });

        if (template && template.boardTemplates.length > 0) {
          // Create boards from template
          for (const bt of template.boardTemplates) {
            const boardCfg = bt.defaultConfig as Record<string, unknown> | null;
            const columns = (boardCfg && Array.isArray(boardCfg.columns))
              ? (boardCfg.columns as Array<{ name: string; key: string; color?: string; sortOrder?: number; category?: string }>)
              : null;

            const board = await tx.board.create({
              data: {
                orgId,
                projectId: proj.id,
                name: bt.name,
                type: bt.boardType as import("@prisma/client").BoardType,
                sortOrder: bt.sortOrder,
              },
            });

            await seedBoardColumns(
              tx,
              board,
              columns && columns.length > 0
                ? columns.map((col, idx) => ({
                    name: col.name,
                    key: col.key,
                    color: col.color,
                    sortOrder: col.sortOrder ?? idx,
                    category: col.category as import("@prisma/client").ColumnCategory | undefined,
                  }))
                : DEFAULT_COLUMNS,
            );
          }
        } else {
          // Default single board with default columns
          const board = await tx.board.create({
            data: {
              orgId,
              projectId: proj.id,
              name: "Board",
              type: "KANBAN",
              sortOrder: 0,
            },
          });

          await seedBoardColumns(tx, board, DEFAULT_COLUMNS);
        }

        const orgMember = await tx.orgMember.findUnique({
          where: { orgId_userId: { orgId, userId: ctx.userId } },
        });

        if (orgMember) {
          await tx.projectMember.create({
            data: {
              projectId: proj.id,
              orgMemberId: orgMember.id,
              role: "MANAGER",
            },
          });
        }

        return tx.project.findUnique({
          where: { id: proj.id },
          include: {
            boards: { include: { columns: { orderBy: { sortOrder: "asc" } } } },
            _count: { select: { boards: true, intervals: true, members: true } },
          },
        });
      });

      logAudit({
        orgId,
        userId: ctx.userId,
        action: "project.created",
        entity: "project",
        entityId: project!.id,
        metadata: { name: data.name, key: data.key } as Record<string, string>,
        ipAddress: getIpAddress(request),
      }).catch(() => {});

      // Sector field set (FR 454637a9): creating from a sector template seeds
      // that sector's curated custom fields (org-scoped, idempotent by key — a
      // second project of the same sector is a no-op). Best-effort: a seeding
      // hiccup must never fail project creation.
      if (template?.sector) {
        await seedSectorFields(orgId, template.sector).catch(() => {});
      }

      revalidateOrgProjects(orgId);

      return respond(createProject, 201, project);
    });
  } catch (error) {
    return handleApiError(error, request);
  }
}
