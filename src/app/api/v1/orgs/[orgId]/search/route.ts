import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const q = request.nextUrl.searchParams.get("q");
    if (!q || q.trim().length === 0) {
      return success([]);
    }

    const searchTerm = q.trim();

    const [workItems, projects, crmContacts, notes] = await Promise.all([
      prisma.workItem.findMany({
        where: {
          orgId,
          title: { contains: searchTerm, mode: "insensitive" },
        },
        select: {
          id: true,
          title: true,
          ticketNumber: true,
          projectId: true,
        },
        take: 10,
        orderBy: { createdAt: "desc" },
      }),
      prisma.project.findMany({
        where: {
          orgId,
          name: { contains: searchTerm, mode: "insensitive" },
        },
        select: {
          id: true,
          name: true,
          key: true,
          archived: true,
        },
        take: 10,
        orderBy: { createdAt: "desc" },
      }),
      prisma.crmContact.findMany({
        where: {
          orgId,
          name: { contains: searchTerm, mode: "insensitive" },
        },
        select: {
          id: true,
          name: true,
          stage: true,
          dealValue: true,
        },
        take: 10,
        orderBy: { createdAt: "desc" },
      }),
      prisma.note.findMany({
        where: {
          orgId,
          title: { contains: searchTerm, mode: "insensitive" },
          OR: [
            { visibility: "ORG" },
            { visibility: "PROJECT" },
            { visibility: "PRIVATE", authorId: ctx.userId },
          ],
        },
        select: {
          id: true,
          title: true,
          visibility: true,
        },
        take: 10,
        orderBy: { createdAt: "desc" },
      }),
    ]);

    // Work items expose only projectId; resolve their project keys for URLs.
    const wiProjectIds = [...new Set(workItems.map((w) => w.projectId))];
    const wiProjects = wiProjectIds.length
      ? await prisma.project.findMany({
          where: { id: { in: wiProjectIds } },
          select: { id: true, key: true },
        })
      : [];
    const keyByProjectId = new Map(wiProjects.map((p) => [p.id, p.key]));

    // Flatten to the shape the command palette consumes:
    // { id, type, name, url }. (The palette builds its grouping client-side.)
    const results = [
      ...projects.map((p) => ({
        id: p.id,
        type: "project" as const,
        name: p.name,
        url: `/${org.slug}/projects/${p.key}`,
      })),
      ...workItems.map((w) => {
        const key = keyByProjectId.get(w.projectId) ?? "";
        return {
          id: w.id,
          type: "work_item" as const,
          name: `${key}-${w.ticketNumber} · ${w.title}`,
          url: `/${org.slug}/projects/${key}`,
        };
      }),
      ...crmContacts.map((c) => ({
        id: c.id,
        type: "contact" as const,
        name: c.name,
        url: `/${org.slug}/crm`,
      })),
      ...notes.map((n) => ({
        id: n.id,
        type: "note" as const,
        name: n.title,
        url: `/${org.slug}/notes`,
      })),
    ];
    return success(results);
  } catch (error) {
    return handleApiError(error);
  }
}
