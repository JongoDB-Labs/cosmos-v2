/**
 * Server-side entity registry — the single index that powers BOTH the ⌘K
 * command palette and the `@` mention typeahead (`searchEntities`), plus the
 * batch label/url resolver for rendering stored tokens (`resolveRefs`).
 *
 * Per-type handlers do a case-insensitive `contains` search (org-scoped; notes
 * additionally visibility-scoped; people via OrgMember). Project-scoped types
 * return `projectId`, and `finalize()` batch-resolves the project `key` for
 * deep-links + the `KEY-<n>` work-item label. Auth/permission gating happens at
 * the route layer (ORG_READ), matching the existing /search route.
 */
import { prisma } from "@/lib/db/client";
import {
  ENTITY_ORDER,
  type EntityRef,
  type EntityType,
  refKey,
} from "./refs";
import { entityUrl } from "./urls";

export type SearchScope = { orgId: string; userId: string };

export type EntityHit = {
  type: EntityType;
  id: string;
  label: string;
  sublabel?: string;
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
};
type TypedRaw = Raw & { type: EntityType };

type Handler = {
  search(q: string, scope: SearchScope, take: number): Promise<Raw[]>;
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
}): Handler {
  const select: Record<string, boolean> = { id: true, [cfg.field]: true };
  if (cfg.hasCode) select.code = true;
  if (cfg.hasTicket) select.ticketNumber = true;
  if (cfg.projectScoped) select.projectId = true;

  const toRaw = (r: Record<string, unknown>): Raw => ({
    id: r.id as string,
    title: (r[cfg.field] as string) ?? "",
    code: cfg.hasCode ? (r.code as string | undefined) : undefined,
    ticketNumber: cfg.hasTicket ? (r.ticketNumber as number | undefined) : undefined,
    projectId: cfg.projectScoped ? (r.projectId as string | undefined) : undefined,
  });

  return {
    async search(q, { orgId }, take) {
      const rows = await cfg.delegate.findMany({
        where: { orgId, [cfg.field]: ci(q) },
        select,
        take,
        orderBy: { [cfg.field]: "asc" },
      });
      return rows.map(toRaw);
    },
    async resolve(ids, { orgId }) {
      if (ids.length === 0) return [];
      const rows = await cfg.delegate.findMany({
        where: { orgId, id: { in: ids } },
        select,
      });
      return rows.map(toRaw);
    },
  };
}

const d = (m: unknown) => m as unknown as Delegate;

const HANDLERS: Record<EntityType, Handler> = {
  user: {
    async search(q, { orgId }, take) {
      const rows = await prisma.orgMember.findMany({
        where: {
          orgId,
          user: { OR: [{ displayName: ci(q) }, { email: ci(q) }] },
        },
        select: { user: { select: { id: true, displayName: true, email: true } } },
        take,
        orderBy: { user: { displayName: "asc" } },
      });
      return rows.map((r) => ({
        id: r.user.id,
        title: r.user.displayName ?? r.user.email,
        sublabel: r.user.email,
      }));
    },
    async resolve(ids, { orgId }) {
      if (ids.length === 0) return [];
      const rows = await prisma.orgMember.findMany({
        where: { orgId, userId: { in: ids } },
        select: { user: { select: { id: true, displayName: true, email: true } } },
      });
      return rows.map((r) => ({
        id: r.user.id,
        title: r.user.displayName ?? r.user.email,
        sublabel: r.user.email,
      }));
    },
  },
  project: {
    async search(q, { orgId }, take) {
      const rows = await prisma.project.findMany({
        where: { orgId, name: ci(q), archived: false },
        select: { id: true, name: true, key: true },
        take,
        orderBy: { name: "asc" },
      });
      return rows.map((r) => ({ id: r.id, title: r.name, projectKey: r.key, sublabel: r.key }));
    },
    async resolve(ids, { orgId }) {
      if (ids.length === 0) return [];
      const rows = await prisma.project.findMany({
        where: { orgId, id: { in: ids } },
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
  workItem: makeHandler({ delegate: d(prisma.workItem), field: "title", hasTicket: true, projectScoped: true }),
  meeting: makeHandler({ delegate: d(prisma.syncMeeting), field: "title" }),
  board: makeHandler({ delegate: d(prisma.board), field: "name", projectScoped: true }),
  milestone: makeHandler({ delegate: d(prisma.milestone), field: "title", projectScoped: true }),
  objective: makeHandler({ delegate: d(prisma.objective), field: "title", projectScoped: true }),
  goal: makeHandler({ delegate: d(prisma.goal), field: "title", projectScoped: true }),
  kpi: makeHandler({ delegate: d(prisma.kpi), field: "name", projectScoped: true }),
  document: makeHandler({ delegate: d(prisma.document), field: "title", projectScoped: true }),
  risk: makeHandler({ delegate: d(prisma.risk), field: "title", hasCode: true, projectScoped: true }),
  deliverable: makeHandler({ delegate: d(prisma.deliverable), field: "title", hasCode: true, projectScoped: true }),
  blocker: makeHandler({ delegate: d(prisma.blocker), field: "title", hasCode: true, projectScoped: true }),
  changeRequest: makeHandler({ delegate: d(prisma.changeRequest), field: "title", hasCode: true, projectScoped: true }),
  clin: makeHandler({ delegate: d(prisma.clin), field: "title", hasCode: true, projectScoped: true }),
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
      url: entityUrl(h.type, { orgSlug, projectKey, id: h.id }),
    };
  });
}

/** The shared entity search — used by ⌘K and the @ typeahead. */
export async function searchEntities(opts: {
  orgId: string;
  orgSlug: string;
  userId: string;
  query: string;
  types?: EntityType[];
  perType?: number;
}): Promise<EntityHit[]> {
  const q = opts.query.trim();
  if (!q) return [];
  const types =
    opts.types && opts.types.length ? opts.types : ENTITY_ORDER;
  const perType = opts.perType ?? 6;
  const scope: SearchScope = { orgId: opts.orgId, userId: opts.userId };

  const grouped = await Promise.all(
    types.map(async (t): Promise<TypedRaw[]> => {
      try {
        const rows = await HANDLERS[t].search(q, scope, perType);
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
  orgId: string;
  orgSlug: string;
  userId: string;
  refs: EntityRef[];
}): Promise<EntityHit[]> {
  if (opts.refs.length === 0) return [];
  const byType = new Map<EntityType, string[]>();
  for (const r of opts.refs) {
    const list = byType.get(r.type);
    if (list) list.push(r.id);
    else byType.set(r.type, [r.id]);
  }
  const scope: SearchScope = { orgId: opts.orgId, userId: opts.userId };
  const grouped = await Promise.all(
    [...byType.entries()].map(async ([t, ids]): Promise<TypedRaw[]> => {
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
  orgId: string;
  orgSlug: string;
  userId: string;
  targetType: EntityType;
  targetId: string;
  limit?: number;
}): Promise<Backlink[]> {
  const rows = await prisma.reference.findMany({
    where: { orgId: opts.orgId, targetType: opts.targetType, targetId: opts.targetId },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 50,
    select: { sourceType: true, sourceId: true, createdAt: true },
  });
  if (rows.length === 0) return [];

  const idsOf = (t: string) => rows.filter((r) => r.sourceType === t).map((r) => r.sourceId);
  const scope = { orgId: opts.orgId, orgSlug: opts.orgSlug, userId: opts.userId };

  // note + workItem sources resolve directly (they are entity types).
  const direct = await resolveRefs({
    ...scope,
    refs: [
      ...idsOf("note").map((id) => ({ type: "note" as EntityType, id })),
      ...idsOf("workItem").map((id) => ({ type: "workItem" as EntityType, id })),
    ],
  });
  const directMap = new Map(direct.map((d) => [refKey(d.type, d.id), d]));

  // comment sources → the work item they live on.
  const commentIds = idsOf("comment");
  const comments = commentIds.length
    ? await prisma.comment.findMany({
        where: { id: { in: commentIds }, orgId: opts.orgId },
        select: { id: true, workItemId: true },
      })
    : [];
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

  // chatMessage sources → their channel.
  const msgIds = idsOf("chatMessage");
  const msgs = msgIds.length
    ? await prisma.chatMessage.findMany({
        where: { id: { in: msgIds } },
        select: { id: true, channelId: true },
      })
    : [];
  const channelIds = [...new Set(msgs.map((m) => m.channelId))];
  const channels = channelIds.length
    ? await prisma.chatChannel.findMany({
        where: { id: { in: channelIds }, orgId: opts.orgId },
        select: { id: true, name: true },
      })
    : [];
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
      if (wi) out.push({ sourceType: "comment", sourceId: r.sourceId, label: `Comment · ${wi.label}`, url: wi.url, createdAt });
    } else if (r.sourceType === "chatMessage") {
      const ch = msgToChan.get(r.sourceId);
      const msg = msgs.find((m) => m.id === r.sourceId);
      if (ch && msg)
        out.push({
          sourceType: "chatMessage",
          sourceId: r.sourceId,
          label: `Message · #${ch.name ?? "channel"}`,
          url: `/${opts.orgSlug}/chat/${msg.channelId}`,
          createdAt,
        });
    }
  }
  return out;
}

export { refKey };
