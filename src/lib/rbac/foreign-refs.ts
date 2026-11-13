import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { ProblemError } from "@/lib/openapi/problem";
import type { AuthContext } from "@/lib/rbac/check";
import { hiddenProjectIds } from "@/lib/rbac/project-access";

/**
 * "Does every id this write REFERENCES belong to the caller's org — and, for a
 * row that lives in a project, to the same project (or one the caller can see)?"
 *
 * WHY THIS EXISTS. The foreign keys in this schema are single-column
 * (`contracts.partner_id → partners.id`), so Postgres accepts another tenant's
 * row as happily as your own. A request body that names a partner, a parent
 * item or a sprint by id therefore had to be checked by hand, and it was done
 * route by route: the vendor POST looked its partner up by `{ id, orgId }` and
 * the vendor PATCH beside it did not; the work-item routes checked `teamId` and
 * never `parentId`. Each miss was a cross-tenant write, and usually a read as
 * well, because the response `include`s the row it just linked.
 *
 * One rule table, one helper, three shapes so every surface can use it in its
 * own idiom:
 *
 *   - `assertRefsInScope` throws a 400 `ProblemError` — for REST routes and
 *     services, which `handleApiError` turns into a response;
 *   - `refsError` returns the message or null — for Cosmo executors, which
 *     answer `{ error }` (the `teamProjectError` idiom);
 *   - `foreignRef` returns the offending kind or null — for callers that throw
 *     their own error type (the workflow's TransitionError).
 *
 * An id from another org, an id in another project and an id that does not
 * exist all get the SAME answer, so the check is not an oracle for which ids
 * are real elsewhere.
 *
 * `null`/`undefined` mean "not set" or "clearing it", and always pass.
 */

/** The root client or an interactive-transaction client. */
export type RefDb = Prisma.TransactionClient | PrismaClient;

/**
 * Where the referencing row lives.
 *
 *  - `projectId`: refs to project-owned rows must be in THIS project.
 *  - otherwise, `viewer`: refs to project-owned rows must be in a project the
 *    viewer can see (team scoping and an API key's project ceiling both apply).
 *  - neither: the org is the only bound.
 */
export interface RefScope {
  orgId: string;
  projectId?: string | null;
  viewer?: AuthContext;
}

type Ids = readonly string[];

interface RefRule {
  /** The noun in the refusal message. */
  label: string;
  /** The refusal, when "That <label> doesn't exist in this organization." reads wrong. */
  outsideOrg?: string;
  /** Lives inside a project, so `projectId`/`viewer` narrow it. */
  inProject: boolean;
  /** How many of `ids` exist under this scope (ids are de-duplicated first). */
  count: (db: RefDb, ids: Ids, s: ResolvedScope) => Promise<number>;
}

interface ResolvedScope {
  orgId: string;
  /** A project bound, as a Prisma filter on the ref's `projectId` column. */
  project?: string | { notIn: string[] };
}

const inIds = (ids: Ids) => ({ in: [...ids] });
/** The project bound, for a NOT NULL `projectId` column. */
const projectBound = (s: ResolvedScope) => (s.project === undefined ? {} : { projectId: s.project });

/**
 * The rule per kind of reference. Keyed by the noun, not the body field, so
 * `parentId` on a work item and `workItemId` on a link both say `workItem`.
 * Add a kind here, not a lookup in a route.
 */
const RULES = {
  partner: {
    label: "partner",
    inProject: false,
    count: (db, ids, s) => db.partner.count({ where: { id: inIds(ids), orgId: s.orgId } }),
  },
  product: {
    label: "product",
    inProject: false,
    count: (db, ids, s) => db.product.count({ where: { id: inIds(ids), orgId: s.orgId } }),
  },
  client: {
    label: "client",
    inProject: false,
    count: (db, ids, s) => db.client.count({ where: { id: inIds(ids), orgId: s.orgId } }),
  },
  label: {
    label: "label",
    inProject: false,
    count: (db, ids, s) => db.label.count({ where: { id: inIds(ids), orgId: s.orgId } }),
  },
  // A project a row is moved into. Only the viewer bound applies: naming a
  // project you cannot see would hide the row from you, or show it to that
  // project's members as though it were theirs.
  project: {
    label: "project",
    inProject: false,
    count: (db, ids, s) =>
      db.project.count({
        where: { id: typeof s.project === "object" ? { in: [...ids], notIn: s.project.notIn } : inIds(ids), orgId: s.orgId },
      }),
  },
  // A contract's project is optional: one under no project is org-level CRM.
  contract: {
    label: "contract",
    inProject: true,
    count: (db, ids, s) =>
      db.contract.count({
        where: {
          id: inIds(ids),
          orgId: s.orgId,
          ...(s.project !== undefined && { OR: [{ projectId: null }, { projectId: s.project }] }),
        },
      }),
  },
  // An invoice's project is optional, so the org is its bound here; a caller
  // that must also hide invoices on unseen projects checks that itself
  // (payables/links.server.ts).
  invoice: {
    label: "invoice",
    inProject: false,
    count: (db, ids, s) => db.invoice.count({ where: { id: inIds(ids), orgId: s.orgId } }),
  },
  // Only the org's OWN project templates. A built-in one (no org) is shared by
  // every org, so attaching anything to it would reach all of them.
  projectTemplate: {
    label: "project template",
    inProject: false,
    count: (db, ids, s) => db.projectTemplate.count({ where: { id: inIds(ids), orgId: s.orgId } }),
  },
  // Built-in types have no org; an org's own types have its id.
  workItemType: {
    label: "work item type",
    inProject: false,
    count: (db, ids, s) =>
      db.workItemType.count({ where: { id: inIds(ids), OR: [{ orgId: s.orgId }, { orgId: null }] } }),
  },
  workItem: {
    label: "work item",
    inProject: true,
    count: (db, ids, s) => db.workItem.count({ where: { id: inIds(ids), orgId: s.orgId, ...projectBound(s) } }),
  },
  interval: {
    label: "interval",
    inProject: true,
    count: (db, ids, s) => db.interval.count({ where: { id: inIds(ids), orgId: s.orgId, ...projectBound(s) } }),
  },
  team: {
    label: "team",
    inProject: true,
    count: (db, ids, s) => db.team.count({ where: { id: inIds(ids), orgId: s.orgId, ...projectBound(s) } }),
  },
  milestone: {
    label: "milestone",
    inProject: true,
    count: (db, ids, s) => db.milestone.count({ where: { id: inIds(ids), orgId: s.orgId, ...projectBound(s) } }),
  },
  objective: {
    label: "objective",
    inProject: true,
    count: (db, ids, s) => db.objective.count({ where: { id: inIds(ids), orgId: s.orgId, ...projectBound(s) } }),
  },
  clin: {
    label: "CLIN",
    inProject: true,
    count: (db, ids, s) => db.clin.count({ where: { id: inIds(ids), orgId: s.orgId, ...projectBound(s) } }),
  },
  deliverable: {
    label: "deliverable",
    inProject: true,
    count: (db, ids, s) => db.deliverable.count({ where: { id: inIds(ids), orgId: s.orgId, ...projectBound(s) } }),
  },
  goal: {
    label: "goal",
    inProject: true,
    count: (db, ids, s) => db.goal.count({ where: { id: inIds(ids), orgId: s.orgId, ...projectBound(s) } }),
  },
  kpi: {
    label: "KPI",
    inProject: true,
    count: (db, ids, s) => db.kpi.count({ where: { id: inIds(ids), orgId: s.orgId, ...projectBound(s) } }),
  },
  // A person a row names (an owner, the subject of a request) by USER id.
  // Those columns reference users, which belong to no org, so any user would
  // pass the foreign key: this holds them to the org's CURRENT members. A
  // removed member's row is kept for history. The default client already
  // filters `removedAt`; it is filtered here as well so the rule holds
  // whichever client it is handed, the unfiltered one included.
  member: {
    label: "person",
    outsideOrg: "That person isn't a member of this organization.",
    inProject: false,
    count: (db, ids, s) => db.orgMember.count({ where: { userId: inIds(ids), orgId: s.orgId, removedAt: null } }),
  },
  board: {
    label: "board",
    inProject: true,
    count: (db, ids, s) => db.board.count({ where: { id: inIds(ids), orgId: s.orgId, ...projectBound(s) } }),
  },
} satisfies Record<string, RefRule>;

export type RefKind = keyof typeof RULES;

/** The references a write makes: one id or a list per kind. */
export type Refs = Partial<Record<RefKind, string | readonly (string | null | undefined)[] | null | undefined>>;

/** Every kind the helper knows, for the table-driven test. */
export const REF_KINDS = Object.keys(RULES) as RefKind[];

/** The refusal for a kind, worded for where the write happens. */
export function refMessage(kind: RefKind, scope: Pick<RefScope, "projectId">): string {
  const rule: RefRule = RULES[kind];
  return rule.inProject && scope.projectId
    ? `That ${rule.label} isn't part of this project.`
    : (rule.outsideOrg ?? `That ${rule.label} doesn't exist in this organization.`);
}

function idsOf(value: Refs[RefKind]): string[] {
  if (value == null) return [];
  const list = typeof value === "string" ? [value] : value;
  return [...new Set(list.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/**
 * The first kind whose ids are not all inside the scope, or null when every
 * reference is fine. Prefer `assertRefsInScope` or `refsError` unless you need
 * to throw your own error type.
 */
export async function foreignRef(db: RefDb, scope: RefScope, refs: Refs): Promise<RefKind | null> {
  let hidden: string[] | undefined;
  for (const kind of Object.keys(refs) as RefKind[]) {
    const ids = idsOf(refs[kind]);
    if (ids.length === 0) continue;
    const rule: RefRule = RULES[kind];
    const resolved: ResolvedScope = { orgId: scope.orgId };
    if (rule.inProject && scope.projectId) {
      resolved.project = scope.projectId;
    } else if ((rule.inProject || kind === "project") && scope.viewer) {
      hidden ??= await hiddenProjectIds(scope.viewer);
      if (hidden.length) resolved.project = { notIn: hidden };
    }
    if ((await rule.count(db, ids, resolved)) !== ids.length) return kind;
  }
  return null;
}

/** The refusal message for the first out-of-scope reference, or null. */
export async function refsError(scope: RefScope, refs: Refs, db: RefDb = prisma): Promise<string | null> {
  const kind = await foreignRef(db, scope, refs);
  return kind ? refMessage(kind, scope) : null;
}

/** Throws a 400 for the first out-of-scope reference. */
export async function assertRefsInScope(scope: RefScope, refs: Refs, db: RefDb = prisma): Promise<void> {
  const message = await refsError(scope, refs, db);
  if (message) throw new ProblemError(400, "invalid_request", message);
}

/**
 * For READS: drop a to-one relation that points outside the org.
 *
 * Prisma cannot filter a to-one `include`, so a row linked to another tenant's
 * partner before the write-side check existed would still read that partner
 * back. Pass the relations to scrub; each must carry `orgId` (a full-row
 * include does). A to-many include takes `where: { orgId }` instead.
 */
export function withoutForeign<T extends Record<string, unknown>, K extends keyof T>(
  row: T,
  orgId: string,
  keys: readonly K[],
): T {
  let out = row;
  for (const k of keys) {
    const rel = row[k] as { orgId?: string | null } | null | undefined;
    if (rel && typeof rel === "object" && "orgId" in rel && rel.orgId !== orgId) {
      if (out === row) out = { ...row };
      (out as Record<K, unknown>)[k] = null;
    }
  }
  return out;
}
