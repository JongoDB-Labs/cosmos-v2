import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { getReadableProjectIds, runWorkItemQuery } from "@/lib/work-items/query";
import {
  serializeCosmosCsv,
  issueToCosmosItem,
  objectiveToCosmosItem,
  milestoneToCosmosItem,
  sprintToCosmosItem,
  type CosmosItem,
  type CosmosItemKind,
} from "@/lib/export/cosmos-schema";

type RouteParams = { params: Promise<{ orgId: string }> };

const ALL_KINDS: CosmosItemKind[] = ["issue", "objective", "milestone", "sprint"];

/** `?kinds=issue,sprint` → the requested subset (defaults to all). Unknown tokens ignored. */
function parseKinds(param: string | null): CosmosItemKind[] {
  if (!param) return ALL_KINDS;
  const requested = new Set(
    param
      .split(",")
      .map((s) => s.trim().toLowerCase())
      // tolerate plural aliases from a UI, e.g. "issues"
      .map((s) => (s.endsWith("s") ? s.slice(0, -1) : s)),
  );
  const picked = ALL_KINDS.filter((k) => requested.has(k));
  return picked.length ? picked : ALL_KINDS;
}

const csvHeaders = (slug: string) => ({
  "Content-Type": "text/csv; charset=utf-8",
  "Content-Disposition": `attachment; filename="cosmos-items-${slug}-${new Date()
    .toISOString()
    .slice(0, 10)}.csv"`,
});

/**
 * GET — export project items (issues, OKR objectives, milestones, sprints) as a
 * single CSV in the common Cosmos schema (see `@/lib/export/cosmos-schema`). One
 * `Kind` column discriminates the row types so all four live in one file, and
 * `?kinds=` narrows to a subset.
 *
 * Access: org-level export gate (`ORG_EXPORT`), then every kind is scoped to the
 * projects the actor may READ items from (`getReadableProjectIds`) — the same
 * RBAC seam the Issues export uses, so a user can never export items from a
 * project they can't see. Empty result → a valid header-only CSV; no row cap, so
 * large exports aren't truncated.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_EXPORT);

    // Bulk export is an exfil-shaped action — rate-limit like the other exporters.
    const limited = checkRateLimit(request, "export.cosmos.csv", ctx.userId, {
      capacity: 10,
      refillPerSecond: 0.2,
    });
    if (limited) return limited;

    const kinds = parseKinds(request.nextUrl.searchParams.get("kinds"));

    const allowedProjectIds = await getReadableProjectIds(ctx);
    if (allowedProjectIds.length === 0) {
      return new Response(serializeCosmosCsv([]), { status: 200, headers: csvHeaders(org.slug) });
    }

    // Resolve project names once (id → name) for the non-issue kinds; the issue
    // path resolves its own via runWorkItemQuery's projection.
    const projects = await prisma.project.findMany({
      where: { id: { in: allowedProjectIds } },
      select: { id: true, name: true },
    });
    const projectName = new Map(projects.map((p) => [p.id, p.name]));

    const items: CosmosItem[] = [];

    if (kinds.includes("issue")) {
      // Empty filter = every readable issue. pageSize is deliberately huge so the
      // export isn't silently truncated to one UI page.
      const { data } = await runWorkItemQuery({
        orgId,
        allowedProjectIds,
        filter: {},
        sort: undefined,
        page: 1,
        pageSize: 50_000,
      });
      for (const r of data) {
        items.push(
          issueToCosmosItem({
            id: r.id,
            ticketKey: r.ticketKey,
            title: r.title,
            typeName: r.type.name,
            columnKey: r.columnKey,
            priority: r.priority,
            assigneeName: r.assignee?.displayName ?? null,
            projectName: r.project.name,
            parentKey: r.parent?.ticketKey ?? null,
            storyPoints: r.storyPoints,
            tags: r.tags,
            startDate: r.startDate,
            dueDate: r.dueDate,
            completedAt: r.completedAt,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          }),
        );
      }
    }

    // Fetch objective/milestone rows first (in parallel), then resolve their
    // owner display names from the results. Both carry a bare ownerId (String,
    // no FK relation), so names come from one batched User lookup shared across
    // both — no per-row query.
    const [objectives, milestones] = await Promise.all([
      kinds.includes("objective")
        ? prisma.objective.findMany({
            where: { orgId, projectId: { in: allowedProjectIds } },
            orderBy: [{ projectId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
            select: {
              id: true,
              title: true,
              description: true,
              status: true,
              progress: true,
              ownerId: true,
              projectId: true,
              targetDate: true,
              createdAt: true,
              updatedAt: true,
              parent: { select: { title: true } },
            },
          })
        : Promise.resolve([]),
      kinds.includes("milestone")
        ? prisma.milestone.findMany({
            where: { orgId, projectId: { in: allowedProjectIds } },
            orderBy: [{ projectId: "asc" }, { sortOrder: "asc" }, { dueDate: "asc" }],
            select: {
              id: true,
              title: true,
              description: true,
              status: true,
              ownerId: true,
              projectId: true,
              dueDate: true,
              completedAt: true,
              createdAt: true,
              updatedAt: true,
            },
          })
        : Promise.resolve([]),
    ]);

    let ownerName = new Map<string, string>();
    const ownerIds = Array.from(
      new Set(
        [...objectives, ...milestones]
          .map((r) => r.ownerId)
          .filter((id): id is string => id != null),
      ),
    );
    if (ownerIds.length > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, displayName: true },
      });
      ownerName = new Map(users.map((u) => [u.id, u.displayName]));
    }

    for (const o of objectives) {
      items.push(
        objectiveToCosmosItem({
          id: o.id,
          title: o.title,
          description: o.description,
          status: o.status,
          progress: o.progress,
          ownerName: o.ownerId ? (ownerName.get(o.ownerId) ?? null) : null,
          projectName: projectName.get(o.projectId) ?? "",
          parentTitle: o.parent?.title ?? null,
          targetDate: o.targetDate,
          createdAt: o.createdAt,
          updatedAt: o.updatedAt,
        }),
      );
    }

    for (const m of milestones) {
      items.push(
        milestoneToCosmosItem({
          id: m.id,
          title: m.title,
          description: m.description,
          status: m.status,
          ownerName: m.ownerId ? (ownerName.get(m.ownerId) ?? null) : null,
          projectName: projectName.get(m.projectId) ?? "",
          dueDate: m.dueDate,
          completedAt: m.completedAt,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
        }),
      );
    }

    if (kinds.includes("sprint")) {
      const cycles = await prisma.cycle.findMany({
        where: { orgId, projectId: { in: allowedProjectIds } },
        orderBy: [{ projectId: "asc" }, { number: "asc" }],
        select: {
          id: true,
          name: true,
          cycleKind: true,
          status: true,
          goal: true,
          projectId: true,
          startDate: true,
          endDate: true,
          createdAt: true,
          parent: { select: { name: true } },
        },
      });
      for (const c of cycles) {
        items.push(
          sprintToCosmosItem({
            id: c.id,
            name: c.name,
            cycleKind: c.cycleKind,
            status: c.status,
            goal: c.goal,
            projectName: projectName.get(c.projectId) ?? "",
            parentName: c.parent?.name ?? null,
            startDate: c.startDate,
            endDate: c.endDate,
            createdAt: c.createdAt,
          }),
        );
      }
    }

    return new Response(serializeCosmosCsv(items), { status: 200, headers: csvHeaders(org.slug) });
  } catch (e) {
    return handleApiError(e);
  }
}
