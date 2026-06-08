import { prisma } from "@/lib/db/client";
import {
  IGNORE,
  parseDurationSeconds,
  type ImportRequest,
  type ImportReport,
  type ImportRowError,
  type PriorityValue,
  type TargetFieldId,
} from "./work-item-fields";

interface EngineCtx {
  orgId: string;
  projectId: string;
  userId: string;
}

/**
 * Valid targets for this org/project, loaded once and used to CLAMP every
 * client-supplied id — the wizard only offers legal options, but the API must
 * not trust the request (tenant isolation): an assignee must be an org member,
 * a type must belong to the org or be a built-in, a column must exist on the
 * project's boards.
 */
interface ValidSets {
  memberUserIds: Set<string>;
  typeIds: Set<string>;
  columnKeys: Set<string>;
  /**
   * Provenance + idempotency source, scoped PER PROJECT. The DB unique is
   * org-scoped (orgId, externalSource, externalId); encoding the projectId here
   * makes re-import idempotent per project and prevents a project-B re-import
   * from colliding with — or mutating — a project-A row, without a schema migration.
   */
  source: string;
}

async function loadValidSets(ctx: EngineCtx): Promise<ValidSets> {
  const [members, types, project] = await Promise.all([
    prisma.orgMember.findMany({
      where: { orgId: ctx.orgId },
      select: { userId: true },
    }),
    prisma.workItemType.findMany({
      where: { OR: [{ orgId: ctx.orgId }, { orgId: null, isBuiltIn: true }] },
      select: { id: true },
    }),
    prisma.project.findUnique({
      where: { id: ctx.projectId },
      select: { boards: { select: { columns: { select: { key: true } } } } },
    }),
  ]);
  const columnKeys = new Set<string>();
  for (const b of project?.boards ?? []) for (const c of b.columns) columnKeys.add(c.key);
  return {
    memberUserIds: new Set(members.map((m) => m.userId)),
    typeIds: new Set(types.map((t) => t.id)),
    columnKeys,
    source: `import:${ctx.projectId}`,
  };
}

interface NormalizedRow {
  rowNum: number;
  title: string;
  description: string;
  workItemTypeId: string | null;
  columnKey: string;
  sourceStatus: string | null;
  priority: PriorityValue;
  assigneeId: string | null;
  tags: string[];
  storyPoints: number | null;
  dueDate: Date | null;
  startDate: Date | null;
  externalKey: string | null;
  externalId: string | null;
  parentKey: string | null;
  originalEstimate: number | null;
  remainingEstimate: number | null;
  timeSpent: number | null;
  resolution: string | null;
  customFields: Record<string, string>;
  sourceRecord: Record<string, string>;
  error: string | null;
}

/** Strict integer parse — rejects hex/exponent/blank (Number() is too lenient). */
function num(raw: string): number | null {
  const v = raw.trim().replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(v)) return null;
  return Math.round(Number(v));
}

function date(raw: string): Date | null {
  const v = raw.trim();
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function splitTags(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function buildIndex(mapping: Record<string, string>): {
  first: Partial<Record<TargetFieldId, string>>;
  customHeaders: string[];
} {
  const first: Partial<Record<TargetFieldId, string>> = {};
  const customHeaders: string[] = [];
  for (const [header, target] of Object.entries(mapping)) {
    if (!target || target === IGNORE) continue;
    if (target === "custom") {
      customHeaders.push(header);
      continue;
    }
    const t = target as TargetFieldId;
    if (first[t] === undefined) first[t] = header;
  }
  return { first, customHeaders };
}

function normalizeRows(req: ImportRequest, sets: ValidSets): NormalizedRow[] {
  const { first, customHeaders } = buildIndex(req.mapping);
  const vm = req.valueMaps;
  const get = (row: Record<string, string>, t: TargetFieldId): string => {
    const h = first[t];
    return h ? (row[h] ?? "").toString().trim() : "";
  };

  // Clamp the defaults too (defense in depth — the page computes valid ones).
  const defType = sets.typeIds.has(req.defaults.workItemTypeId)
    ? req.defaults.workItemTypeId
    : null;
  const defColumn = req.defaults.columnKey;

  return req.rows.map((row, i) => {
    const rowNum = i + 1;
    const title = get(row, "title");

    const typeRaw = get(row, "type");
    const mappedType = typeRaw ? vm.type?.[typeRaw] : undefined;
    const workItemTypeId =
      mappedType && sets.typeIds.has(mappedType) ? mappedType : defType;

    const statusRaw = get(row, "status");
    const mappedColumn = statusRaw ? vm.status?.[statusRaw] : undefined;
    const columnKey =
      mappedColumn && sets.columnKeys.has(mappedColumn) ? mappedColumn : defColumn;

    const prioRaw = get(row, "priority");
    const priority: PriorityValue =
      (prioRaw && vm.priority?.[prioRaw]) || req.defaults.priority;

    const assigneeRaw = get(row, "assignee");
    const mappedAssignee = assigneeRaw ? vm.assignee?.[assigneeRaw] : undefined;
    const assigneeId =
      mappedAssignee && sets.memberUserIds.has(mappedAssignee) ? mappedAssignee : null;

    const customFields: Record<string, string> = {};
    for (const h of customHeaders) {
      const val = (row[h] ?? "").toString();
      if (val.trim() !== "") customFields[h] = val;
    }

    const error = !title
      ? "Missing title (Summary)"
      : !workItemTypeId
        ? "No valid work-item type"
        : null;

    return {
      rowNum,
      title,
      description: get(row, "description"),
      workItemTypeId,
      columnKey,
      sourceStatus: statusRaw || null,
      priority,
      assigneeId,
      tags: splitTags(get(row, "tags")),
      storyPoints: num(get(row, "storyPoints")),
      dueDate: date(get(row, "dueDate")),
      startDate: date(get(row, "startDate")),
      externalKey: get(row, "externalKey") || null,
      externalId: get(row, "externalId") || null,
      parentKey: get(row, "parentKey") || null,
      originalEstimate: parseDurationSeconds(get(row, "originalEstimate")),
      remainingEstimate: parseDurationSeconds(get(row, "remainingEstimate")),
      timeSpent: parseDurationSeconds(get(row, "timeSpent")),
      resolution: get(row, "resolution") || null,
      customFields,
      sourceRecord: { ...row },
      error,
    };
  });
}

async function existingExternalIds(
  ctx: EngineCtx,
  source: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const found = await prisma.workItem.findMany({
    where: {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      externalSource: source,
      externalId: { in: ids },
    },
    select: { externalId: true },
  });
  return new Set(found.map((f) => f.externalId).filter((x): x is string => !!x));
}

export async function runImport(
  ctx: EngineCtx,
  req: ImportRequest,
): Promise<ImportReport> {
  const sets = await loadValidSets(ctx);
  const normalized = normalizeRows(req, sets);
  const errors: ImportRowError[] = [];
  const valid: NormalizedRow[] = [];
  for (const n of normalized) {
    if (n.error) errors.push({ row: n.rowNum, message: n.error });
    else valid.push(n);
  }

  const mappedIds = valid.map((n) => n.externalId).filter((x): x is string => !!x);
  const existing = await existingExternalIds(ctx, sets.source, mappedIds);

  // Within-batch + against-DB classification with dedup: a externalId seen
  // earlier in THIS file (or already in the DB) routes to UPDATE, never a
  // second CREATE (which would hit the unique constraint).
  const seen = new Set(existing);
  let willCreate = 0;
  let willUpdate = 0;
  for (const n of valid) {
    if (n.externalId && seen.has(n.externalId)) willUpdate++;
    else {
      willCreate++;
      if (n.externalId) seen.add(n.externalId);
    }
  }

  const report: ImportReport = {
    total: normalized.length,
    willCreate,
    willUpdate,
    skipped: errors.length,
    errors: errors.slice(0, 200),
  };

  if (req.mode === "validate") return report;

  // ── commit ──
  const maxTicket = await prisma.workItem.aggregate({
    where: { orgId: ctx.orgId, projectId: ctx.projectId },
    _max: { ticketNumber: true },
  });
  let nextTicket = (maxTicket._max.ticketNumber ?? 0) + 1;

  const done = new Set(existing); // externalIds already materialized (DB + this run)
  const keyToId = new Map<string, string>(); // externalKey → item id (this run)
  let created = 0;
  let updated = 0;
  const commitErrors: ImportRowError[] = [];

  for (const n of valid) {
    const base = {
      title: n.title,
      description: n.description,
      columnKey: n.columnKey,
      workItemTypeId: n.workItemTypeId!,
      priority: n.priority,
      assigneeId: n.assigneeId,
      tags: n.tags,
      storyPoints: n.storyPoints,
      dueDate: n.dueDate,
      startDate: n.startDate,
      customFields: n.customFields,
      externalSource: sets.source,
      externalId: n.externalId,
      externalKey: n.externalKey,
      sourceStatus: n.sourceStatus,
      resolution: n.resolution,
      sourceRecord: n.sourceRecord,
      originalEstimate: n.originalEstimate,
      remainingEstimate: n.remainingEstimate,
      timeSpent: n.timeSpent,
    };
    try {
      let id: string;
      if (n.externalId && done.has(n.externalId)) {
        const up = await prisma.workItem.update({
          where: {
            orgId_externalSource_externalId: {
              orgId: ctx.orgId,
              externalSource: sets.source,
              externalId: n.externalId,
            },
          },
          data: base,
          select: { id: true },
        });
        id = up.id;
        updated++;
      } else {
        const cr = await prisma.workItem.create({
          data: {
            ...base,
            orgId: ctx.orgId,
            projectId: ctx.projectId,
            ticketNumber: nextTicket++,
            sortOrder: 0,
            columnEnteredAt: new Date(),
            createdById: ctx.userId,
          },
          select: { id: true },
        });
        id = cr.id;
        created++;
        if (n.externalId) done.add(n.externalId);
      }
      if (n.externalKey) keyToId.set(n.externalKey, id);
    } catch (e) {
      commitErrors.push({
        row: n.rowNum,
        message: e instanceof Error ? e.message : "Failed to import row",
      });
    }
  }

  // ── Pass 2: hierarchy. Resolve parentKey → id from this run, falling back to
  // a DB lookup (parents imported in a PRIOR run), with a batch cycle guard. ──
  const linkRows = valid.filter((n) => n.parentKey && n.externalKey);
  if (linkRows.length > 0) {
    // DB fallback for parent keys not created/updated in this run.
    const unresolved = Array.from(
      new Set(
        linkRows
          .map((n) => n.parentKey!)
          .filter((k) => !keyToId.has(k)),
      ),
    );
    if (unresolved.length > 0) {
      const dbParents = await prisma.workItem.findMany({
        where: {
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          externalSource: sets.source,
          externalKey: { in: unresolved },
        },
        select: { id: true, externalKey: true },
      });
      for (const p of dbParents) if (p.externalKey) keyToId.set(p.externalKey, p.id);
    }

    // Batch parentKey graph for cycle detection (childKey → parentKey).
    const parentOf = new Map<string, string>();
    for (const n of linkRows) parentOf.set(n.externalKey!, n.parentKey!);
    const createsCycle = (childKey: string, parentKey: string): boolean => {
      let cur: string | undefined = parentKey;
      const guard = new Set<string>();
      while (cur) {
        if (cur === childKey) return true;
        if (guard.has(cur)) return true;
        guard.add(cur);
        cur = parentOf.get(cur);
      }
      return false;
    };

    for (const n of linkRows) {
      const childId = keyToId.get(n.externalKey!);
      const parentId = keyToId.get(n.parentKey!);
      if (!childId || !parentId || childId === parentId) continue;
      if (createsCycle(n.externalKey!, n.parentKey!)) continue;
      try {
        await prisma.workItem.update({ where: { id: childId }, data: { parentId } });
      } catch {
        /* non-fatal: leave unparented if the link can't be set */
      }
    }
  }

  report.created = created;
  report.updated = updated;
  if (commitErrors.length) {
    report.errors = [...report.errors, ...commitErrors].slice(0, 200);
    report.skipped += commitErrors.length;
  }
  return report;
}
