/**
 * Server-side entity registry — the single index that powers BOTH the ⌘K
 * command palette and the `@` mention typeahead (`searchEntities`), plus the
 * batch label/url resolver for rendering stored tokens (`resolveRefs`).
 *
 * Per-type handlers do a case-insensitive `contains` search, and answer only
 * what the caller could open on that type's own pages: the type's read bit
 * (`READS`), and for a project's records only the projects readable under it
 * (team scoping and ABAC denies, via `getReadableProjectIds`). Documents follow
 * the file rule (lib/files/access.ts) as the org library does, boards their
 * team, people the roster ceiling. A search that returned a title the page
 * would refuse disclosed it already. Project-scoped
 * types return `projectId`, and `finalize()` batch-resolves the project `key`
 * for deep-links + the `KEY-<n>` work-item label. The routes gate ORG_READ.
 */
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { getVisibleProjectIds, hiddenProjectIds } from "@/lib/rbac/project-access";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { narrowBoards } from "@/lib/rbac/board-access";
import type { BoardLike } from "@/lib/rbac/board-visibility";
import { orgDocumentVisibilityWhere } from "@/lib/files/access";
import { readableMeetingsWhere } from "@/lib/meetings/meeting-reader";
import { memberDisclosure, type MemberDisclosure } from "@/lib/members/scoped-roster.server";
import { mayUseChat, canSeeChannelGiven } from "@/lib/chat/access";
import {
  ENTITY_ORDER,
  type EntityRef,
  type EntityType,
  refKey,
} from "./refs";
import { entityUrl } from "./urls";
import { parseTicketQuery } from "./ticket-query";
import { ATTRIBUTE_BUDGET_MS, itemAttributeMatch, type AttributeMatch } from "./item-attributes.server";
import { withStatementTimeout } from "@/lib/query/timeout.server";
import type { Prisma } from "@prisma/client";

import { FEEDBACK_SUBJECT } from "@/lib/feedback/subject";
import { feedbackItemUrl } from "@/lib/feedback/urls";
import { chatDrawerHref } from "@/lib/chat/drawer-link";
type ReadBit = keyof typeof Permission;

export type SearchScope = {
  orgId: string;
  userId: string;
  ctx: AuthContext;
  /** Projects whose records the caller may read under `action`. Memoized per call. */
  readable(action: ReadBit): Promise<string[]>;
  /** Projects the caller can see at all (PROJECT_READ, team scoping). */
  visible(): Promise<Set<string>>;
  /** Who among the members the caller may see, and whether with emails. */
  people(): Promise<MemberDisclosure>;
};

/**
 * The read each type's own pages require: the bit, and for a project's records
 * the action whose readable projects bound the search. A type the caller's role
 * cannot open is not searched at all.
 */
const READS: Record<EntityType, { bit: ReadBit; projects?: ReadBit }> = {
  user: { bit: "ORG_READ" },
  project: { bit: "PROJECT_READ" },
  note: { bit: "NOTE_READ" },
  workItem: { bit: "ITEM_READ", projects: "ITEM_READ" },
  // The meeting rule every meeting door asks (`readableMeetingsWhere`).
  meeting: { bit: "MEETING_READ" },
  board: { bit: "BOARD_READ", projects: "BOARD_READ" },
  milestone: { bit: "PROJECT_READ", projects: "PROJECT_READ" },
  objective: { bit: "OKR_READ", projects: "OKR_READ" },
  goal: { bit: "OKR_READ", projects: "OKR_READ" },
  kpi: { bit: "ANALYTICS_READ", projects: "ANALYTICS_READ" },
  // The org library's own rule (`orgDocumentVisibilityWhere`), which the routes gate on ORG_READ.
  document: { bit: "ORG_READ" },
  risk: { bit: "ANALYTICS_READ", projects: "ANALYTICS_READ" },
  deliverable: { bit: "ANALYTICS_READ", projects: "ANALYTICS_READ" },
  blocker: { bit: "ANALYTICS_READ", projects: "ANALYTICS_READ" },
  changeRequest: { bit: "ANALYTICS_READ", projects: "ANALYTICS_READ" },
  clin: { bit: "ANALYTICS_READ", projects: "ANALYTICS_READ" },
  crmContact: { bit: "CRM_READ" },
  partner: { bit: "CRM_READ" },
  product: { bit: "CRM_READ" },
};

function scopeFor(ctx: AuthContext): SearchScope {
  const readable = new Map<ReadBit, Promise<string[]>>();
  let visible: Promise<Set<string>> | null = null;
  let people: Promise<MemberDisclosure> | null = null;
  return {
    orgId: ctx.orgId,
    userId: ctx.userId,
    ctx,
    readable(action) {
      if (!readable.has(action)) readable.set(action, getReadableProjectIds(ctx, action));
      return readable.get(action)!;
    },
    visible() {
      visible ??= prisma.project
        .findMany({ where: { orgId: ctx.orgId }, select: { id: true } })
        .then((all) => getVisibleProjectIds(ctx, all.map((p) => p.id)));
      return visible;
    },
    people() {
      people ??= memberDisclosure(ctx);
      return people;
    },
  };
}

/** Whether the caller's role opens this type at all. */
const mayRead = (type: EntityType, scope: SearchScope) => hasPermission(scope.ctx.permissions, Permission[READS[type].bit]);

export type EntityHit = {
  type: EntityType;
  id: string;
  label: string;
  sublabel?: string;
  /** Why it matched when its name doesn't say: "Label: Security". */
  matched?: string;
  url: string | null;
};

type Raw = {
  id: string;
  title: string;
  code?: string;
  ticketNumber?: number;
  projectId?: string | null;
  projectKey?: string | null;
  sublabel?: string;
  matched?: string;
};
type TypedRaw = Raw & { type: EntityType };

type SearchOptions = {
  /** Also match what a record carries, not just its name: a work item's labels and custom-field values (⌘K). */
  attributes?: boolean;
};

type Handler = {
  search(q: string, scope: SearchScope, take: number, opts?: SearchOptions): Promise<Raw[]>;
  resolve(ids: string[], scope: SearchScope): Promise<Raw[]>;
};

const ci = (q: string) => ({ contains: q, mode: "insensitive" as const });

/** Minimal structural view of a Prisma model delegate (avoids fighting the
 *  generated overloads while staying `any`-free). */
type Delegate = {
  findMany: (args: {
    where: Record<string, unknown>;
    select: Record<string, boolean>;
    take?: number;
    orderBy?: Record<string, "asc" | "desc">;
  }) => Promise<Record<string, unknown>[]>;
};

/** Factory for the common "org-scoped, one text field, optional code/ticket/
 *  projectId" shape. Notes + people are written out explicitly below. */
function makeHandler(cfg: {
  delegate: Delegate;
  field: "title" | "name";
  hasCode?: boolean;
  hasTicket?: boolean;
  projectScoped?: boolean;
  /** `READS[type].projects` bounds the rows. */
  read?: { projects?: ReadBit };
  /** A further `where` (the document rule). */
  where?: (scope: SearchScope) => Promise<Record<string, unknown>>;
  /** Extra columns `keep` needs. */
  extraSelect?: Record<string, boolean>;
  /** A last per-row narrowing that a `where` cannot express (a board's team). */
  keep?: (rows: Record<string, unknown>[], scope: SearchScope) => Promise<Record<string, unknown>[]>;
  /**
   * More a row can match on when `attributes` is asked for; the match carries
   * its own scope. `delegate` is this model's in a transaction, where the
   * query runs under ATTRIBUTE_BUDGET_MS: an OR the title index can't serve.
   */
  attributes?: {
    match: (q: string, scope: SearchScope) => Promise<AttributeMatch | null>;
    delegate: (tx: Prisma.TransactionClient) => Delegate;
  };
}): Handler {
  const select: Record<string, boolean> = { id: true, [cfg.field]: true, ...cfg.extraSelect };
  if (cfg.hasCode) select.code = true;
  if (cfg.hasTicket) select.ticketNumber = true;
  if (cfg.projectScoped) select.projectId = true;

  /** Everything but the text match: the projects and rule this caller may read. */
  const bounds = async (scope: SearchScope): Promise<Record<string, unknown>[]> => {
    const out: Record<string, unknown>[] = [];
    if (cfg.read?.projects) {
      const ids = await scope.readable(cfg.read.projects);
      out.push({ projectId: { in: ids } });
    }
    if (cfg.where) out.push(await cfg.where(scope));
    return out;
  };
  const narrow = async (rows: Record<string, unknown>[], scope: SearchScope) => (cfg.keep ? cfg.keep(rows, scope) : rows);

  const toRaw = (r: Record<string, unknown>): Raw => ({
    id: r.id as string,
    title: (r[cfg.field] as string) ?? "",
    code: cfg.hasCode ? (r.code as string | undefined) : undefined,
    ticketNumber: cfg.hasTicket ? (r.ticketNumber as number | undefined) : undefined,
    projectId: cfg.projectScoped ? (r.projectId as string | undefined) : undefined,
  });

  return {
    async search(q, scope, take, opts) {
      // Entities with a ticket number are looked up BY that number at least as
      // often as by title — "TEST-123" is how people refer to them — but the
      // number was only ever selected for display, never searched.
      const ticket = cfg.hasTicket ? parseTicketQuery(q).ticketNumber : undefined;
      const text = ticket === undefined ? { [cfg.field]: ci(q) } : { OR: [{ [cfg.field]: ci(q) }, { ticketNumber: ticket }] };

      // The name match, or the attribute match, inside the caller's bounds either way.
      const inBounds = await bounds(scope);
      const find = (db: Delegate, match: Record<string, unknown>) =>
        db.findMany({ where: { orgId: scope.orgId, AND: [match, ...inBounds] }, select, take, orderBy: { [cfg.field]: "asc" } });

      // Any failure in the attribute branch (building it, running out of time,
      // describing it) costs the extra matches, never the name matches.
      const attrs = opts?.attributes ? cfg.attributes : undefined;
      let rows: Record<string, unknown>[] | null = null;
      let also: AttributeMatch | null = null;
      if (attrs) {
        try {
          also = await attrs.match(q, scope);
          if (also) {
            const where = also.where;
            rows = await withStatementTimeout(ATTRIBUTE_BUDGET_MS, (tx) => find(attrs.delegate(tx), { OR: [text, where] }));
          }
        } catch (e) {
          console.error("[search] attribute match failed or ran out of time; searching names only", e);
          also = null;
        }
      }
      rows ??= await find(cfg.delegate, text);

      const raws = (await narrow(rows, scope)).map(toRaw);
      if (also) {
        try {
          // Say why only where the name doesn't already show it.
          const lower = q.toLowerCase();
          const why = await also.describe(raws.filter((r) => !r.title.toLowerCase().includes(lower)).map((r) => r.id));
          for (const r of raws) r.matched = why.get(r.id);
        } catch (e) {
          // eslint-disable-next-line no-restricted-syntax -- best-effort: the reason is a caption; the matches reach the user without it
          console.error("[search] describing attribute matches failed; returning them without a reason", e);
        }
      }
      return raws;
    },
    async resolve(ids, scope) {
      if (ids.length === 0) return [];
      const rows = await cfg.delegate.findMany({
        where: { orgId: scope.orgId, id: { in: ids }, AND: await bounds(scope) },
        select,
      });
      return (await narrow(rows, scope)).map(toRaw);
    },
  };
}

const d = (m: unknown) => m as unknown as Delegate;

/** A member as a hit: the email only for a caller who may read emails. */
function person(u: { id: string; displayName: string | null; email: string }, people: MemberDisclosure): Raw {
  return {
    id: u.id,
    title: u.displayName || (people.emails ? u.email : "") || u.id,
    ...(people.emails && { sublabel: u.email }),
  };
}

const HANDLERS: Record<EntityType, Handler> = {
  user: {
    // The roster ceiling and the email rule, as every member list applies them:
    // without members:read an address is neither shown nor matched.
    async search(q, scope, take) {
      const people = await scope.people();
      const rows = await prisma.orgMember.findMany({
        where: {
          orgId: scope.orgId,
          ...(people.roster && { userId: { in: people.roster } }),
          user: people.emails ? { OR: [{ displayName: ci(q) }, { email: ci(q) }] } : { displayName: ci(q) },
        },
        select: { user: { select: { id: true, displayName: true, email: true } } },
        take,
        orderBy: { user: { displayName: "asc" } },
      });
      return rows.map((r) => person(r.user, people));
    },
    // `search` above feeds the @-mention PICKER, so it stays on the default-filtered
    // client: a removed person must not be mentionable in new content.
    //
    // `resolve` is the opposite job — it turns the `<@uuid>` tokens already stored in
    // comments and notes back into names, so it must still answer for people who have
    // since been removed, or their past mentions decay into raw ids. Reading the
    // retained membership row keeps this scoped to `orgId`, so resolution cannot be
    // used to put a name to a user id from another org.
    async resolve(ids, scope) {
      if (ids.length === 0) return [];
      const people = await scope.people();
      const rows = await prismaUnfiltered.orgMember.findMany({
        where: { orgId: scope.orgId, userId: { in: ids.filter((id) => people.inRoster(id)) } },
        select: { user: { select: { id: true, displayName: true, email: true } } },
      });
      return rows.map((r) => person(r.user, people));
    },
  },
  project: {
    // Both paths narrow to the projects this actor may SEE. Without it, a
    // project limited to its members stayed discoverable by name through
    // @-mention search — the pages and the Issues list were gated, this was not.
    async search(q, scope, take) {
      const visible = await scope.visible();
      const rows = await prisma.project.findMany({
        where: { orgId: scope.orgId, name: ci(q), archived: false, id: { in: [...visible] } },
        select: { id: true, name: true, key: true },
        take,
        orderBy: { name: "asc" },
      });
      return rows.map((r) => ({ id: r.id, title: r.name, projectKey: r.key, sublabel: r.key }));
    },
    async resolve(ids, scope) {
      if (ids.length === 0) return [];
      const visible = await scope.visible();
      const rows = await prisma.project.findMany({
        where: { orgId: scope.orgId, id: { in: ids.filter((id) => visible.has(id)) } },
        select: { id: true, name: true, key: true },
      });
      return rows.map((r) => ({ id: r.id, title: r.name, projectKey: r.key, sublabel: r.key }));
    },
  },
  note: {
    async search(q, { orgId, userId }, take) {
      const rows = await prisma.note.findMany({
        where: {
          orgId,
          title: ci(q),
          OR: [
            { visibility: "ORG" },
            { visibility: "PROJECT" },
            { visibility: "PRIVATE", authorId: userId },
          ],
        },
        select: { id: true, title: true },
        take,
        orderBy: { title: "asc" },
      });
      return rows.map((r) => ({ id: r.id, title: r.title }));
    },
    async resolve(ids, { orgId, userId }) {
      if (ids.length === 0) return [];
      const rows = await prisma.note.findMany({
        where: {
          orgId,
          id: { in: ids },
          OR: [
            { visibility: "ORG" },
            { visibility: "PROJECT" },
            { visibility: "PRIVATE", authorId: userId },
          ],
        },
        select: { id: true, title: true },
      });
      return rows.map((r) => ({ id: r.id, title: r.title }));
    },
  },
  workItem: makeHandler({
    delegate: d(prisma.workItem),
    field: "title",
    hasTicket: true,
    projectScoped: true,
    read: READS.workItem,
    // ⌘K also finds an item by its labels and custom-field values. The match is
    // a CQL query inside CQL's own scope envelope, and `bounds` still applies.
    attributes: { match: (q, scope) => itemAttributeMatch(scope.ctx, q), delegate: (tx) => d(tx.workItem) },
  }),
  // The one meeting-read rule: MEETING_READ and any policy on it, per project
  // and for meetings under none, and the project's visibility.
  meeting: makeHandler({ delegate: d(prisma.syncMeeting), field: "title", where: (scope) => readableMeetingsWhere(scope.ctx) }),
  board: makeHandler({
    delegate: d(prisma.board),
    field: "name",
    projectScoped: true,
    read: READS.board,
    // A board given to a team is that team's, as the board list narrows it.
    extraSelect: { teamId: true },
    async keep(rows, scope) {
      const byProject = new Map<string, Record<string, unknown>[]>();
      for (const r of rows) byProject.set(r.projectId as string, [...(byProject.get(r.projectId as string) ?? []), r]);
      const kept = new Set<unknown>();
      for (const [projectId, boards] of byProject) {
        const shown = await narrowBoards(scope.ctx, projectId, boards as Array<Record<string, unknown> & BoardLike>);
        for (const b of shown) kept.add(b.id);
      }
      return rows.filter((r) => kept.has(r.id));
    },
  }),
  milestone: makeHandler({ delegate: d(prisma.milestone), field: "title", projectScoped: true, read: READS.milestone }),
  objective: makeHandler({ delegate: d(prisma.objective), field: "title", projectScoped: true, read: READS.objective }),
  goal: makeHandler({ delegate: d(prisma.goal), field: "title", projectScoped: true, read: READS.goal }),
  kpi: makeHandler({ delegate: d(prisma.kpi), field: "name", projectScoped: true, read: READS.kpi }),
  document: makeHandler({
    delegate: d(prisma.document),
    field: "title",
    projectScoped: true,
    // The org library's rule: a project's files as the project's own document
    // routes allow (DOCUMENT_READ, any rule denying it, team scoping, a key's
    // limit), restricted ones only for the people they are for.
    where: (scope) => orgDocumentVisibilityWhere(scope.ctx),
  }),
  risk: makeHandler({ delegate: d(prisma.risk), field: "title", hasCode: true, projectScoped: true, read: READS.risk }),
  deliverable: makeHandler({ delegate: d(prisma.deliverable), field: "title", hasCode: true, projectScoped: true, read: READS.deliverable }),
  blocker: makeHandler({ delegate: d(prisma.blocker), field: "title", hasCode: true, projectScoped: true, read: READS.blocker }),
  changeRequest: makeHandler({ delegate: d(prisma.changeRequest), field: "title", hasCode: true, projectScoped: true, read: READS.changeRequest }),
  clin: makeHandler({ delegate: d(prisma.clin), field: "title", hasCode: true, projectScoped: true, read: READS.clin }),
  crmContact: makeHandler({ delegate: d(prisma.crmContact), field: "name" }),
  partner: makeHandler({ delegate: d(prisma.partner), field: "name" }),
  product: makeHandler({ delegate: d(prisma.product), field: "name" }),
};

/** Resolve project keys + build labels/urls for a batch of raw hits. */
async function finalize(hits: TypedRaw[], orgSlug: string): Promise<EntityHit[]> {
  const needKey = [
    ...new Set(
      hits.filter((h) => h.projectId && !h.projectKey).map((h) => h.projectId as string),
    ),
  ];
  const keyMap = new Map<string, string>();
  if (needKey.length) {
    const projs = await prisma.project.findMany({
      where: { id: { in: needKey } },
      select: { id: true, key: true },
    });
    for (const p of projs) keyMap.set(p.id, p.key);
  }
  return hits.map((h) => {
    const projectKey = h.projectKey ?? (h.projectId ? keyMap.get(h.projectId) ?? null : null);
    const label =
      h.type === "workItem"
        ? `${projectKey ?? "?"}-${h.ticketNumber ?? "?"} · ${h.title}`
        : h.code
          ? `${h.code} · ${h.title}`
          : h.title;
    return {
      type: h.type,
      id: h.id,
      label,
      sublabel: h.sublabel,
      ...(h.matched && { matched: h.matched }),
      url: entityUrl(h.type, { orgSlug, projectKey, id: h.id }),
    };
  });
}

/** The shared entity search — used by ⌘K and the @ typeahead. */
export async function searchEntities(opts: {
  ctx: AuthContext;
  orgSlug: string;
  query: string;
  types?: EntityType[];
  perType?: number;
  /** ⌘K: also match labels and custom-field values. The @ typeahead names things, so it leaves this off. */
  attributes?: boolean;
}): Promise<EntityHit[]> {
  const q = opts.query.trim();
  if (!q) return [];
  const types =
    opts.types && opts.types.length ? opts.types : ENTITY_ORDER;
  const perType = opts.perType ?? 6;
  const scope = scopeFor(opts.ctx);

  const grouped = await Promise.all(
    types.map(async (t): Promise<TypedRaw[]> => {
      if (!mayRead(t, scope)) return [];
      try {
        const rows = await HANDLERS[t].search(q, scope, perType, { attributes: opts.attributes });
        return rows.map((r) => ({ ...r, type: t }));
      } catch {
        return [];
      }
    }),
  );
  return finalize(grouped.flat(), opts.orgSlug);
}

/** Batch-resolve stored tokens to labels + deep-link urls (for chip render). */
export async function resolveRefs(opts: {
  ctx: AuthContext;
  orgSlug: string;
  refs: EntityRef[];
  /** Reuse a scope already built for this request. */
  scope?: SearchScope;
}): Promise<EntityHit[]> {
  if (opts.refs.length === 0) return [];
  const byType = new Map<EntityType, string[]>();
  for (const r of opts.refs) {
    const list = byType.get(r.type);
    if (list) list.push(r.id);
    else byType.set(r.type, [r.id]);
  }
  const scope = opts.scope ?? scopeFor(opts.ctx);
  const grouped = await Promise.all(
    [...byType.entries()].map(async ([t, ids]): Promise<TypedRaw[]> => {
      if (!mayRead(t, scope)) return [];
      try {
        const rows = await HANDLERS[t].resolve([...new Set(ids)], scope);
        return rows.map((r) => ({ ...r, type: t }));
      } catch {
        return [];
      }
    }),
  );
  return finalize(grouped.flat(), opts.orgSlug);
}

export type Backlink = {
  sourceType: string;
  sourceId: string;
  label: string;
  url: string | null;
  createdAt: string;
};

/**
 * The inverse of a mention: which sources (chat messages, comments, notes, work
 * items) reference a given target entity — the "Mentioned in …" list. Sources
 * are resolved to a human label + deep-link; unresolvable/unreadable sources
 * are dropped.
 */
export async function resolveBacklinks(opts: {
  ctx: AuthContext;
  orgSlug: string;
  targetType: EntityType;
  targetId: string;
  limit?: number;
}): Promise<Backlink[]> {
  const orgId = opts.ctx.orgId;
  const rows = await prisma.reference.findMany({
    where: { orgId, targetType: opts.targetType, targetId: opts.targetId },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 50,
    select: { sourceType: true, sourceId: true, createdAt: true },
  });
  if (rows.length === 0) return [];

  const idsOf = (t: string) => rows.filter((r) => r.sourceType === t).map((r) => r.sourceId);
  const searchScope = scopeFor(opts.ctx);
  const scope = { ctx: opts.ctx, orgSlug: opts.orgSlug, scope: searchScope };

  // note + workItem sources resolve directly (they are entity types).
  const direct = await resolveRefs({
    ...scope,
    refs: [
      ...idsOf("note").map((id) => ({ type: "note" as EntityType, id })),
      ...idsOf("workItem").map((id) => ({ type: "workItem" as EntityType, id })),
    ],
  });
  const directMap = new Map(direct.map((d) => [refKey(d.type, d.id), d]));

  // comment sources → the work item they live on, or the feedback item they
  // discuss. A feedback comment counts only while it is public and not
  // deleted: internal notes and removed words never surface as a backlink.
  const commentIds = idsOf("comment");
  const comments = commentIds.length
    ? await prisma.comment.findMany({
        where: { id: { in: commentIds }, orgId },
        select: { id: true, workItemId: true, subjectType: true, subjectId: true, visibility: true, deletedAt: true },
      })
    : [];
  const feedbackComments = comments.filter(
    (c) => c.subjectType === FEEDBACK_SUBJECT && c.subjectId && c.visibility === "PUBLIC" && !c.deletedAt,
  );
  const feedbackRows = feedbackComments.length
    ? await prisma.feedbackItem.findMany({
        where: { id: { in: feedbackComments.map((c) => c.subjectId as string) }, orgId },
        select: { id: true, title: true, projectId: true },
      })
    : [];
  // A team-scoped project's feedback is dropped for anyone who can't see it,
  // as the feedback board itself drops it.
  const hidden = feedbackRows.some((f) => f.projectId) ? new Set(await hiddenProjectIds(opts.ctx)) : new Set<string>();
  const feedbackItems = feedbackRows.filter((f) => !f.projectId || !hidden.has(f.projectId));
  const feedbackById = new Map(feedbackItems.map((f) => [f.id, f]));
  const commentToFeedback = new Map(
    feedbackComments.map((c) => [c.id, feedbackById.get(c.subjectId as string)]),
  );
  const commentWi = await resolveRefs({
    ...scope,
    refs: comments
      .filter((c) => c.workItemId)
      .map((c) => ({ type: "workItem" as EntityType, id: c.workItemId as string })),
  });
  const wiById = new Map(commentWi.map((w) => [w.id, w]));
  const commentToWi = new Map(
    comments.map((c) => [c.id, c.workItemId ? wiById.get(c.workItemId) : undefined]),
  );

  // chatMessage sources → their channel, for a reader who may use chat and
  // see that channel (a public one, or one they are in), as the chat routes
  // decide. A private channel's name or a DM is not shown to anyone else.
  const msgIds = mayUseChat(opts.ctx) ? idsOf("chatMessage") : [];
  const msgs = msgIds.length
    ? await prisma.chatMessage.findMany({
        where: { id: { in: msgIds }, deletedAt: null },
        select: { id: true, channelId: true },
      })
    : [];
  const channelIds = [...new Set(msgs.map((m) => m.channelId))];
  const [channelRows, memberOf] = channelIds.length
    ? await Promise.all([
        prisma.chatChannel.findMany({
          where: { id: { in: channelIds }, orgId },
          select: { id: true, name: true, kind: true, isPrivate: true, isGeneral: true, orgId: true },
        }),
        prisma.chatChannelMember.findMany({
          where: { channelId: { in: channelIds }, userId: opts.ctx.userId },
          select: { channelId: true, role: true },
        }),
      ])
    : [[], []];
  const membership = new Map(memberOf.map((m) => [m.channelId, m]));
  const channels = channelRows.filter((c) =>
    canSeeChannelGiven({ channel: c, member: membership.get(c.id) ?? null, viewerOrgId: orgId, orgRole: opts.ctx.orgRole }),
  );
  const chanById = new Map(channels.map((c) => [c.id, c]));
  const msgToChan = new Map(msgs.map((m) => [m.id, chanById.get(m.channelId)]));

  const out: Backlink[] = [];
  for (const r of rows) {
    const createdAt = r.createdAt.toISOString();
    if (r.sourceType === "note" || r.sourceType === "workItem") {
      const d = directMap.get(refKey(r.sourceType as EntityType, r.sourceId));
      if (d) out.push({ sourceType: r.sourceType, sourceId: r.sourceId, label: d.label, url: d.url, createdAt });
    } else if (r.sourceType === "comment") {
      const wi = commentToWi.get(r.sourceId);
      const fb = commentToFeedback.get(r.sourceId);
      if (wi) out.push({ sourceType: "comment", sourceId: r.sourceId, label: `Comment · ${wi.label}`, url: wi.url, createdAt });
      else if (fb)
        out.push({
          sourceType: "comment",
          sourceId: r.sourceId,
          label: `Comment · Feedback: ${fb.title}`,
          url: `${feedbackItemUrl(opts.orgSlug, fb.id)}#c-${r.sourceId}`,
          createdAt,
        });
    } else if (r.sourceType === "chatMessage") {
      const ch = msgToChan.get(r.sourceId);
      const msg = msgs.find((m) => m.id === r.sourceId);
      if (ch && msg)
        out.push({
          sourceType: "chatMessage",
          sourceId: r.sourceId,
          label: `Message · #${ch.name ?? "channel"}`,
          // The Chat drawer at that message; MentionedIn opens it in place.
          url: chatDrawerHref(`/${opts.orgSlug}`, { channelId: msg.channelId, messageId: msg.id }),
          createdAt,
        });
    }
  }
  return out;
}

export { refKey };
