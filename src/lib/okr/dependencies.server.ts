/**
 * Objective dependencies: "this objective needs that one done first".
 *
 * Not alignment. `Objective.parentId` says which objective this one rolls up
 * into, inside one project; a dependency says what has to land before it can,
 * and may point at another project's objective, because cross-team work is
 * where that question gets asked. It never points outside the org.
 *
 * One service for every surface (the REST route and Cosmo), so the rules hold
 * the same everywhere:
 *
 *   - the objective it points at must be in the caller's org and in a project
 *     the caller can see (`assertRefsInScope` with the viewer), and the caller
 *     must be allowed to read OKRs there;
 *   - never itself (also a CHECK constraint), and never a loop: the new edge is
 *     checked against every edge in the org under a per-org lock, so two
 *     concurrent writes can't each close half of one. The refusal says only
 *     that a loop would form, never which edge closes it: the path may run
 *     through objectives the writer can't see;
 *   - a read lists, and a delete reaches, only the dependencies on an
 *     objective the caller could open (a delete of any other is a 404, as for
 *     one that doesn't exist).
 *
 * The caller has already checked it may edit `objectiveId` (OKR_UPDATE on its
 * project); this service checks only what the edge points at.
 */
import { prisma } from "@/lib/db/client";
import { ProblemError } from "@/lib/openapi/problem";
import { ForbiddenError, type AuthContext } from "@/lib/rbac/check";
import { requireAccess } from "@/lib/abac/require-access";
import { assertRefsInScope, refMessage } from "@/lib/rbac/foreign-refs";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { wouldCreateCycle } from "./dependency-graph";
import { isOverdue, objectiveHealth, type ObjectiveHealth } from "./health";
import { LIVE_PROGRESS_SELECT, liveProgressOf } from "./rollup.server";

/** pg_advisory_xact_lock namespace: one dependency write per org at a time. */
const DEPENDENCY_LOCK_NAMESPACE = 20210;

export const SELF_DEPENDENCY = "An objective can't depend on itself.";
export const DEPENDENCY_LOOP = "This would create a loop of dependencies.";

export interface ObjectiveDependencyRow {
  id: string;
  orgId: string;
  objectiveId: string;
  dependsOnId: string;
  createdAt: Date;
}

/** What an objective depends on, as its card shows it. */
export interface DependsOnSummary {
  id: string;
  title: string;
  projectId: string;
  status: string;
  targetDate: Date | null;
  progress: number;
  health: ObjectiveHealth;
  overdue: boolean;
}

const notFound = () => new ProblemError(404, "not_found");

/**
 * Refuse unless `dependsOnId` is an objective the caller may point at: in this
 * org, in a project the caller can see (`assertRefsInScope` with the viewer),
 * and one they may read OKRs in (the bit, and any rule that denies it there).
 * Another org's objective, a hidden project's, a denied one and a made-up id
 * all get the same 400, in the same words.
 */
async function assertReadableTarget(ctx: AuthContext, dependsOnId: string): Promise<void> {
  const orgId = ctx.orgId;
  await assertRefsInScope({ orgId, viewer: ctx }, { objective: dependsOnId });
  // Scoped above, so the primary-key lookup cannot reach another org.
  const target = await prisma.objective.findUniqueOrThrow({ where: { id: dependsOnId }, select: { projectId: true } });
  try {
    await requireAccess(ctx, "OKR_READ", { orgId, projectId: target.projectId });
  } catch (e) {
    if (e instanceof ForbiddenError) throw new ProblemError(400, "invalid_request", refMessage("objective", {}));
    throw e;
  }
}

/** Make `objectiveId` depend on `dependsOnId`. Idempotent. */
export async function createObjectiveDependency(
  ctx: AuthContext,
  objectiveId: string,
  dependsOnId: string,
): Promise<ObjectiveDependencyRow> {
  const orgId = ctx.orgId;
  const source = await prisma.objective.findFirst({ where: { id: objectiveId, orgId }, select: { id: true } });
  if (!source) throw notFound();
  if (objectiveId === dependsOnId) throw new ProblemError(400, "invalid_request", SELF_DEPENDENCY);

  await assertReadableTarget(ctx, dependsOnId);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DEPENDENCY_LOCK_NAMESPACE}::int, hashtext(${orgId}))`;
    const edges = await tx.objectiveDependency.findMany({
      where: { orgId },
      select: { objectiveId: true, dependsOnId: true },
    });
    if (wouldCreateCycle(edges, objectiveId, dependsOnId)) {
      throw new ProblemError(400, "invalid_request", DEPENDENCY_LOOP);
    }
    return tx.objectiveDependency.upsert({
      where: { objectiveId_dependsOnId: { objectiveId, dependsOnId } },
      create: { orgId, objectiveId, dependsOnId },
      update: {},
      select: { id: true, orgId: true, objectiveId: true, dependsOnId: true, createdAt: true },
    });
  });
}

/**
 * Drop the dependency, if there is one the caller could see. True when a row
 * was removed. The objective it points at passes the same check as when the
 * edge is added; one that doesn't (hidden from the caller, denied there, or in
 * no project of theirs) is left in place and answers false, as a missing edge
 * does, so a delete can't be used to learn which hidden edges exist.
 */
export async function deleteObjectiveDependency(
  ctx: AuthContext,
  objectiveId: string,
  dependsOnId: string,
): Promise<boolean> {
  try {
    await assertReadableTarget(ctx, dependsOnId);
  } catch (e) {
    if (e instanceof ProblemError && e.status === 400) return false;
    throw e;
  }
  const { count } = await prisma.objectiveDependency.deleteMany({
    where: { orgId: ctx.orgId, objectiveId, dependsOnId },
  });
  return count > 0;
}

/**
 * What each of `objectiveIds` depends on, keyed by objective id, with the live
 * progress and health the board shows. A dependency in a project the reader
 * can't read OKRs in is left out.
 */
export async function dependenciesOf(
  ctx: AuthContext,
  objectiveIds: readonly string[],
  now: number = Date.now(),
): Promise<Map<string, DependsOnSummary[]>> {
  const out = new Map<string, DependsOnSummary[]>();
  if (objectiveIds.length === 0) return out;
  const readable = await getReadableProjectIds(ctx, "OKR_READ");
  if (readable.length === 0) return out;
  const rows = await prisma.objectiveDependency.findMany({
    where: {
      orgId: ctx.orgId,
      objectiveId: { in: [...objectiveIds] },
      dependsOn: { orgId: ctx.orgId, projectId: { in: readable } },
    },
    orderBy: { createdAt: "asc" },
    select: {
      objectiveId: true,
      dependsOn: {
        select: {
          id: true, title: true, projectId: true, status: true, targetDate: true, createdAt: true,
          ...LIVE_PROGRESS_SELECT,
        },
      },
    },
  });
  for (const { objectiveId, dependsOn: d } of rows) {
    const progress = liveProgressOf(d);
    const summary: DependsOnSummary = {
      id: d.id,
      title: d.title,
      projectId: d.projectId,
      status: d.status,
      targetDate: d.targetDate,
      progress,
      health: objectiveHealth(progress, d.targetDate, d.status, d.createdAt, now),
      overdue: isOverdue(progress, d.targetDate, d.status, now),
    };
    const list = out.get(objectiveId);
    if (list) list.push(summary);
    else out.set(objectiveId, [summary]);
  }
  return out;
}
