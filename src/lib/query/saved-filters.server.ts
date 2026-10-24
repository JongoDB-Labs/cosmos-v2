/**
 * Saved filters v2 (query design §10): who can see, edit and share a saved
 * filter, and how its query is shown to a particular viewer.
 *
 *   visibility  PRIVATE  the owner (and explicit editors)
 *               TEAM     members of the team who can read its project
 *               PROJECT  anyone who can read the project
 *               ORG      every member with ITEM_READ (setting it: FILTER_SHARE_ORG
 *                        where CQL is on; any member where it isn't)
 *   edit        owner, editors, org administrators
 *   delete      owner, org administrators
 *
 * Showing a query is the leak to guard against, not running it (the scope
 * envelope already makes running safe). `presentQuery` prints the stored query
 * for THIS viewer: a project, sprint, team or item they can't read prints as
 * ‹restricted›, never by name, and the filter is marked partially restricted.
 * Deleted things print the same way, so the marker never says which it was.
 */
import type { FilterVisibility, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { isOrgAdministrator } from "@/lib/rbac/project-access";
import { canManageProject } from "@/lib/rbac/scope";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import type { WorkItemFilter } from "@/lib/work-items/query/filter";
import { CQL_VERSION, leafValues, type CqlNode, type CqlQuery, type CqlValue } from "./ast";
import { fromWorkItemFilter, toWorkItemFilter } from "./adapters";
import { CqlError } from "./errors";
import { prepareCql } from "./execute.server";
import { validateAst } from "./normalize";
import { printCql, type LabelFor } from "./print";
import { loadSchemaCustomFields } from "./resolve.server";
import { roleCountsFor } from "@/lib/rbac/key-role";

export const RESTRICTED = "‹restricted›";

export interface ViewerScope {
  ctx: AuthContext;
  readable: Set<string>;
  /** Teams the viewer is on, with the project each belongs to. */
  teams: Map<string, string>;
  isAdmin: boolean;
}

export async function viewerScope(ctx: AuthContext): Promise<ViewerScope> {
  const readable = new Set(await getReadableProjectIds(ctx));
  const rows = await prisma.teamMember.findMany({
    where: { projectMember: { orgMember: { orgId: ctx.orgId, userId: ctx.userId } } },
    select: { team: { select: { id: true, projectId: true } } },
  });
  return {
    ctx,
    readable,
    teams: new Map(rows.map((r) => [r.team.id, r.team.projectId])),
    // An admin edits and deletes anyone's saved filter. A key never does: no
    // scope grants FILTER_SHARE_ORG (lib/rbac/key-role.ts).
    isAdmin: isOrgAdministrator(ctx.orgRole) && roleCountsFor(ctx, Permission.FILTER_SHARE_ORG),
  };
}

/** The fields the rules below look at. */
export interface ViewAccessRow {
  ownerId: string;
  visibility: FilterVisibility;
  projectId: string | null;
  teamId: string | null;
  team?: { projectId: string } | null;
  editors?: { userId: string }[];
}

const isEditor = (s: ViewerScope, v: ViewAccessRow) => !!v.editors?.some((e) => e.userId === s.ctx.userId);

export function canSee(s: ViewerScope, v: ViewAccessRow): boolean {
  if (v.ownerId === s.ctx.userId || isEditor(s, v)) return true;
  switch (v.visibility) {
    case "ORG":
      return hasPermission(s.ctx.permissions, Permission.ITEM_READ);
    case "PROJECT":
      return !!v.projectId && s.readable.has(v.projectId);
    case "TEAM": {
      // On the team AND able to read its project: a team-scoped project can
      // have members who've since lost access.
      const projectId = v.teamId ? s.teams.get(v.teamId) : undefined;
      return !!projectId && s.readable.has(projectId);
    }
    default:
      return false;
  }
}

export function canEdit(s: ViewerScope, v: ViewAccessRow): boolean {
  return v.ownerId === s.ctx.userId || isEditor(s, v) || s.isAdmin;
}

export function canDelete(s: ViewerScope, v: ViewAccessRow): boolean {
  return v.ownerId === s.ctx.userId || s.isAdmin;
}

/**
 * The same rule as a Prisma where (a prefilter: canSee() still decides), so a
 * list never loads other people's private filters.
 */
export function visibleWhere(s: ViewerScope): Prisma.SavedViewWhereInput {
  const me = s.ctx.userId;
  const or: Prisma.SavedViewWhereInput[] = [
    { ownerId: me },
    { editors: { some: { userId: me } } },
    { visibility: "PROJECT", projectId: { in: [...s.readable] } },
    { visibility: "TEAM", teamId: { in: [...s.teams.keys()] } },
  ];
  if (hasPermission(s.ctx.permissions, Permission.ITEM_READ)) or.push({ visibility: "ORG" });
  return { orgId: s.ctx.orgId, OR: or };
}

/**
 * May this actor give a filter this visibility? Returns the reason it can't,
 * or null. Checked on create and on every visibility change.
 *
 * `cql` is the org's query-language switch. Without it the org keeps the
 * pre-CQL rule, where any member could share a filter with everyone; the
 * FILTER_SHARE_ORG gate arrives with the rest of saved filters v2.
 */
export async function visibilityProblem(
  s: ViewerScope,
  target: { visibility: FilterVisibility; projectId?: string | null; teamId?: string | null },
  opts: { cql: boolean },
): Promise<string | null> {
  switch (target.visibility) {
    case "PRIVATE":
      return null;
    case "ORG":
      if (!opts.cql) return null;
      return hasPermission(s.ctx.permissions, Permission.FILTER_SHARE_ORG)
        ? null
        : "Sharing a filter with the whole organization needs the Share filters with the org permission.";
    case "PROJECT":
      if (!target.projectId) return "Pick the project to share it with.";
      // Not found and not readable read the same.
      return s.readable.has(target.projectId) ? null : "That project isn't one you can see.";
    case "TEAM": {
      if (!target.teamId) return "Pick the team to share it with.";
      const team = await prisma.team.findFirst({ where: { id: target.teamId, orgId: s.ctx.orgId }, select: { projectId: true } });
      if (!team || !s.readable.has(team.projectId)) return "That team isn't one you can see.";
      if (s.teams.has(target.teamId) || (await canManageProject(s.ctx, team.projectId, Permission.PROJECT_MANAGE))) return null;
      return "Only members of that team, or managers of its project, can share with it.";
    }
  }
}

// ── the stored query ─────────────────────────────────────────────────────────

/**
 * The filter's query: `query` when set, else the legacy `filter` translated
 * (rows saved before query phase 3 that the backfill hasn't reached yet).
 */
export function storedQuery(row: { query: unknown; filter: unknown }): CqlQuery {
  if (row.query !== null && row.query !== undefined) {
    const v = validateAst(row.query);
    if (v.query) return v.query;
  }
  const f = (row.filter && typeof row.filter === "object" ? row.filter : {}) as WorkItemFilter;
  return fromWorkItemFilter(f);
}

/**
 * The legacy shape to keep writing alongside `query` for one release, or `{}`
 * when the query is more than it can say (older clients then see an empty
 * filter rather than a wrong one).
 */
export function legacyFilterOf(q: CqlQuery, cfTypes: ReadonlyMap<string, string>): WorkItemFilter {
  return toWorkItemFilter(q, cfTypes) ?? {};
}

const SCOPED = new Set(["project", "interval", "team", "item", "milestone"]);

function refsOf(q: CqlQuery): Extract<CqlValue, { t: "ref" }>[] {
  const out: Extract<CqlValue, { t: "ref" }>[] = [];
  const node = (n: CqlNode | null) => {
    if (!n) return;
    if (n.op === "and" || n.op === "or") n.args.forEach(node);
    else if (n.op === "not") node(n.arg);
    // Every value, function arguments and history's FROM / TO / BY included.
    else for (const v of leafValues(n)) if (v.t === "ref") out.push(v);
  };
  node(q.where);
  return out;
}

export interface Presented {
  /** The query as this viewer may see it; restricted refs print as ‹restricted›. */
  cql: string;
  partiallyRestricted: boolean;
  /** The stored query no longer typechecks (a custom field was deleted, say). */
  broken?: string;
}

/**
 * Print a stored query for one viewer. Names come from what the viewer can
 * resolve now (renames show up); anything they can't resolve is ‹restricted›.
 * Names that would resolve to more than the stored thing (a sprint name used
 * in two projects) print as the id, so the text means what was saved.
 */
export async function presentQuery(s: ViewerScope, q: CqlQuery): Promise<Presented> {
  // A custom field the viewer can't see would be named by the text itself
  // (`cf[secret_field]`), so such a filter shows no text at all.
  const visibleCfs = new Set((await loadSchemaCustomFields(s.ctx.orgId, [...s.readable])).map((c) => c.key));
  if (customFieldKeys(q).some((k) => !visibleCfs.has(k))) {
    return { cql: "", partiallyRestricted: true, broken: "This filter uses fields you can't see." };
  }
  let resolved: CqlQuery;
  try {
    resolved = (await prepareCql(s.ctx, { query: q }, { mode: "warn" })).query;
  } catch (e) {
    const msg = e instanceof CqlError ? (e.diagnostics[0]?.message ?? "This filter no longer runs.") : "This filter no longer runs.";
    return { cql: printCql(q, () => RESTRICTED), partiallyRestricted: true, broken: msg };
  }
  const seen = new Map<string, string | undefined>();
  for (const r of refsOf(resolved)) seen.set(`${r.entity}:${r.id}`, r.label);

  const stored = refsOf(q);
  const restricted = new Set(stored.filter((r) => SCOPED.has(r.entity) && !seen.has(`${r.entity}:${r.id}`)).map((r) => `${r.entity}:${r.id}`));
  const names = await unambiguousNames(s, stored);

  const labelFor: LabelFor = (r) => {
    const k = `${r.entity}:${r.id}`;
    if (restricted.has(k)) return RESTRICTED;
    return names.get(k) ?? r.id;
  };
  return { cql: printCql(q, labelFor), partiallyRestricted: restricted.size > 0 };
}

/** A display name per ref, only where the name resolves back to exactly that ref. */
async function unambiguousNames(s: ViewerScope, refs: Extract<CqlValue, { t: "ref" }>[]): Promise<Map<string, string>> {
  const ids = (entity: string) => [...new Set(refs.filter((r) => r.entity === entity).map((r) => r.id))];
  const out = new Map<string, string>();
  const orgId = s.ctx.orgId;
  const readable = [...s.readable];
  const uniqueBy = <T extends { id: string }>(all: T[], name: (t: T) => string, wanted: string[], entity: string) => {
    const count = new Map<string, number>();
    for (const t of all) count.set(name(t).toLowerCase(), (count.get(name(t).toLowerCase()) ?? 0) + 1);
    for (const t of all) if (wanted.includes(t.id) && count.get(name(t).toLowerCase()) === 1) out.set(`${entity}:${t.id}`, name(t));
  };

  const projects = ids("project");
  if (projects.length) {
    for (const p of await prisma.project.findMany({ where: { orgId, id: { in: projects } }, select: { id: true, key: true } })) {
      out.set(`project:${p.id}`, p.key);
    }
  }
  const users = ids("user");
  if (users.length) {
    const members = await prisma.orgMember.findMany({ where: { orgId }, select: { user: { select: { id: true, displayName: true, email: true } } } });
    const all = members.map((m) => m.user);
    uniqueBy(all, (u) => u.displayName, users, "user");
    // Two people with one name: their email.
    for (const u of all) if (users.includes(u.id) && !out.has(`user:${u.id}`)) out.set(`user:${u.id}`, u.email);
  }
  const types = ids("type");
  if (types.length) {
    uniqueBy(await prisma.workItemType.findMany({ where: { OR: [{ orgId }, { orgId: null }] }, select: { id: true, name: true } }), (t) => t.name, types, "type");
  }
  const intervals = ids("interval");
  if (intervals.length) {
    uniqueBy(await prisma.interval.findMany({ where: { orgId, projectId: { in: readable } }, select: { id: true, name: true } }), (i) => i.name, intervals, "interval");
  }
  const teams = ids("team");
  if (teams.length) {
    uniqueBy(await prisma.team.findMany({ where: { orgId, projectId: { in: readable } }, select: { id: true, name: true } }), (t) => t.name, teams, "team");
  }
  const items = ids("item");
  if (items.length) {
    const rows = await prisma.workItem.findMany({
      where: { orgId, id: { in: items }, projectId: { in: readable } },
      select: { id: true, ticketNumber: true, projectId: true },
    });
    const keys = new Map(
      (await prisma.project.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.projectId))] } }, select: { id: true, key: true } })).map((p) => [p.id, p.key]),
    );
    for (const w of rows) out.set(`item:${w.id}`, `${keys.get(w.projectId) ?? "?"}-${w.ticketNumber}`);
  }
  const labels = ids("label");
  if (labels.length) {
    for (const l of await prisma.label.findMany({ where: { orgId, id: { in: labels } }, select: { id: true, name: true } })) out.set(`label:${l.id}`, l.name);
  }
  // Statuses are stored by column key, which resolves to every column with
  // that key — the legacy meaning — so the key itself is the faithful text.
  return out;
}

/** An empty query, for a filter with nothing in it. */
export const EMPTY_QUERY: CqlQuery = { v: CQL_VERSION, where: null };

/**
 * Of `views`, the ids whose every project-bound ref (project, sprint, team,
 * item, custom field) the viewer can read. A ref to something deleted since
 * doesn't count against it. Batched: one lookup per entity kind.
 *
 * Orgs without CQL keep #1093's rule with it (a shared filter naming
 * something you can't read isn't listed at all); with CQL the filter is
 * listed and its text is shown redacted (presentQuery).
 */
export async function fullyReadable(s: ViewerScope, views: { id: string; q: CqlQuery }[]): Promise<Set<string>> {
  const refs = new Map(views.map((v) => [v.id, refsOf(v.q)]));
  const cfKeys = new Map(views.map((v) => [v.id, customFieldKeys(v.q)]));
  const want = (entity: string) => [...new Set([...refs.values()].flat().filter((r) => r.entity === entity).map((r) => r.id))];
  const orgId = s.ctx.orgId;
  const [intervals, teams, items, fields] = await Promise.all([
    want("interval").length ? prisma.interval.findMany({ where: { orgId, id: { in: want("interval") } }, select: { id: true, projectId: true } }) : [],
    want("team").length ? prisma.team.findMany({ where: { orgId, id: { in: want("team") } }, select: { id: true, projectId: true } }) : [],
    want("item").length ? prisma.workItem.findMany({ where: { orgId, id: { in: want("item") } }, select: { id: true, projectId: true } }) : [],
    [...cfKeys.values()].flat().length
      ? prisma.customField.findMany({ where: { orgId, key: { in: [...new Set([...cfKeys.values()].flat())] } }, select: { key: true, projectId: true } })
      : [],
  ]);
  const projectOf = new Map<string, string>([
    ...intervals.map((i) => [`interval:${i.id}`, i.projectId] as [string, string]),
    ...teams.map((t) => [`team:${t.id}`, t.projectId] as [string, string]),
    ...items.map((w) => [`item:${w.id}`, w.projectId] as [string, string]),
  ]);
  const cfProject = new Map(fields.map((f) => [f.key, f.projectId]));
  const ok = (p: string | null | undefined) => p == null || s.readable.has(p);
  const out = new Set<string>();
  for (const v of views) {
    const fine =
      refs.get(v.id)!.every((r) => (r.entity === "project" ? s.readable.has(r.id) : SCOPED.has(r.entity) ? ok(projectOf.get(`${r.entity}:${r.id}`)) : true))
      && cfKeys.get(v.id)!.every((k) => ok(cfProject.get(k)));
    if (fine) out.add(v.id);
  }
  return out;
}

function customFieldKeys(q: CqlQuery): string[] {
  const out: string[] = [];
  const node = (n: CqlNode | null) => {
    if (!n) return;
    if (n.op === "and" || n.op === "or") n.args.forEach(node);
    else if (n.op === "not") node(n.arg);
    else if (n.field.kind === "cf") out.push(n.field.key);
  };
  node(q.where);
  return out;
}

/**
 * A saved filter's stored query, for running it by id (`?filter=` on search
 * and export), or null when the caller can't see it. Running the stored query
 * rather than its text is what lets a partly-restricted filter run: the
 * resolver drops the refs the caller can't read, exactly as the envelope would.
 */
export async function savedFilterQuery(ctx: AuthContext, viewId: string): Promise<CqlQuery | null> {
  if (!/^[0-9a-f-]{36}$/i.test(viewId)) return null;
  const view = await prisma.savedView.findFirst({
    where: { id: viewId, orgId: ctx.orgId },
    select: { ownerId: true, visibility: true, projectId: true, teamId: true, query: true, filter: true, editors: { select: { userId: true } } },
  });
  if (!view) return null;
  return canSee(await viewerScope(ctx), view) ? storedQuery(view) : null;
}
