import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { revalidateOrgProjects } from "@/lib/cache/queries";
import { getEntitlements, isSectorEnabled } from "@/lib/entitlements";
import { seedSectorFields } from "@/lib/custom-fields/seed-sector-fields";
import { z } from "zod";

const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  key: z.string().min(2).max(10).regex(/^[A-Z][A-Z0-9]*$/, "Key must be uppercase alphanumeric"),
  description: z.string().nullish(),
  templateId: z.string().uuid().nullish(),
  sector: z.string().nullish(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

const DEFAULT_COLUMNS = [
  { name: "Backlog", key: "backlog", color: "#94a3b8", sortOrder: 0, category: "TODO" as const },
  { name: "To Do", key: "todo", color: "#60a5fa", sortOrder: 1, category: "TODO" as const },
  { name: "In Progress", key: "in-progress", color: "#fbbf24", sortOrder: 2, category: "IN_PROGRESS" as const },
  { name: "Review", key: "review", color: "#a78bfa", sortOrder: 3, category: "IN_PROGRESS" as const },
  { name: "Done", key: "done", color: "#34d399", sortOrder: 4, category: "DONE" as const },
];

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_READ);

    const archived = request.nextUrl.searchParams.get("archived") === "true";

    const projects = await prisma.project.findMany({
      where: { orgId, archived },
      include: {
        _count: { select: { boards: true, intervals: true, members: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return success(projects);
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
    requirePermission(ctx, Permission.PROJECT_CREATE);

    const body = await request.json();
    const data = createProjectSchema.parse(body);

    const existing = await prisma.project.findUnique({
      where: { orgId_key: { orgId, key: data.key } },
    });
    if (existing) {
      return new Response(
        JSON.stringify({ error: "Project key already exists" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
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
        return new Response(
          JSON.stringify({ error: "Template not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
      // Allow built-in templates or org-owned templates
      if (!tpl.isBuiltIn && tpl.orgId !== orgId) {
        return new Response(
          JSON.stringify({ error: "Template not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
      // Sector entitlement boundary: a tenant restricted to certain sectors
      // (e.g. Pontis → AEC only) cannot instantiate a template from a disabled
      // sector even by POSTing its id directly — the listing filter is cosmetic
      // without this. 404 (not 403) to avoid revealing the template exists.
      const ent = await getEntitlements(orgId);
      if (!isSectorEnabled(ent, tpl.sector)) {
        return new Response(
          JSON.stringify({ error: "Template not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
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

          if (columns && columns.length > 0) {
            await tx.boardColumn.createMany({
              data: columns.map((col, idx) => ({
                boardId: board.id,
                name: col.name,
                key: col.key,
                color: col.color ?? "#7dd3fc",
                sortOrder: col.sortOrder ?? idx,
                category: (col.category as import("@prisma/client").ColumnCategory) ?? "TODO",
              })),
            });
          } else {
            await tx.boardColumn.createMany({
              data: DEFAULT_COLUMNS.map((col) => ({
                boardId: board.id,
                ...col,
              })),
            });
          }
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

        await tx.boardColumn.createMany({
          data: DEFAULT_COLUMNS.map((col) => ({
            boardId: board.id,
            ...col,
          })),
        });
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

    return created(project);
  } catch (error) {
    return handleApiError(error);
  }
}
