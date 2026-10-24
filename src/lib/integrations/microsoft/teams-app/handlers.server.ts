import { prisma } from "@/lib/db/client";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { createClassificationResolver } from "@/lib/classification/resolver";
import { entityUrl } from "@/lib/mentions/urls";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { runWorkItemQuery, type IssueRow } from "@/lib/work-items/query/project";
import { createWorkItem } from "@/lib/ai/executors/work-items";
import {
  connectCard, createForm, itemCard, messageText, noticeCard, restrictedCard, statusLabel, type Attachment,
} from "./cards";
import { teamsOrgsForTenant, teamsUsers, type TeamsUser } from "./identity.server";

/**
 * COSMOS-202 T1: what the Cosmos for Teams app does with a verified Bot
 * Framework activity. Three message-extension invokes, each answered in the
 * HTTP response (nothing is sent to Teams afterwards):
 *  (a) composeExtension/queryLink: a pasted Cosmos item link becomes a card;
 *  (b) composeExtension/fetchTask + submitAction: "Create Cosmos item" from a
 *      message, through the same create path the assistant uses;
 *  (c) composeExtension/query: find an item and insert its card.
 * Everything is read as the mapped Cosmos user, with their permissions, and a
 * restricted item never leaves as more than its key.
 */

export interface Activity {
  type?: string;
  name?: string;
  value?: unknown;
  channelId?: string;
  serviceUrl?: string;
  from?: { aadObjectId?: string };
  channelData?: { tenant?: { id?: string } };
  conversation?: { tenantId?: string };
}

export interface BotReply {
  status: number;
  body?: unknown;
}

const MAX_RESULTS = 25;
const TYPES = [
  { key: "task", name: "Task" },
  { key: "bug", name: "Bug" },
  { key: "story", name: "Story" },
];

export const tenantOf = (a: Activity) => a.channelData?.tenant?.id ?? a.conversation?.tenantId ?? "";

const results = (attachments: Attachment[]): BotReply => ({
  status: 200,
  body: { composeExtension: { type: "result", attachmentLayout: "list", attachments } },
});
const task = (title: string, card: Record<string, unknown>): BotReply => ({
  status: 200,
  body: { task: { type: "continue", value: { title, width: "medium", height: "large", card: { contentType: "application/vnd.microsoft.card.adaptive", content: card } } } },
});

/** One summary per row, as the person sees it: restricted rows say only their key. */
async function cards(u: TeamsUser, rows: IssueRow[], origin: string, opts: { dropRestricted?: boolean } = {}) {
  const cls = await createClassificationResolver(u.orgId);
  const out: Attachment[] = [];
  for (const r of rows) {
    const url = `${origin}${entityUrl("workItem", { orgSlug: u.slug, id: r.ticketKey })}`;
    if (cls.restricted(r.project.id, r.title)) {
      if (!opts.dropRestricted) out.push(restrictedCard(r.ticketKey, url));
      continue;
    }
    out.push(itemCard({
      ref: r.ticketKey, title: r.title, status: statusLabel(r.columnKey), type: r.type.name,
      project: r.project.name, assignee: r.assignee?.displayName ?? null, url,
    }));
  }
  return out;
}

/** An item by key ("ACME-12") or id, if this person may read it. */
async function findItem(u: TeamsUser, ref: string): Promise<IssueRow | null> {
  if (!hasPermission(u.auth.permissions, Permission.ITEM_READ)) return null;
  const readable = await getReadableProjectIds(u.auth);
  if (!readable.length) return null;
  let id = ref;
  const key = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(ref.trim());
  if (key) {
    // Same rule as the item deep link: a key only within readable projects,
    // and an ambiguous one (two readable projects with that key) not at all.
    const projects = await prisma.project.findMany({
      where: { orgId: u.orgId, id: { in: readable }, key: { equals: key[1], mode: "insensitive" } },
      select: { id: true },
      take: 2,
    });
    if (projects.length !== 1) return null;
    const hit = await prisma.workItem.findFirst({
      where: { orgId: u.orgId, projectId: projects[0].id, ticketNumber: Number(key[2]) },
      select: { id: true },
    });
    if (!hit) return null;
    id = hit.id;
  } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
    return null;
  }
  const r = await runWorkItemQuery({ orgId: u.orgId, allowedProjectIds: readable, filter: { ids: [id] }, sort: undefined, page: 1, pageSize: 1 });
  return r.data[0] ?? null;
}

/** "https://cosmos.example/acme/issues?item=ACME-12" -> { slug, ref }, only for our own origin. */
export function parseItemLink(link: string, origin: string): { slug: string; ref: string } | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.origin !== new URL(origin).origin) return null;
  const m = /^\/([^/]+)\/issues\/?$/.exec(u.pathname);
  const ref = u.searchParams.get("item");
  return m && ref ? { slug: decodeURIComponent(m[1]), ref } : null;
}

async function unfurl(users: TeamsUser[], value: unknown, origin: string, connect: Attachment): Promise<BotReply> {
  const link = parseItemLink(String((value as { url?: unknown } | null)?.url ?? ""), origin);
  if (!link) return results([]);
  const u = users.find((x) => x.slug === link.slug);
  if (!u) return results(users.length ? [] : [connect]);
  const row = await findItem(u, link.ref);
  // Not found and not allowed read the same: nothing, so a link can't probe.
  return results(row ? await cards(u, [row], origin) : []);
}

async function search(users: TeamsUser[], value: unknown, origin: string): Promise<BotReply> {
  const v = (value ?? {}) as { parameters?: { name?: string; value?: unknown }[] };
  const text = String(v.parameters?.find((p) => p.name === "query")?.value ?? "").trim().slice(0, 200);
  const out: Attachment[] = [];
  for (const u of users) {
    if (!hasPermission(u.auth.permissions, Permission.ITEM_READ)) continue;
    const readable = await getReadableProjectIds(u.auth);
    if (!readable.length) continue;
    // Nothing typed yet: what's on your plate.
    const filter = text ? { text } : { assigneeIds: [u.userId] };
    const r = await runWorkItemQuery({
      orgId: u.orgId, allowedProjectIds: readable, filter, sort: { field: "updatedAt", direction: "desc" }, page: 1, pageSize: MAX_RESULTS,
    });
    // A restricted item's card is only its key, which is no use to insert,
    // and listing it for a search would confirm what it says.
    out.push(...(await cards(u, r.data, origin, { dropRestricted: true })));
  }
  return results(out.slice(0, MAX_RESULTS));
}

interface MessagePayload {
  body?: { content?: string };
  linkToMessage?: string;
  from?: { user?: { displayName?: string } };
}

async function creatableProjects(users: TeamsUser[]) {
  const out: { id: string; label: string }[] = [];
  for (const u of users) {
    if (!hasPermission(u.auth.permissions, Permission.ITEM_CREATE)) continue;
    const readable = await getReadableProjectIds(u.auth);
    if (!readable.length) continue;
    const projects = await prisma.project.findMany({
      where: { orgId: u.orgId, id: { in: readable }, archived: false },
      select: { id: true, key: true, name: true },
      orderBy: { name: "asc" },
    });
    for (const p of projects) out.push({ id: `${u.orgId}:${p.id}`, label: users.length > 1 ? `${u.slug} / ${p.name} (${p.key})` : `${p.name} (${p.key})` });
  }
  return out;
}

function prefill(msg: MessagePayload | undefined) {
  const text = messageText(msg?.body?.content ?? "");
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
  const who = msg?.from?.user?.displayName;
  const link = msg?.linkToMessage;
  const footer = [who ? `From a Teams message by ${who}.` : "From a Teams message.", link && /^https:\/\/teams\.microsoft\.com\//.test(link) ? link : null]
    .filter(Boolean)
    .join(" ");
  return { title: firstLine.slice(0, 200), description: `${text}\n\n${footer}`.trim() };
}

async function createTask(users: TeamsUser[], value: unknown, connect: Attachment): Promise<BotReply> {
  if (!users.length) return task("Connect your Cosmos account", connect.content);
  const projects = await creatableProjects(users);
  if (!projects.length) return task("Create Cosmos item", noticeCard("No projects", "You can't create items in any Cosmos project."));
  const p = prefill((value as { messagePayload?: MessagePayload } | null)?.messagePayload);
  return task("Create Cosmos item", createForm({ projects, types: TYPES, ...p }));
}

async function submit(users: TeamsUser[], value: unknown, origin: string, connect: Attachment): Promise<BotReply> {
  if (!users.length) return task("Connect your Cosmos account", connect.content);
  const data = ((value as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
  const [orgId, projectId] = String(data.projectId ?? "").split(":");
  const u = users.find((x) => x.orgId === orgId);
  const title = String(data.title ?? "").trim();
  const description = String(data.description ?? "");
  const type = TYPES.some((t) => t.key === data.type) ? String(data.type) : "task";
  const again = async (error: string) =>
    task("Create Cosmos item", createForm({ projects: await creatableProjects(users), types: TYPES, title, description, error, values: { projectId: String(data.projectId ?? ""), type } }));
  if (!u || !projectId) return again("Pick a project.");
  if (!title) return again("A title is needed.");
  const r = (await createWorkItem(
    { projectId, title: title.slice(0, 500), description, type },
    { orgId: u.orgId, userId: u.userId, auth: u.auth },
  )) as { created?: boolean; id?: string; error?: string };
  if (!r.created || !r.id) return again(r.error ?? "Couldn't create the item.");
  const row = await findItem(u, r.id);
  return results(row ? await cards(u, [row], origin) : []);
}

/**
 * Answer one verified activity. `origin` is Cosmos's public origin (links in
 * cards, and the only host whose links unfurl).
 */
export async function handleActivity(activity: Activity, origin: string): Promise<BotReply> {
  const tenant = tenantOf(activity);
  const orgs = await teamsOrgsForTenant(tenant);
  if (!orgs.length) return { status: 403 };
  // T1 is message extensions only: conversation and install events are acknowledged, not answered.
  if (activity.type !== "invoke") return { status: 200 };
  const users = await teamsUsers(orgs, tenant, activity.from?.aadObjectId ?? "");
  const connect = connectCard(orgs.length === 1 ? `${origin}/${orgs[0].slug}/settings/preferences` : `${origin}/`);
  switch (activity.name) {
    case "composeExtension/queryLink":
      return unfurl(users, activity.value, origin, connect);
    case "composeExtension/query":
      return users.length ? search(users, activity.value, origin) : results([connect]);
    case "composeExtension/fetchTask":
      return createTask(users, activity.value, connect);
    case "composeExtension/submitAction":
      return submit(users, activity.value, origin, connect);
    default:
      return { status: 200, body: {} };
  }
}
