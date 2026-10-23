/**
 * Legacy filter shapes → CqlQuery, losslessly.
 *
 * `fromWorkItemFilter` upgrades every existing saved view, Issues URL and API
 * body; the dark-ship parity check (parity.server.ts) runs both builders on
 * real traffic and logs any difference before the old one is retired. Pure.
 *
 * Mapping notes:
 *   - legacy `text` searched title OR description (not comments), so it maps to
 *     `summary ~ t OR description ~ t`, not to CQL's wider `text ~`.
 *   - an empty `parent: {mode:"is", parentIds: []}` matched nothing; so does
 *     its translation.
 *   - `archived: "all"` becomes `archived = true OR archived = false`, which
 *     mentions archiving (so the active-only default is not injected) and
 *     restricts nothing.
 */
import { CQL_VERSION, type CqlNode, type CqlQuery, type CqlSort, type CqlValue, type FieldRef, type RefEntity } from "./ast";
import type { WorkItemFilter, WorkItemSort } from "@/lib/work-items/query/filter";
import { NO_INTERVAL, UNASSIGNED } from "@/lib/work-items/query/filter";

const sys = (id: Extract<FieldRef, { kind: "sys" }>["id"]): FieldRef => ({ kind: "sys", id });
const ref = (entity: RefEntity, id: string): CqlValue => ({ t: "ref", entity, id });
const clean = (v: string[] | undefined) => [...new Set((v ?? []).filter((x) => typeof x === "string" && x.length > 0))];

function inList(field: FieldRef, values: CqlValue[]): CqlNode {
  return { op: "in", field, values };
}

function range(field: FieldRef, r: { from?: string; to?: string } | undefined): CqlNode[] {
  if (!r) return [];
  const out: CqlNode[] = [];
  const valid = (s: string | undefined) => !!s && !Number.isNaN(new Date(s).getTime());
  if (valid(r.from)) out.push({ op: "cmp", field, cmp: "gte", value: { t: "date", v: r.from! } });
  if (valid(r.to)) out.push({ op: "cmp", field, cmp: "lte", value: { t: "date", v: r.to! } });
  return out;
}

const NOTHING: CqlNode = {
  op: "and",
  args: [
    { op: "empty", field: sys("parent") },
    { op: "empty", field: sys("parent"), negate: true },
  ],
};

export function fromWorkItemFilter(f: WorkItemFilter, sort?: WorkItemSort): CqlQuery {
  const parts: CqlNode[] = [];

  const projectIds = clean(f.projectIds);
  if (projectIds.length) parts.push(inList(sys("project"), projectIds.map((id) => ref("project", id))));

  if (f.archived === "only") parts.push({ op: "cmp", field: sys("archived"), cmp: "eq", value: { t: "bool", v: true } });
  if (f.archived === "all") {
    parts.push({
      op: "or",
      args: [
        { op: "cmp", field: sys("archived"), cmp: "eq", value: { t: "bool", v: true } },
        { op: "cmp", field: sys("archived"), cmp: "eq", value: { t: "bool", v: false } },
      ],
    });
  }

  const ids = clean(f.ids);
  if (ids.length) parts.push(inList(sys("key"), ids.map((id) => ref("item", id))));

  const types = clean(f.typeIds);
  if (types.length) parts.push(inList(sys("type"), types.map((id) => ref("type", id))));

  const columns = clean(f.columnKeys);
  if (columns.length) parts.push(inList(sys("status"), columns.map((key) => ref("status", key))));

  if (f.priorities?.length) {
    parts.push(inList(sys("priority"), [...new Set(f.priorities)].map((p): CqlValue => ({ t: "str", v: p }))));
  }

  const assignees = clean(f.assigneeIds);
  if (assignees.length) {
    parts.push(
      inList(
        sys("assignee"),
        assignees.map((id): CqlValue => (id === UNASSIGNED ? { t: "empty" } : ref("user", id))),
      ),
    );
  }

  // Legacy labels are NAMES (the tags mirror); the resolver finds the Label rows.
  const labels = clean(f.labels);
  if (labels.length) parts.push(inList(sys("label"), labels.map((name): CqlValue => ({ t: "str", v: name }))));

  if (f.watchedByUserId) parts.push({ op: "cmp", field: sys("watcher"), cmp: "eq", value: ref("user", f.watchedByUserId) });

  const intervals = clean(f.intervalIds);
  if (intervals.length) {
    parts.push(
      inList(
        sys("sprint"),
        intervals.map((id): CqlValue => (id === NO_INTERVAL ? { t: "empty" } : ref("interval", id))),
      ),
    );
  }

  if (f.parent) {
    switch (f.parent.mode) {
      case "has_parent":
        parts.push({ op: "empty", field: sys("parent"), negate: true });
        break;
      case "no_parent":
        parts.push({ op: "empty", field: sys("parent") });
        break;
      case "is": {
        const parents = clean(f.parent.parentIds);
        parts.push(parents.length ? inList(sys("parent"), parents.map((id) => ref("item", id))) : NOTHING);
        break;
      }
      default:
        break;
    }
  }

  parts.push(...range(sys("start"), f.startDate));
  parts.push(...range(sys("due"), f.dueDate));
  parts.push(...range(sys("created"), f.createdAt));
  parts.push(...range(sys("updated"), f.updatedAt));

  const text = f.text?.trim();
  if (text) {
    parts.push({
      op: "or",
      args: [
        { op: "text", field: sys("summary"), query: text },
        { op: "text", field: sys("description"), query: text },
      ],
    });
  }

  for (const cf of f.customFields ?? []) {
    const key = cf.key?.trim();
    if (!key) continue;
    const field: FieldRef = { kind: "cf", key };
    if (cf.kind === "CHECKBOX") {
      parts.push({ op: "cmp", field, cmp: "eq", value: { t: "bool", v: cf.value === true } });
    } else if (typeof cf.value === "string" && cf.value !== "") {
      parts.push({ op: "cmp", field, cmp: "eq", value: { t: "str", v: cf.value } });
    }
  }

  const where: CqlNode | null = parts.length === 0 ? null : parts.length === 1 ? parts[0] : { op: "and", args: parts };
  const q: CqlQuery = { v: CQL_VERSION, where };
  const orderBy = sortFrom(sort);
  if (orderBy) q.orderBy = orderBy;
  return q;
}

function sortFrom(sort: WorkItemSort | undefined): CqlSort[] | undefined {
  if (!sort) return undefined;
  const id = (
    {
      priority: "priority",
      dueDate: "due",
      startDate: "start",
      ticketNumber: "key",
      updatedAt: "updated",
      createdAt: "created",
    } as const
  )[sort.field];
  return id ? [{ field: sys(id), dir: sort.direction === "asc" ? "asc" : "desc" }] : undefined;
}
