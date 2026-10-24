/**
 * Moving items out of statuses their workflow no longer uses (design §8.3).
 *
 * A publish that drops a status, or an assignment that puts a type on a
 * workflow without some of its statuses, stores a map {from: to} on the
 * version or the assignment. Nothing else records that a migration is due:
 * the work is "items in this scope whose status the governing workflow doesn't
 * have", read from the data each time. So the job is resumable by
 * construction, a crash mid-way loses nothing, and running it twice is a no-op.
 *
 * Items move in batches through the change service as a MIGRATION: no
 * workflow checks (no transition can lead out of a status the workflow no
 * longer has), the status change's own consequences (dates, Activity) as for
 * any move, and no notifications, automations or webhooks.
 */
import { after } from "next/server";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { applyWorkItemChange } from "@/lib/work-items/apply-change.server";
import { workflowDefinitionSchema } from "@/lib/workflow/definition";
import type { MigrationMap } from "@/lib/workflow/versions.server";

type Db = PrismaClient | Prisma.TransactionClient;

const BATCH = 500;

export interface PendingMove {
  workItemTypeId: string | null;
  workflowId: string;
  from: string;
  /** Null when no map says where these items go. */
  to: string | null;
  items: number;
}

interface Scope {
  workItemTypeId: string | null;
  workflowId: string;
  actorId: string;
  statuses: ReadonlySet<string>;
  map: MigrationMap;
  where: Prisma.WorkItemWhereInput;
}

/**
 * Each assigned workflow's scope in a project, with the statuses it uses and
 * the map that applies to its items: the version's and the assignment's,
 * the more recent winning where both name a status.
 */
async function scopes(db: Db, projectId: string): Promise<Scope[]> {
  const rows = await db.workflowAssignment.findMany({
    where: { projectId },
    select: {
      workItemTypeId: true,
      migrationMap: true,
      assignedAt: true,
      workflow: {
        select: {
          id: true,
          createdById: true,
          publishedVersion: { select: { definition: true, migrationMap: true, publishedAt: true, publishedById: true } },
        },
      },
    },
  });
  const ownTypes = rows.flatMap((r) => (r.workItemTypeId ? [r.workItemTypeId] : []));
  return rows.flatMap((r): Scope[] => {
    const version = r.workflow.publishedVersion;
    if (!version) return [];
    const parsed = workflowDefinitionSchema.safeParse(version.definition);
    if (!parsed.success) return [];
    const versionMap = (version.migrationMap ?? {}) as MigrationMap;
    const assignmentMap = (r.migrationMap ?? {}) as MigrationMap;
    const assignmentNewer = !version.publishedAt || r.assignedAt > version.publishedAt;
    const map = assignmentNewer ? { ...versionMap, ...assignmentMap } : { ...assignmentMap, ...versionMap };
    return [
      {
        workItemTypeId: r.workItemTypeId,
        workflowId: r.workflow.id,
        actorId: version.publishedById ?? r.workflow.createdById,
        statuses: new Set(parsed.data.statuses.map((s) => s.key)),
        map,
        where: r.workItemTypeId
          ? { projectId, workItemTypeId: r.workItemTypeId }
          : ownTypes.length > 0
            ? { projectId, workItemTypeId: { notIn: ownTypes } }
            : { projectId },
      },
    ];
  });
}

/** Where `from` ends up: following the map until a status the workflow uses (a map can chain across publishes). */
function destination(scope: Scope, from: string): string | null {
  const seen = new Set<string>();
  let key: string | undefined = from;
  while (key !== undefined && !scope.statuses.has(key)) {
    if (seen.has(key)) return null;
    seen.add(key);
    key = scope.map[key];
  }
  return key ?? null;
}

/** The moves still to make in a project: what the editor shows as progress. */
export async function pendingMigrations(db: Db, projectId: string): Promise<PendingMove[]> {
  const out: PendingMove[] = [];
  for (const scope of await scopes(db, projectId)) {
    const groups = await db.workItem.groupBy({
      by: ["columnKey"],
      where: { ...scope.where, columnKey: { notIn: [...scope.statuses] } },
      _count: { _all: true },
    });
    for (const g of groups) {
      out.push({
        workItemTypeId: scope.workItemTypeId,
        workflowId: scope.workflowId,
        from: g.columnKey,
        to: destination(scope, g.columnKey),
        items: g._count._all,
      });
    }
  }
  return out;
}

/**
 * Make a project's pending moves, a batch per transaction. Returns how many
 * items moved; stops early when `signal` aborts (the next run carries on).
 */
export async function migrateProject(
  db: PrismaClient,
  args: { orgId: string; projectId: string; signal?: AbortSignal; batch?: number },
): Promise<number> {
  const batch = args.batch ?? BATCH;
  let moved = 0;
  for (const scope of await scopes(db, args.projectId)) {
    for (const from of Object.keys(scope.map)) {
      if (scope.statuses.has(from)) continue;
      const to = destination(scope, from);
      if (!to) continue;
      for (;;) {
        if (args.signal?.aborted) return moved;
        const ids = (
          await db.workItem.findMany({
            where: { ...scope.where, columnKey: from },
            select: { id: true },
            orderBy: { id: "asc" },
            take: batch,
          })
        ).map((r) => r.id);
        if (ids.length === 0) break;
        await db.$transaction((tx) =>
          applyWorkItemChange(tx, {
            actorId: scope.actorId,
            orgId: args.orgId,
            projectId: args.projectId,
            itemIds: ids,
            patch: { columnKey: to },
            source: "MIGRATION",
            actor: null,
          }),
        );
        moved += ids.length;
      }
    }
  }
  return moved;
}

/** The job: every project with a workflow map, until done or aborted. */
export async function runWorkflowMigrations(db: PrismaClient, opts: { signal?: AbortSignal } = {}) {
  const projects = await db.workflowAssignment.findMany({
    where: { OR: [{ migrationMap: { not: Prisma.DbNull } }, { workflow: { publishedVersion: { migrationMap: { not: Prisma.DbNull } } } }] },
    distinct: ["projectId"],
    select: { projectId: true, orgId: true },
  });
  let moved = 0;
  for (const p of projects) {
    if (opts.signal?.aborted) break;
    moved += await migrateProject(db, { orgId: p.orgId, projectId: p.projectId, signal: opts.signal });
  }
  return { projects: projects.length, moved };
}

/**
 * Start a project's moves once the response is sent, so a publish doesn't wait
 * on them. Outside a request (a script, a test) nothing starts: the periodic
 * job picks the work up from the data either way.
 */
export function startMigrations(orgId: string, projectId: string): void {
  try {
    after(() =>
      migrateProject(prisma, { orgId, projectId }).catch((e) => {
        console.error("[workflow-migrations] project %s: %s", projectId, e instanceof Error ? e.message : String(e));
      }),
    );
  } catch {
    // No request scope.
  }
}
