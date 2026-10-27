/**
 * Names → ids, functions → sets, variables → values: the CQL resolver.
 *
 * EVERY lookup here is scoped. A project resolves only among the projects the
 * actor can read; a sprint, team, status or item only inside those projects; a
 * person only among the org's current members. Anything else gets the same
 * message as something that does not exist ("No sprint named 'X' that you can
 * see"), so a query cannot be used to probe for restricted work.
 *
 * The output is two things: the RESOLVED query (refs with labels, functions
 * kept symbolic: what gets stored and printed) and the CompileEnv the pure
 * compiler needs (what those functions and variables mean right now).
 *
 * Lookups are batched per entity, so a query costs a handful of queries however
 * many values it names.
 */
import type { Prisma } from "@prisma/client";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { isUuid } from "@/lib/ids";
import type { AuthContext } from "@/lib/rbac/check";
import {
  predValues,
  type CqlNode,
  type CqlQuery,
  type CqlValue,
  type FieldRef,
  type HistoryPreds,
  type LeafNode,
  type PredValue,
  type RefEntity,
} from "./ast";
import { fieldDef, type SystemFieldId } from "./fields";
import { lookupFunction } from "./functions";
import { HISTORY_BY_FIELD, fnKey, varKey, type CompileEnv, type StatusCategory } from "./env";
import { ID_SET_MAX, diag, tooBroad, type CqlDiagnostic, type Span } from "./errors";
import { withStatementTimeout } from "./timeout.server";
import type { CustomFieldType, SchemaCustomField } from "./typecheck";

/** A dashboard variable's value as a caller supplies it: ids/names, or nothing (= everyone). */
export type VarInput = string | number | boolean | null | undefined | (string | number | boolean)[];

export interface ResolveArgs {
  ctx: AuthContext;
  readable: string[];
  query: CqlQuery;
  customFields: SchemaCustomField[];
  text?: string;
  spans?: WeakMap<object, Span>;
  now: Date;
  tz: string;
  vars?: Record<string, VarInput>;
  /** Statement budget for the resolver's own id-set reads (hierarchy, milestones). */
  timeoutMs?: number;
  contextProjectId?: string;
  sinceLastStandup?: Date;
  /** "warn": unknown values are warnings and match nothing; "strict": errors. */
  mode?: "strict" | "warn";
}

export interface ResolveResult {
  query: CqlQuery;
  env: CompileEnv;
  diagnostics: CqlDiagnostic[];
}

type Ref = Extract<CqlValue, { t: "ref" }>;

/** Which entity a field's values name, if any. */
function entityOf(field: FieldRef, customFields: Map<string, CustomFieldType>): RefEntity | null {
  if (field.kind === "cf") return customFields.get(field.key) === "USER" ? "user" : null;
  const v = fieldDef(field.id).value;
  return v.kind === "ref" ? v.entity : null;
}

const ENTITY_WORD: Record<RefEntity, string> = {
  user: "person",
  project: "project",
  type: "work item type",
  status: "status",
  interval: "sprint",
  team: "team",
  label: "label",
  item: "item",
  milestone: "milestone",
};

const KEY_RE = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/;

/**
 * Entities that live inside a project. Their ids are only meaningful to a
 * viewer who can read that project, so stored refs to them are re-checked.
 * People, labels and types are org-wide: an item assigned to someone who has
 * since left is still that person's item.
 */
const SCOPED_REFS = new Set<RefEntity>(["project", "interval", "team", "item", "milestone"]);
/**
 * Stored refs that are re-checked against the ORG (not a project): a JSON
 * query (an API caller, a saved filter) could carry any id, and an id from
 * another org must match nothing rather than ride along with a forged label.
 * A person who has left is still found (their membership row remains).
 */
const RECHECKED_REFS = new Set<RefEntity>([...SCOPED_REFS, "user", "label", "type"]);

export async function resolveQuery(a: ResolveArgs): Promise<ResolveResult> {
  const text = a.text ?? "";
  const diagnostics: CqlDiagnostic[] = [];
  const at = (o: object | undefined) => (o && a.spans?.get(o)) || { from: 0, to: 0 };
  const readable = new Set(a.readable);
  const cfTypes = new Map(a.customFields.map((c) => [c.key, c.fieldType]));
  const orgId = a.ctx.orgId;

  // ── 1. Collect every literal that needs a lookup, per entity ──────────────
  const wanted: Record<RefEntity, Set<string>> = {
    user: new Set(), project: new Set(), type: new Set(), status: new Set(), interval: new Set(),
    team: new Set(), label: new Set(), item: new Set(), milestone: new Set(),
  };
  const varUses: { name: string; field: FieldRef; entity: RefEntity | null }[] = [];
  const fnArgEntity = (fn: string, i: number): RefEntity | null => {
    const def = lookupFunction(fn);
    const kind = def?.args[i]?.kind;
    return kind === "item" ? "item" : kind === "team" ? "team" : kind === "user" ? "user" : null;
  };
  const collect = (v: CqlValue, entity: RefEntity | null, field: FieldRef) => {
    if (v.t === "str" && entity) wanted[entity].add(v.v);
    // Stored refs are re-checked too (see SCOPED_REFS / RECHECKED_REFS).
    if (v.t === "ref" && RECHECKED_REFS.has(v.entity)) wanted[v.entity].add(v.id);
    if (v.t === "num" && entity === "item") wanted.item.add(String(v.v));
    if (v.t === "var") varUses.push({ name: v.name, field, entity });
    if (v.t === "fn") v.args.forEach((arg, i) => collect(arg, fnArgEntity(v.name, i), field));
  };
  /** A leaf's values, each with the field it is typed by: history's BY is people, its dates are no entity. */
  const leafParts = (l: LeafNode): { v: CqlValue; field: FieldRef | null }[] => {
    if (l.op === "cmp") return [{ v: l.value, field: l.field }];
    if (l.op === "in") return l.values.map((v) => ({ v, field: l.field }));
    if (l.op !== "was" && l.op !== "changed") return [];
    const p = l.preds ?? {};
    return [
      ...(l.op === "was" ? l.values : []).map((v) => ({ v, field: l.field })),
      ...[...predValues(p.from), ...predValues(p.to)].map((v) => ({ v, field: l.field })),
      ...predValues(p.by).map((v) => ({ v, field: HISTORY_BY_FIELD })),
      ...[p.after, p.before, p.on, ...(p.during ?? [])].filter((v): v is CqlValue => !!v).map((v) => ({ v, field: null })),
    ];
  };
  const leafValues = (l: LeafNode): CqlValue[] => leafParts(l).map((x) => x.v);
  const walk = (n: CqlNode | null, f: (l: LeafNode) => void) => {
    if (!n) return;
    if (n.op === "and" || n.op === "or") n.args.forEach((x) => walk(x, f));
    else if (n.op === "not") walk(n.arg, f);
    else f(n);
  };
  walk(a.query.where, (l) =>
    leafParts(l).forEach(({ v, field }) => collect(v, field ? entityOf(field, cfTypes) : null, field ?? l.field)),
  );

  // Variables carry raw ids/names too; they resolve for the field they sit in.
  const varValues = new Map<string, CqlValue[] | null>();
  for (const u of varUses) {
    const raw = a.vars?.[u.name];
    const key = varKey(u.name, u.field);
    // Unset means "everyone": the clause is inert. An empty LIST is a real
    // value and matches nothing.
    if (raw === undefined || raw === null) {
      varValues.set(key, null);
      continue;
    }
    const list = (Array.isArray(raw) ? raw : [raw]).map(
      (x): CqlValue => (typeof x === "number" ? { t: "num", v: x } : typeof x === "boolean" ? { t: "bool", v: x } : { t: "str", v: String(x) }),
    );
    for (const v of list) if (v.t === "str" && u.entity) wanted[u.entity].add(v.v);
    varValues.set(key, list);
  }
  for (const name of new Set(varUses.map((u) => u.name))) {
    if (a.vars?.[name] === undefined) {
      diagnostics.push(
        diag(text, "CQL_UNKNOWN_VARIABLE", `\`$${name}\` has no value here, so conditions using it match everything.`, { from: 0, to: 0 }, { severity: "info" }),
      );
    }
  }

  const needsStatusCategories = (() => {
    let hit = false;
    walk(a.query.where, (l) => {
      if (l.field.kind === "sys" && l.field.id === "statusCategory") hit = true;
    });
    return hit;
  })();
  const fnNames = new Set<string>();
  const collectFns = (v: CqlValue) => {
    if (v.t === "fn") {
      fnNames.add(v.name);
      v.args.forEach(collectFns);
    }
  };
  walk(a.query.where, (l) => leafValues(l).forEach(collectFns));

  // ── 2. Batched, scoped lookups ─────────────────────────────────────────────
  const readableIds = [...readable];
  const nameOrIdOr = (names: Set<string>, column: "name" | "key" | "email" | "displayName" | "title") =>
    [...names].map((n) => ({ [column]: { equals: n, mode: "insensitive" as const } }));

  const [projects, types, columns, intervals, teams, labels, members, milestones] = await Promise.all([
    wanted.project.size || wanted.item.size || a.contextProjectId
      ? prisma.project.findMany({ where: { orgId, id: { in: readableIds } }, select: { id: true, key: true, name: true } })
      : [],
    wanted.type.size
      ? prisma.workItemType.findMany({ where: { OR: [{ orgId }, { orgId: null }] }, select: { id: true, key: true, name: true } })
      : [],
    wanted.status.size || needsStatusCategories
      ? // The project's statuses (archived ones too: items can sit in them).
        // Board columns are views onto these; reading them instead let a
        // ceremony board's prompts resolve as statuses and missed statuses no
        // board shows.
        prisma.workflowStatus.findMany({
          where: { projectId: { in: readableIds } },
          select: { key: true, name: true, category: true, sortOrder: true, projectId: true },
          orderBy: { sortOrder: "asc" },
        })
      : [],
    wanted.interval.size || ["openSprints", "currentSprint", "closedSprints", "futureSprints"].some((f) => fnNames.has(f))
      ? prisma.interval.findMany({
          where: { orgId, projectId: { in: readableIds } },
          select: { id: true, name: true, status: true, projectId: true },
        })
      : [],
    wanted.team.size || fnNames.has("myTeams")
      ? prisma.team.findMany({ where: { orgId, projectId: { in: readableIds } }, select: { id: true, name: true, key: true } })
      : [],
    wanted.label.size
      ? prisma.label.findMany({
          where: { orgId, OR: [...nameOrIdOr(wanted.label, "name"), { id: { in: [...wanted.label].filter(isUuid) } }] },
          select: { id: true, name: true },
        })
      : [],
    wanted.user.size
      // Unfiltered ON PURPOSE: naming a person in a query is historical
      // attribution. `reporter = "<someone who left>"` is the headline reason
      // the reporter field exists, and the filtered client would answer "no
      // person named that" the moment they were removed. Still `orgId`-scoped,
      // so it cannot resolve a stranger from another tenant, and it yields
      // only an id the caller can already see on the items themselves.
      // `suggest.server.ts` stays filtered — a removed person is not offered
      // in the editor's completion.
      ? prismaUnfiltered.orgMember.findMany({
          where: {
            orgId,
            user: {
              OR: [
                ...nameOrIdOr(wanted.user, "email"),
                ...nameOrIdOr(wanted.user, "displayName"),
                { id: { in: [...wanted.user].filter(isUuid) } },
              ],
            },
          },
          select: { user: { select: { id: true, email: true, displayName: true } } },
        })
      : [],
    wanted.milestone.size
      ? prisma.milestone.findMany({
          where: { orgId, projectId: { in: readableIds }, OR: [...nameOrIdOr(wanted.milestone, "title"), { id: { in: [...wanted.milestone].filter(isUuid) } }] },
          select: { id: true, title: true },
        })
      : [],
  ]);

  // Items: `ACME-12` (readable project key + number) or a readable item's id.
  const projectByKey = new Map(projects.map((p) => [p.key.toLowerCase(), p]));
  const itemKeys = [...wanted.item]
    .map((s) => KEY_RE.exec(s))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ project: projectByKey.get(m[1].toLowerCase()), n: Number(m[2]) }))
    .filter((x) => !!x.project);
  const itemRows = wanted.item.size
    ? await prisma.workItem.findMany({
        where: {
          orgId,
          projectId: { in: readableIds },
          OR: [
            { id: { in: [...wanted.item].filter(isUuid) } },
            ...itemKeys.map((x) => ({ projectId: x.project!.id, ticketNumber: x.n })),
          ],
        },
        select: { id: true, projectId: true, ticketNumber: true, title: true },
      })
    : [];

  // ── 3. Index the lookups ───────────────────────────────────────────────────
  const lc = (s: string) => s.toLowerCase();
  const index = new Map<RefEntity, Map<string, Ref[]>>();
  const put = (entity: RefEntity, name: string, ref: Ref) => {
    let m = index.get(entity);
    if (!m) index.set(entity, (m = new Map()));
    const k = lc(name);
    const list = m.get(k) ?? [];
    if (!list.some((r) => r.id === ref.id)) list.push(ref);
    m.set(k, list);
  };
  for (const p of projects) {
    const ref: Ref = { t: "ref", entity: "project", id: p.id, label: p.key };
    put("project", p.key, ref);
    put("project", p.name, ref);
    put("project", p.id, ref);
  }
  for (const t of types) {
    const ref: Ref = { t: "ref", entity: "type", id: t.id, label: t.name };
    put("type", t.key, ref);
    put("type", t.name, ref);
    put("type", t.id, ref);
  }
  for (const c of columns) {
    const ref: Ref = { t: "ref", entity: "status", id: c.key, label: c.name };
    put("status", c.key, ref);
    put("status", c.name, ref);
  }
  for (const i of intervals) {
    const ref: Ref = { t: "ref", entity: "interval", id: i.id, label: i.name };
    put("interval", i.name, ref);
    put("interval", i.id, ref);
  }
  for (const t of teams) {
    const ref: Ref = { t: "ref", entity: "team", id: t.id, label: t.name };
    put("team", t.name, ref);
    if (t.key) put("team", t.key, ref);
    put("team", t.id, ref);
  }
  for (const l of labels) {
    const ref: Ref = { t: "ref", entity: "label", id: l.id, label: l.name };
    put("label", l.name, ref);
    put("label", l.id, ref);
  }
  for (const m of milestones) {
    const ref: Ref = { t: "ref", entity: "milestone", id: m.id, label: m.title };
    put("milestone", m.title, ref);
    put("milestone", m.id, ref);
  }
  const userByName = new Map<string, { id: string; email: string; displayName: string }[]>();
  for (const { user: u } of members) {
    for (const k of [u.email, u.displayName, u.id]) {
      const list = userByName.get(lc(k)) ?? [];
      if (!list.some((x) => x.id === u.id)) list.push(u);
      userByName.set(lc(k), list);
    }
  }
  const projectKeyById = new Map(projects.map((p) => [p.id, p.key]));
  const items = new Map<string, { projectId: string; ticketNumber: number }>();
  for (const w of itemRows) {
    items.set(w.id, { projectId: w.projectId, ticketNumber: w.ticketNumber });
    const ref: Ref = { t: "ref", entity: "item", id: w.id, label: `${projectKeyById.get(w.projectId) ?? "?"}-${w.ticketNumber}` };
    put("item", ref.label!, ref);
    put("item", w.id, ref);
  }

  // ── 4. Rewrite literals to refs ────────────────────────────────────────────
  const strict = (a.mode ?? "strict") === "strict";
  const unknown = (v: CqlValue & { t: "str" | "num" }, entity: RefEntity) => {
    diagnostics.push(
      diag(text, "CQL_UNKNOWN_VALUE", `No ${ENTITY_WORD[entity]} named “${v.v}” that you can see.`, at(v), {
        severity: strict ? "error" : "warning",
      }),
    );
  };

  /** Resolve one value for an entity: a list (names can match several), or null if unknown. */
  const resolveValue = (v: CqlValue, entity: RefEntity | null): CqlValue[] | null => {
    if (v.t === "fn") return [{ ...v, args: v.args.flatMap((arg, i) => resolveValue(arg, fnArgEntity(v.name, i)) ?? [arg]) }];
    if (v.t === "ref" && RECHECKED_REFS.has(v.entity)) {
      // A stored ref (saved filter, dashboard panel) the viewer can't see is
      // DROPPED, silently: the query narrows to what they can see, exactly as
      // the scope envelope would, and nothing says the thing exists. The label
      // is refreshed from the current name.
      if (v.entity === "user") {
        const u = userByName.get(lc(v.id))?.find((x) => x.id === v.id);
        return u ? [{ t: "ref", entity: "user", id: u.id, label: u.displayName }] : [];
      }
      const hit = index.get(v.entity)?.get(lc(v.id))?.find((r) => r.id === v.id);
      return hit ? [hit] : [];
    }
    if (!entity || !(v.t === "str" || (v.t === "num" && entity === "item"))) return [v];
    const name = String(v.v);
    if (entity === "user") {
      const hits = userByName.get(lc(name)) ?? [];
      if (hits.length === 0) {
        unknown(v, entity);
        return null;
      }
      if (hits.length > 1) {
        const span = at(v);
        diagnostics.push(
          diag(text, "CQL_AMBIGUOUS_VALUE", `More than one person is called “${name}”. Pick one by email.`, span, {
            fixes: hits.map((h) => ({ label: `${h.displayName} <${h.email}>`, replace: { from: span.from, to: span.to, insert: `"${h.email}"` } })),
          }),
        );
        return null;
      }
      return [{ t: "ref", entity: "user", id: hits[0].id, label: hits[0].displayName }];
    }
    const hits = index.get(entity)?.get(lc(name)) ?? [];
    if (hits.length === 0) {
      unknown(v, entity);
      return null;
    }
    return hits;
  };

  const resolveList = (values: CqlValue[], field: FieldRef): CqlValue[] | null => {
    const entity = entityOf(field, cfTypes);
    const out: CqlValue[] = [];
    let ok = true;
    for (const v of values) {
      const r = resolveValue(v, entity);
      if (r) out.push(...r);
      else ok = false;
    }
    return ok || !strict ? out : null;
  };

  const rewrite = (n: CqlNode): CqlNode => {
    switch (n.op) {
      case "and":
      case "or":
        return { op: n.op, args: n.args.map(rewrite) };
      case "not":
        return { op: "not", arg: rewrite(n.arg) };
      case "cmp": {
        // Unknown values were reported; the query is not executed with errors,
        // and "warn" mode only validates. Either way the clause stays as typed.
        const list = resolveList([n.value], n.field);
        if (!list) return n;
        // Every value was a dropped stored ref: an empty set, which matches
        // nothing (and its negation, everything visible).
        if (list.length === 0) {
          if (n.cmp === "eq") return { op: "in", field: n.field, values: [] };
          if (n.cmp === "neq") return { op: "in", field: n.field, negate: true, values: [] };
          return n;
        }
        // A name that matched several things (a sprint name in two projects) is an IN.
        if (list.length > 1) {
          if (n.cmp === "eq") return { op: "in", field: n.field, values: list };
          if (n.cmp === "neq") return { op: "in", field: n.field, negate: true, values: list };
        }
        return { ...n, value: list[0] };
      }
      case "in": {
        const list = resolveList(n.values, n.field);
        if (!list) return n;
        return { ...n, values: dedupe(list) };
      }
      case "was":
      case "changed": {
        // FROM / TO / BY resolve like IN lists: a status name that is a
        // different key in each project becomes the list of those keys.
        const p = n.preds ?? {};
        const pred = (v: PredValue | undefined, field: FieldRef): PredValue | null | undefined => {
          if (v === undefined) return undefined;
          const r = resolveList(predValues(v), field);
          return r && (r.length === 1 ? r[0] : dedupe(r));
        };
        const from = pred(p.from, n.field);
        const to = pred(p.to, n.field);
        const by = pred(p.by, HISTORY_BY_FIELD);
        const values = n.op === "was" ? resolveList(n.values, n.field) : [];
        if (from === null || to === null || by === null || values === null) return n;
        const preds: HistoryPreds = {
          ...p,
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
          ...(by !== undefined ? { by } : {}),
        };
        return n.op === "was" ? { ...n, values: dedupe(values), preds } : { ...n, preds };
      }
      default:
        return n;
    }
  };
  const where = a.query.where ? rewrite(a.query.where) : null;

  // Variables: resolve their raw values for the field they are used with.
  const vars = new Map<string, CqlValue[] | null>();
  for (const u of varUses) {
    const key = varKey(u.name, u.field);
    const raw = varValues.get(key);
    if (raw == null) {
      vars.set(key, null);
      continue;
    }
    const resolved = raw.flatMap((v) => resolveValue(v, u.entity) ?? []);
    vars.set(key, resolved);
  }

  // ── 5. Expand set-valued functions ─────────────────────────────────────────
  const fnIds = new Map<string, string[]>();
  const fnValues: Extract<CqlValue, { t: "fn" }>[] = [];
  const gatherFns = (v: CqlValue) => {
    if (v.t === "fn") {
      fnValues.push(v);
      v.args.forEach(gatherFns);
    }
  };
  if (where) walk(where, (l) => leafValues(l).forEach(gatherFns));
  for (const list of vars.values()) list?.forEach(gatherFns);

  const sprintIds = (status?: "ACTIVE" | "COMPLETED" | "PLANNED", projectId?: string) =>
    intervals.filter((i) => (!status || i.status === status) && (!projectId || i.projectId === projectId)).map((i) => i.id);
  const contextProject = a.contextProjectId && readable.has(a.contextProjectId) ? a.contextProjectId : undefined;

  for (const fn of fnValues) {
    const key = fnKey(fn);
    if (fnIds.has(key)) continue;
    switch (fn.name) {
      case "openSprints":
        fnIds.set(key, sprintIds("ACTIVE"));
        break;
      case "currentSprint":
        fnIds.set(key, sprintIds("ACTIVE", contextProject));
        break;
      case "closedSprints":
        fnIds.set(key, sprintIds("COMPLETED"));
        break;
      case "futureSprints":
        fnIds.set(key, sprintIds("PLANNED"));
        break;
      case "myTeams": {
        const rows = await prisma.teamMember.findMany({
          where: {
            team: { orgId, projectId: { in: readableIds } },
            projectMember: { orgMember: { orgId, userId: a.ctx.userId } },
          },
          select: { teamId: true },
        });
        fnIds.set(key, [...new Set(rows.map((r) => r.teamId))]);
        break;
      }
      case "membersOf": {
        const teamIds = fn.args.filter((x): x is Ref => x.t === "ref" && x.entity === "team").map((x) => x.id);
        const rows = teamIds.length
          ? await prisma.teamMember.findMany({
              where: { teamId: { in: teamIds }, team: { orgId, projectId: { in: readableIds } } },
              select: { projectMember: { select: { orgMember: { select: { userId: true, removedAt: true } } } } },
            })
          : [];
        fnIds.set(key, [
          ...new Set(rows.filter((r) => !r.projectMember.orgMember.removedAt).map((r) => r.projectMember.orgMember.userId)),
        ]);
        break;
      }
      case "currentProject":
        if (!contextProject) {
          diagnostics.push(diag(text, "CQL_CONTEXT_REQUIRED", "`currentProject()` only works where a project is open (a board or project page).", at(fn)));
        }
        break;
      default:
        break;
    }
  }

  // ── 5b. Hierarchy and milestones, as id sets ─────────────────────────────────
  // `ancestor = X` and `descendantsOf(X)`: everything under X at any depth,
  // walking only readable projects. `milestone`: the items each named
  // milestone links to (MilestoneLink has no relation to WorkItem).
  const refIdsOf = (values: CqlValue[], entity: RefEntity) =>
    values.filter((v): v is Ref => v.t === "ref" && v.entity === entity).map((v) => v.id);
  const roots = new Set<string>();
  const milestoneIds = new Set<string>();
  // Only `IS EMPTY`, an EMPTY value and negations (`!=` / NOT IN leave out
  // items with no milestone) need every linked item; `=` / IN need only the
  // named milestones' links.
  let needsLinked = false;
  // A leaf's values with its variables expanded (`milestone = $m`,
  // `ancestor = $epic`), exactly as the compiler will see them.
  const expanded = (l: Parameters<Parameters<typeof walk>[1]>[0]) =>
    leafValues(l).flatMap((v) => (v.t === "var" ? (vars.get(varKey(v.name, l.field)) ?? []) : [v]));
  if (where) {
    walk(where, (l) => {
      const values = expanded(l);
      if (l.field.kind === "sys" && l.field.id === "ancestor") refIdsOf(values, "item").forEach((id) => roots.add(id));
      if (l.field.kind === "sys" && l.field.id === "milestone") {
        refIdsOf(values, "milestone").forEach((id) => milestoneIds.add(id));
        if (l.op === "empty" || values.some((v) => v.t === "empty") || (l.op === "cmp" && l.cmp === "neq") || (l.op === "in" && l.negate)) {
          needsLinked = true;
        }
      }
    });
  }
  for (const fn of fnValues) if (fn.name === "descendantsOf") refIdsOf(fn.args, "item").forEach((id) => roots.add(id));
  // One statement budget for all of it: /cql/validate and every run reach
  // these reads, and a deep tree or a big milestone must not run unbounded.
  const { descendants, milestoneItems, milestoneLinked } = await withStatementTimeout(a.timeoutMs ?? 3_000, async (tx) => {
    const descendants = await descendantsByRoot(tx, orgId, [...roots], readableIds);
    const milestoneItems = new Map<string, string[]>();
    if (milestoneIds.size) {
      const links = await tx.milestoneLink.findMany({
        where: { milestoneId: { in: [...milestoneIds] }, milestone: { orgId, projectId: { in: readableIds } } },
        select: { milestoneId: true, workItemId: true },
        take: ID_SET_MAX + 1,
      });
      if (links.length > ID_SET_MAX) throw tooBroad("milestone");
      for (const l of links) pushTo(milestoneItems, l.milestoneId, l.workItemId);
    }
    let milestoneLinked: string[] = [];
    if (needsLinked) {
      const linked = await tx.milestoneLink.findMany({
        where: { milestone: { orgId, projectId: { in: readableIds } } },
        select: { workItemId: true },
        distinct: ["workItemId"],
        take: ID_SET_MAX + 1,
      });
      if (linked.length > ID_SET_MAX) throw tooBroad("milestone-empty");
      milestoneLinked = linked.map((l) => l.workItemId);
    }
    return { descendants, milestoneItems, milestoneLinked };
  });

  // ── 6. Status categories per readable project ──────────────────────────────
  const statusCategories: CompileEnv["statusCategories"] = { TODO: [], IN_PROGRESS: [], DONE: [], CANCELLED: [] };
  if (needsStatusCategories) {
    // One status per project+key, so one category.
    const seen = new Map<string, Map<string, StatusCategory>>();
    for (const c of columns) {
      const pid = c.projectId;
      const m = seen.get(pid) ?? new Map<string, StatusCategory>();
      if (!m.has(c.key)) m.set(c.key, c.category as StatusCategory);
      seen.set(pid, m);
    }
    for (const pid of readableIds) {
      const m = seen.get(pid) ?? new Map<string, StatusCategory>();
      // The seeded "done" lane counts as done where no board describes it (done-state.ts).
      if (!m.has("done")) m.set("done", "DONE");
      for (const cat of ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"] as StatusCategory[]) {
        const keys = [...m.entries()].filter(([, c]) => c === cat).map(([k]) => k);
        if (keys.length) statusCategories[cat].push({ projectId: pid, keys });
      }
    }
  }

  const env: CompileEnv = {
    actorUserId: a.ctx.userId,
    now: a.now,
    tz: a.tz,
    fnIds,
    vars,
    statusCategories,
    items,
    customFields: cfTypes,
    descendants,
    milestoneItems,
    milestoneLinked,
    history: new Map(),
    ...(contextProject ? { contextProjectId: contextProject } : {}),
    ...(a.sinceLastStandup ? { sinceLastStandup: a.sinceLastStandup } : {}),
  };
  return { query: { ...a.query, where }, env, diagnostics };
}

/**
 * Everything under each root, any depth, inside readable projects. One
 * recursive query, parameterized (no SQL built from strings); UNION stops on
 * cycles. Bounded: past ID_SET_MAX rows it is refused.
 */
async function descendantsByRoot(db: Pick<Prisma.TransactionClient, "$queryRaw">, orgId: string, roots: string[], readable: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (roots.length === 0 || readable.length === 0) return out;
  const rows = await db.$queryRaw<{ root: string; id: string }[]>`
    WITH RECURSIVE tree(root, id) AS (
      SELECT w.parent_id, w.id FROM work_items w
       WHERE w.parent_id = ANY(${roots}::uuid[]) AND w.org_id = ${orgId}::uuid AND w.project_id = ANY(${readable}::uuid[])
      UNION
      SELECT t.root, w.id FROM work_items w JOIN tree t ON w.parent_id = t.id
       WHERE w.org_id = ${orgId}::uuid AND w.project_id = ANY(${readable}::uuid[])
    )
    SELECT root::text AS root, id::text AS id FROM tree LIMIT ${ID_SET_MAX + 1}`;
  if (rows.length > ID_SET_MAX) throw tooBroad("descendants");
  for (const r of rows) pushTo(out, r.root, r.id);
  return out;
}

function pushTo(m: Map<string, string[]>, k: string, v: string): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

function dedupe(values: CqlValue[]): CqlValue[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = v.t === "ref" ? `ref:${v.entity}:${v.id}` : JSON.stringify(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Load the custom fields a query may name: org-wide plus readable projects'. */
export async function loadSchemaCustomFields(orgId: string, readable: string[]): Promise<SchemaCustomField[]> {
  const rows = await prisma.customField.findMany({
    where: { orgId, OR: [{ projectId: null }, { projectId: { in: readable } }] },
    select: { key: true, name: true, fieldType: true, options: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    fieldType: r.fieldType as CustomFieldType,
    options: Array.isArray(r.options) ? (r.options as unknown[]).filter((o): o is string => typeof o === "string") : undefined,
  }));
}

export type { SystemFieldId };
