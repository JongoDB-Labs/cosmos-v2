import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { measureKeyResult, rollUpObjective } from "@/lib/okr/progress";
import { objectiveHealth } from "@/lib/okr/health";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { createObjective, listObjectives, reorderObjectives } from "./route.contract";
import { assertRefsInScope } from "@/lib/rbac/foreign-refs";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listObjectives);
    const { params: { orgId, projectId } } = await parseRequest(listObjectives, request, params);
    await requireProjectRead(ctx, projectId, "OKR_READ");

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!project) return problem(404, "not_found", undefined, { request });

    const objectives = await prisma.objective.findMany({
      where: { orgId, projectId },
      include: {
        keyResults: {
          orderBy: { sortOrder: "asc" },
          include: {
            links: {
              select: {
                workItem: {
                  select: { id: true, ticketNumber: true, title: true, columnKey: true, completedAt: true },
                },
              },
            },
          },
        },
        // #52 — the delivery this objective is tracked against.
        links: {
          orderBy: { createdAt: "asc" },
          select: {
            workItem: {
              select: {
                id: true,
                ticketNumber: true,
                title: true,
                columnKey: true,
                completedAt: true,
                workItemTypeId: true,
              },
            },
          },
        },
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });

    // FR a94ff583: a Key Result with linked tickets AUTO-tracks — its current
    // value becomes the count of its linked tickets that are done, and its
    // target the count of linked tickets unless someone set one. The objective
    // rolls up from the measured KRs (or, with none, from its own links), and
    // health is derived from that progress vs. the objective's target date.
    // Cosmo, dashboards and goals read the same rule (lib/okr).
    const shaped = objectives.map((o) => {
      const measured = o.keyResults.map((kr) => {
        const linkedItems = kr.links.map((l) => l.workItem);
        return { kr, linkedItems, m: measureKeyResult(kr, linkedItems) };
      });
      // #52 — the work items this objective is delivered by. Key results still
      // win the roll-up; these only speak for an objective that has none, which
      // previously reported a permanent 0.
      const linkedItems = o.links.map((l) => l.workItem);
      const roll = rollUpObjective(measured.map(({ m }) => m), linkedItems);
      return {
        ...o,
        links: undefined,
        keyResults: measured.map(({ kr, linkedItems: krItems, m }) => ({
          ...kr,
          links: undefined,
          currentValue: m.currentValue,
          targetValue: m.targetValue,
          autoTracked: m.autoTracked,
          targetFromLinks: m.targetFromLinks,
          linkedTotal: m.linkedTotal,
          linkedDone: m.linkedDone,
          linkedItems: krItems,
        })),
        progress: roll.progress,
        // `autoTracked` mirrors the KR vocabulary: the number is derived from
        // delivery rather than typed in.
        autoTracked: roll.autoTracked,
        linkedTotal: roll.linkedTotal,
        linkedDone: roll.linkedDone,
        linkedItems,
        health: objectiveHealth(roll.progress, o.targetDate, o.status, o.createdAt),
      };
    });

    return respond(listObjectives, 200, shaped);
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, createObjective);
    const { params: { orgId, projectId }, body: data } = await parseRequest(createObjective, request, params);
    await requireProjectVisible(ctx, projectId);
    await requireProjectManage(ctx, projectId, Permission.OKR_CREATE);

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!project) return problem(404, "not_found", undefined, { request });

    // An interval from ANOTHER project would silently mis-file the objective
    // under a timebox its team never plans against, so it is rejected rather
    // than quietly dropped.
    if (data.intervalId) {
      const interval = await prisma.interval.findFirst({
        where: { id: data.intervalId, projectId },
        select: { id: true },
      });
      if (!interval) {
        return problem(400, "invalid_request", "intervalId must be an interval of this project", { request });
      }
    }

    // A parent objective is this project's, as on PUT.
    await assertRefsInScope({ orgId, projectId }, { objective: data.parentId });

    // Append to the end of the project's manual order.
    const last = await prisma.objective.findFirst({
      where: { orgId, projectId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const sortOrder = last ? last.sortOrder + 1 : 0;

    const created = await prisma.objective.create({
      data: {
        orgId,
        projectId,
        title: data.title,
        description: data.description ?? null,
        period: data.period ?? null,
        status: data.status,
        parentId: data.parentId ?? null,
        intervalId: data.intervalId ?? null,
        committed: data.committed,
        progress: 0,
        sortOrder,
      },
      include: { keyResults: { orderBy: { sortOrder: "asc" } } },
    });

    return respond(createObjective, 200, created);
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, reorderObjectives);
    const { params: { orgId, projectId }, body: { orderedIds } } = await parseRequest(reorderObjectives, request, params);
    await requireProjectVisible(ctx, projectId);
    await requireProjectManage(ctx, projectId, Permission.OKR_UPDATE);

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!project) return problem(404, "not_found", undefined, { request });

    // Only renumber ids that genuinely belong to this project.
    const owned = await prisma.objective.findMany({
      where: { orgId, projectId, id: { in: orderedIds } },
      select: { id: true },
    });
    const ownedSet = new Set(owned.map((o) => o.id));

    await prisma.$transaction(
      orderedIds
        .filter((id) => ownedSet.has(id))
        .map((id, index) =>
          prisma.objective.update({ where: { id }, data: { sortOrder: index } }),
        ),
    );

    return respond(reorderObjectives, 200, { reordered: ownedSet.size });
  } catch (e) {
    return handleApiError(e, request);
  }
}
