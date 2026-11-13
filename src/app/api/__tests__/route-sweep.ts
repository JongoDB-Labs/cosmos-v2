/**
 * Harness for the "every API route authenticates" sweep
 * (`every-route-authenticates*.db.test.ts`).
 *
 * The proxy lets any request with an API-key-shaped `Bearer cosmos_…` header
 * through to `/api/*` so the route can judge the key itself (src/proxy.ts). So
 * a handler that never asks who the caller is answers the internet. A grep can't find
 * those handlers, because most routes authenticate through helpers, so this
 * imports every `route.ts` and CALLS each exported handler as an anonymous
 * caller, against a real database whose rows the path ids point at. Every
 * route file counts, whatever its extension (`route.ts`, `.tsx`, `.js`, `.jsx`),
 * and so do the route groups composed in from plugins when they are present.
 *
 * Nothing about authentication is mocked. The real `getAuthContext` and
 * `getCurrentUser` run; only `next/headers` is replaced, by a request context
 * this file controls (`fakeNextHeaders`), which is what a route reads its
 * cookie and `Authorization` header from in production. (`next/cache`, and
 * `connection()` / `after()` from `next/server`, are stubbed too: they need a
 * Next request scope.) The two session functions are wrapped in spies so the
 * sweep can tell a 404 that came from asking (and being refused) from one that
 * came from never asking.
 */
import { readdirSync, statSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { createWorkItemRow } from "@/lib/work-items/write.server";
import { seedBoardColumns } from "@/lib/workflow/provision.server";
import { newFeedToken } from "@/lib/calendar/feed-token";
import { unsubscribeToken } from "@/lib/query/subscription-email";
import { KNOWN_OPEN, PLUGIN_KNOWN_OPEN, PUBLIC_HANDLERS, REDIRECT_REFUSALS, UNSEEDED_PARAMS } from "./route-auth-policy";

export const API_ROOT = path.resolve(__dirname, "..");
export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

// ── Route discovery ──────────────────────────────────────────────────────────

export interface RouteFile {
  /** Path under src/app/api without the file name, e.g. `v1/orgs/[orgId]/projects`. */
  rel: string;
  abs: string;
}

/** The file names Next serves a route handler from (its default page extensions). */
const ROUTE_FILE = /^route\.(?:ts|tsx|js|jsx)$/;

/** Every route file under src/app/api, sorted. Read from disk, not a list. */
export function discoverRoutes(): RouteFile[] {
  const out: RouteFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__") continue;
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (ROUTE_FILE.test(name)) out.push({ rel: path.relative(API_ROOT, dir).split(path.sep).join("/"), abs });
    }
  };
  walk(API_ROOT);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** The dynamic segments of a route path, in order (`[orgId]`, `[...rest]`, `[[...rest]]` → the name). */
export function paramNames(rel: string): string[] {
  return [...rel.matchAll(/\[\[?(?:\.\.\.)?([^\]]+)\]?\]/g)].map((m) => m[1]);
}

/** Deterministic shard of a route, so a sweep can be split across files. */
export function shardOf(rel: string, shards: number): number {
  let h = 0;
  for (const c of rel) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % shards;
}

// ── The request context next/headers reads ───────────────────────────────────

interface CookieEntry { name: string; value: string }

const current = { headers: new Headers() as Headers, jar: new Map<string, string>() };

/** Counts the auth questions a handler asked while serving one call. */
export const probe = { sessionCalls: 0, cookieReads: 0 };

function setCurrentRequest(headers: Headers) {
  current.headers = headers;
  current.jar = new Map();
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) current.jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
}

function cookieStore() {
  const jar = current.jar;
  const store = {
    get(nameOrCookie: string | CookieEntry): CookieEntry | undefined {
      const name = typeof nameOrCookie === "string" ? nameOrCookie : nameOrCookie.name;
      return jar.has(name) ? { name, value: jar.get(name)! } : undefined;
    },
    getAll(name?: string): CookieEntry[] {
      return [...jar].filter(([n]) => name === undefined || n === name).map(([n, value]) => ({ name: n, value }));
    },
    has: (name: string) => jar.has(name),
    set(nameOrCookie: string | CookieEntry, value?: string) {
      if (typeof nameOrCookie === "string") jar.set(nameOrCookie, value ?? "");
      else jar.set(nameOrCookie.name, nameOrCookie.value);
      return store;
    },
    delete(name: string | { name: string }) {
      jar.delete(typeof name === "string" ? name : name.name);
      return store;
    },
    get size() { return jar.size; },
    toString: () => [...jar].map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join("; "),
    [Symbol.iterator]: () => store.getAll().map((c) => [c.name, c] as const)[Symbol.iterator](),
  };
  return store;
}

/** The `next/headers` stand-in: what a route handler would see in production. */
export const fakeNextHeaders = {
  headers: async () => current.headers,
  cookies: async () => {
    probe.cookieReads++;
    return cookieStore();
  },
  draftMode: async () => ({ isEnabled: false, enable() {}, disable() {} }),
};

/** `next/cache` outside a Next server: tags and lifetimes are no-ops here. */
export const fakeNextCache = {
  cacheLife: () => {},
  cacheTag: () => {},
  revalidateTag: () => {},
  revalidatePath: () => {},
  updateTag: () => {},
  refresh: () => {},
  unstable_cache: <T>(fn: T) => fn,
  unstable_noStore: () => {},
  unstable_expireTag: () => {},
  unstable_expirePath: () => {},
};

/** Wrap the REAL session functions so the sweep can see they were asked. */
export function spyOnSession<M extends { getAuthContext: (...a: never[]) => unknown; getCurrentUser: (...a: never[]) => unknown }>(real: M): M {
  return {
    ...real,
    getAuthContext: ((...args: Parameters<M["getAuthContext"]>) => {
      probe.sessionCalls++;
      return real.getAuthContext(...args);
    }) as M["getAuthContext"],
    getCurrentUser: ((...args: Parameters<M["getCurrentUser"]>) => {
      probe.sessionCalls++;
      return real.getCurrentUser(...args);
    }) as M["getCurrentUser"],
  };
}

// ── A real world for the path ids to point at ─────────────────────────────────

export interface World {
  stamp: string;
  orgId: string;
  orgSlug: string;
  ownerId: string;
  ownerEmail: string;
  /** A live session cookie for the org's OWNER: the positive control. */
  ownerSession: string;
  /** Real ids by path-param name. A name not listed gets a UUID that matches nothing. */
  ids: Record<string, string>;
  /**
   * Where one param name means different rows on different routes
   * (`templateId` is a board, project or workflow template), the id for the
   * routes under a path prefix. The longest matching prefix wins over `ids`.
   */
  routeIds: Record<string, Record<string, string>>;
  /** The credentials the token routes take: a live calendar feed, an unsubscribe link. */
  tokens: { feed: string; unsubscribe: string };
  subscriptionId: string;
  /** Strings that only the world's rows contain; no refusal may echo one. */
  secrets: string[];
  /**
   * The ids of the world's rows. No refusal may carry one the caller didn't
   * send: a caller who named a row in the path already knows its id.
   */
  rowIds: string[];
  cleanup(): Promise<void>;
}

/** Ids for every param the sweep must be able to point at a real row. */
export async function seedWorld(): Promise<World> {
  const stamp = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  const secretWord = `sweepsecret${stamp}`;
  const owner = await prisma.user.create({
    data: { email: `owner-${stamp}@sweep.test`, displayName: `Owner ${secretWord}` },
  });
  const org = await prisma.organization.create({
    // Calendar feeds on, so the feed route's wrong-token test has a live feed to miss.
    data: { name: `Sweep ${secretWord}`, slug: `sweep-${stamp}`, settings: { calendarFeeds: { enabled: true } } },
  });
  const ownerMember = await prisma.orgMember.create({
    data: { orgId: org.id, userId: owner.id, role: "OWNER" },
  });
  const project = await prisma.project.create({
    data: { orgId: org.id, name: `Project ${secretWord}`, key: `SW${stamp.slice(-4).toUpperCase().replace(/[^A-Z]/g, "Q")}` },
  });
  await prisma.projectMember.create({ data: { projectId: project.id, orgMemberId: ownerMember.id } });
  const board = await prisma.board.create({
    data: { orgId: org.id, projectId: project.id, name: "Board", type: "KANBAN" },
  });
  // Through the provisioning path, so each column's status exists too.
  await seedBoardColumns(prisma, board, [
    { key: "todo", name: "To Do", category: "TODO" },
    { key: "done", name: "Done", category: "DONE" },
  ]);
  const interval = await prisma.interval.create({
    data: {
      orgId: org.id, projectId: project.id, number: 1, name: "Sprint 1", status: "ACTIVE",
      startDate: new Date("2026-10-01"), endDate: new Date("2026-10-14"),
    },
  });
  const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } });
  const item = await createWorkItemRow(prisma, {
    data: {
      orgId: org.id, projectId: project.id, ticketNumber: 1, title: `Item ${secretWord}`,
      columnKey: "todo", workItemTypeId: type.id, createdById: owner.id,
    },
  }, { actorId: null, source: "SYSTEM" });
  const team = await prisma.team.create({ data: { orgId: org.id, projectId: project.id, name: "Team" } });

  // The child rows routes most often address. A name the sweep has no row for
  // gets a UUID that matches nothing; such a 404 counts as a refusal only if
  // the handler asked who the caller is first (see `refusal`).
  const own = { orgId: org.id };
  const doc = await prisma.document.create({
    data: { ...own, projectId: project.id, title: `Doc ${secretWord}`, storageKey: `sweep/${stamp}.txt`, filename: "d.txt", contentType: "text/plain", size: 1, uploadedById: owner.id },
  });
  const channel = await prisma.chatChannel.create({ data: { ...own, kind: "CHANNEL", name: `chan-${stamp}`, createdById: owner.id } });
  await prisma.chatChannelMember.create({ data: { channelId: channel.id, userId: owner.id } });
  const message = await prisma.chatMessage.create({ data: { channelId: channel.id, authorId: owner.id, content: `Message ${secretWord}` } });
  const meeting = await prisma.syncMeeting.create({ data: { ...own, projectId: project.id, meetingDate: new Date("2026-10-02"), createdById: owner.id } });
  const feedback = await prisma.feedbackItem.create({ data: { ...own, authorId: owner.id, title: `Feedback ${secretWord}` } });
  const comment = await prisma.comment.create({ data: { ...own, authorId: owner.id, workItemId: item.id, content: `Comment ${secretWord}` } });
  const note = await prisma.note.create({ data: { ...own, authorId: owner.id } });
  const webhook = await prisma.webhook.create({ data: { ...own, url: "https://hooks.example.com/sweep", secret: randomBytes(16).toString("hex") } });
  const role = await prisma.workRole.create({ data: { ...own, key: `role-${stamp}`, name: "Role" } });
  const contact = await prisma.crmContact.create({ data: { ...own, name: `Contact ${secretWord}` } });
  const partner = await prisma.partner.create({ data: { ...own, name: `Partner ${secretWord}` } });
  const product = await prisma.product.create({ data: { ...own, name: `Product ${secretWord}` } });
  const entry = await prisma.timeEntry.create({ data: { ...own, userId: owner.id, projectId: project.id, date: new Date("2026-10-02"), hours: 1 } });
  const milestone = await prisma.milestone.create({ data: { ...own, projectId: project.id, title: `Milestone ${secretWord}`, dueDate: new Date("2026-12-01") } });
  const workflow =
    (await prisma.workflow.findFirst({ where: { projectId: project.id }, select: { id: true } })) ??
    (await prisma.workflow.create({ data: { ...own, projectId: project.id, name: "Workflow", createdById: owner.id } }));
  const view = await prisma.savedView.create({ data: { ...own, ownerId: owner.id, name: `View ${secretWord}` } });
  const subscription = await prisma.filterSubscription.create({
    data: {
      ...own, savedViewId: view.id, createdById: owner.id, recipientUserId: owner.id, nextRunAt: new Date(Date.now() + 86_400_000),
      unsubscribeKey: randomBytes(32).toString("hex"), appOrigin: "https://cosmos.example.com",
    },
  });
  const feedToken = newFeedToken();
  const feed = await prisma.calendarFeed.create({ data: { ...own, userId: owner.id, tokenHash: feedToken.tokenHash } });

  // Rows for the params many routes share, so a 404 on them is evidence.
  const by = { ...own, createdById: owner.id };
  const boardTemplate = await prisma.boardTemplate.create({ data: { ...own, slug: `bt-${stamp}`, name: `Board template ${secretWord}`, category: "custom" } });
  const projectTemplate = await prisma.projectTemplate.create({ data: { ...own, slug: `pt-${stamp}`, sector: "custom", name: `Project template ${secretWord}` } });
  const workflowTemplate = await prisma.workflow.create({ data: { ...own, projectId: null, name: `Workflow template ${stamp}`, createdById: owner.id } });
  const invoice = await prisma.invoice.create({ data: { ...by, number: `INV-${stamp}`, billToName: `Client ${secretWord}` } });
  const contract = await prisma.contract.create({ data: { ...own, title: `Contract ${secretWord}` } });
  const bankAccount = await prisma.bankAccount.create({ data: { ...by, name: `Account ${secretWord}` } });
  const txn = await prisma.bankTransaction.create({
    data: { ...own, bankAccountId: bankAccount.id, fingerprint: `fp-${stamp}`, postedDate: new Date("2026-10-02"), amount: 12.5 },
  });
  const bankRule = await prisma.bankRule.create({ data: { ...by, category: "Office" } });
  // Off, and with no permissions to act with: it exists only to be addressed.
  const automation = await prisma.automationRule.create({
    data: {
      ...own, projectId: project.id, name: `Rule ${secretWord}`, enabled: false, actorCap: "0", ownerId: owner.id,
      spec: { trigger: { on: "item.updated" }, actions: [{ kind: "addComment", body: "x" }] },
    },
  });
  const itemType = await prisma.workItemType.create({ data: { ...own, key: `type-${stamp}`, name: "Sweep type" } });
  const meetingType = await prisma.meetingTypeOption.create({ data: { ...own, label: `Meeting type ${stamp}` } });
  const timeOff = await prisma.timeOffRequest.create({
    data: { ...own, userId: owner.id, kind: "VACATION", startDate: new Date("2026-12-01"), endDate: new Date("2026-12-02") },
  });
  const accountRequest = await prisma.accountRequest.create({ data: { ...own, email: `asks-${stamp}@sweep.test`, modeAtRequest: "OPEN" } });
  const payRun = await prisma.payRun.create({ data: { ...by, periodStart: new Date("2026-10-01"), periodEnd: new Date("2026-10-14") } });
  const objective = await prisma.objective.create({ data: { ...own, projectId: project.id, title: `Objective ${secretWord}` } });
  const keyResult = await prisma.keyResult.create({ data: { objectiveId: objective.id, title: `Key result ${secretWord}` } });
  const kpi = await prisma.kpi.create({ data: { ...own, projectId: project.id, name: `KPI ${secretWord}` } });
  const goal = await prisma.goal.create({ data: { ...own, projectId: project.id, title: `Goal ${secretWord}` } });
  const expense = await prisma.expense.create({ data: { ...by, amount: 3, date: new Date("2026-10-02"), category: "Travel" } });
  const item2 = await createWorkItemRow(prisma, {
    data: {
      orgId: org.id, projectId: project.id, ticketNumber: 2, title: `Second item ${secretWord}`,
      columnKey: "todo", workItemTypeId: type.id, createdById: owner.id,
    },
  }, { actorId: null, source: "SYSTEM" });
  const itemLink = await prisma.workItemLink.create({ data: { ...own, sourceItemId: item.id, targetItemId: item2.id, type: "RELATES" } });
  const goalLink = await prisma.goalLink.create({ data: { goalId: goal.id, kind: "WORK_ITEM", workItemId: item.id } });
  const milestoneLink = await prisma.milestoneLink.create({ data: { milestoneId: milestone.id, workItemId: item.id } });
  const pmLink = await prisma.pmLink.create({
    data: { ...by, projectId: project.id, fromType: "milestone", fromId: milestone.id, toType: "work_item", toId: item.id },
  });

  const sessionId = randomBytes(32).toString("hex");
  await prisma.session.create({
    data: { id: sessionId, userId: owner.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });

  const ids: Record<string, string> = {
    orgId: org.id,
    orgSlug: org.slug,
    slug: org.slug,
    userId: owner.id,
    memberId: ownerMember.id,
    projectId: project.id,
    boardId: board.id,
    intervalId: interval.id,
    itemId: item.id,
    teamId: team.id,
    docId: doc.id,
    channelId: channel.id,
    messageId: message.id,
    meetingId: meeting.id,
    feedbackId: feedback.id,
    commentId: comment.id,
    noteId: note.id,
    webhookId: webhook.id,
    roleId: role.id,
    contactId: contact.id,
    partnerId: partner.id,
    productId: product.id,
    entryId: entry.id,
    milestoneId: milestone.id,
    workflowId: workflow.id,
    viewId: view.id,
    subId: subscription.id,
    feedId: feed.id,
    invoiceId: invoice.id,
    contractId: contract.id,
    bankAccountId: bankAccount.id,
    txnId: txn.id,
    payRunId: payRun.id,
    objectiveId: objective.id,
    krId: keyResult.id,
    kpiId: kpi.id,
    goalId: goal.id,
    expenseId: expense.id,
    // Not ids, but path values a route checks before anything else.
    entity: "projects",
    version: "1",
  };
  const O = "v1/orgs/[orgId]";
  const P = `${O}/projects/[projectId]`;
  const routeIds: Record<string, Record<string, string>> = {
    [`${O}/templates`]: { templateId: boardTemplate.id },
    [`${O}/board-templates`]: { templateId: boardTemplate.id },
    [`${O}/project-templates`]: { templateId: projectTemplate.id },
    [`${O}/workflow-templates`]: { templateId: workflowTemplate.id },
    [`${O}/work-item-types`]: { typeId: itemType.id },
    [`${O}/meeting-types`]: { typeId: meetingType.id },
    [`${O}/automations`]: { ruleId: automation.id },
    [`${O}/bank-rules`]: { ruleId: bankRule.id },
    [`${O}/time-off`]: { requestId: timeOff.id },
    [`${O}/account-requests`]: { requestId: accountRequest.id },
    [`${P}/work-item-links`]: { linkId: itemLink.id },
    [`${P}/pm-links`]: { linkId: pmLink.id },
    [`${P}/goals/[goalId]/links`]: { linkId: goalLink.id },
    [`${P}/milestones/[milestoneId]/links`]: { linkId: milestoneLink.id },
  };
  const rowIds = [
    owner.id, ownerMember.id, project.id, board.id, interval.id, item.id, item2.id, team.id,
    ...Object.entries(ids).filter(([k]) => k.endsWith("Id") && k !== "orgId").map(([, v]) => v),
    ...Object.values(routeIds).flatMap((m) => Object.values(m)),
  ].filter((v, i, all) => all.indexOf(v) === i);

  return {
    stamp,
    orgId: org.id,
    orgSlug: org.slug,
    ownerId: owner.id,
    ownerEmail: owner.email,
    ownerSession: sessionId,
    ids,
    routeIds,
    tokens: {
      feed: feedToken.token,
      unsubscribe: unsubscribeToken(subscription.unsubscribeKey, subscription.id, owner.id),
    },
    subscriptionId: subscription.id,
    secrets: [secretWord, owner.email],
    rowIds,
    async cleanup() {
      await prisma.session.deleteMany({ where: { userId: owner.id } });
      await prismaUnfiltered.orgMember.deleteMany({ where: { orgId: org.id } }).catch(() => undefined);
      await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: owner.id } }).catch(() => undefined);
    },
  };
}

// ── Calling a handler ─────────────────────────────────────────────────────────

/**
 * Who the caller claims to be.
 * - `anonymous`: no credentials.
 * - `fake-key`: a well-formed API key that doesn't exist.
 * - `bad-path`: no credentials, and every path value but the org's is
 *   malformed, so a handler that validates the path before it authenticates
 *   answers 400 instead of 401.
 * - `owner`: the org's owner, signed in (the positive control).
 */
export type Caller = "anonymous" | "fake-key" | "bad-path" | "owner";
export const FAKE_KEY = "cosmos_000000000000_fake";

export interface Outcome {
  status: number;
  /** The whole body (up to 1 MB, or until a stream goes quiet), for the leak check. */
  body: string;
  /** The URL the call was made to: a caller already knows any id it sent. */
  url: string;
  /** Set when the handler threw instead of answering. */
  threw?: string;
  /** Whether the handler asked who the caller is (session functions or the cookie jar). */
  asked: boolean;
  location?: string | null;
}

/** Path values a `bad-path` caller keeps real: the org the request is about. */
const ORG_PARAMS = new Set(["orgId", "orgSlug", "slug"]);

/** The ids a route's path takes: `ids`, overridden by the longest `routeIds` prefix of the route. */
export function idsFor(rel: string, world: Pick<World, "ids" | "routeIds">): Record<string, string> {
  const prefixes = Object.keys(world.routeIds)
    .filter((p) => rel === p || rel.startsWith(`${p}/`))
    .sort((a, b) => a.length - b.length);
  return Object.assign({}, world.ids, ...prefixes.map((p) => world.routeIds[p]));
}

/** Path params other than the org's whose name the sweep has a real row for on this route. */
export function unseededParams(rel: string, world: Pick<World, "ids" | "routeIds">): string[] {
  const ids = idsFor(rel, world);
  return paramNames(rel).filter((n) => !ORG_PARAMS.has(n) && !(n in ids));
}

export function urlFor(rel: string, ids: Record<string, string>, badPath = false): { url: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  // A route group, `(name)`, is not part of the URL.
  const urlPath = rel.replace(/(^|\/)\([^)]+\)(?=\/|$)/g, "").replace(/^\//, "").replace(/\[\[?(?:\.\.\.)?([^\]]+)\]?\]/g, (_, name: string) => {
    params[name] = badPath && !ORG_PARAMS.has(name) ? "not-a-valid-id" : (ids[name] ?? (ids[`__fake_${name}`] ??= randomUUID()));
    return params[name];
  });
  return { url: `http://localhost/api/${urlPath}`, params };
}

const CALL_TIMEOUT_MS = 15_000;
const MAX_BODY = 1024 * 1024;
let callCount = 0;

export async function callHandler(
  handler: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => unknown,
  method: HttpMethod,
  rel: string,
  caller: Caller,
  world: World,
): Promise<Outcome> {
  const { url, params } = urlFor(rel, idsFor(rel, world), caller === "bad-path");
  const headers = new Headers({
    host: "localhost",
    origin: "http://localhost",
    "user-agent": "route-auth-sweep",
    // A fresh address per call, so no per-IP rate limit answers 429 in place
    // of the handler.
    "x-forwarded-for": `198.18.${(++callCount >> 8) & 255}.${callCount & 255}`,
  });
  if (caller === "fake-key") headers.set("authorization", `Bearer ${FAKE_KEY}`);
  if (caller === "owner") {
    headers.set("cookie", `session=${world.ownerSession}`);
    // A handler earlier in the sweep may have ended the session (sign-out
    // does): the control needs it live every time.
    await prisma.session.upsert({
      where: { id: world.ownerSession },
      create: { id: world.ownerSession, userId: world.ownerId, expiresAt: new Date(Date.now() + 3_600_000) },
      update: { expiresAt: new Date(Date.now() + 3_600_000), lastActivityAt: new Date() },
    });
  }
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (hasBody) headers.set("content-type", "application/json");
  // The fake key sends a body that isn't JSON: a handler that reads the body
  // before it authenticates then answers 400 instead of 401, and is caught.
  const body = caller === "fake-key" ? "not json" : "{}";
  const req = new NextRequest(url, { method, headers, ...(hasBody && { body }) });

  setCurrentRequest(headers);
  probe.sessionCalls = 0;
  probe.cookieReads = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = (await Promise.race([
      Promise.resolve(handler(req, { params: Promise.resolve(params) })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS);
      }),
    ])) as Response | undefined;
    const asked = probe.sessionCalls > 0 || probe.cookieReads > 0;
    if (!(res instanceof Response)) return { status: 0, body: "", url, threw: `returned ${typeof res}`, asked };
    let body = "";
    if (res.body) {
      // All of it, up to a cap, for the leak check. A stream (SSE) that never
      // ends must not hang the sweep, so a read that waits 2s ends it.
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      try {
        while (body.length < MAX_BODY) {
          const chunk = await Promise.race([
            reader.read(),
            new Promise<{ done: true; value?: undefined }>((r) => setTimeout(() => r({ done: true }), 2000)),
          ]);
          if (chunk.done) break;
          body += dec.decode(chunk.value, { stream: true });
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }
    }
    return { status: res.status, body, url, asked, location: res.headers.get("location") };
  } catch (e) {
    const asked = probe.sessionCalls > 0 || probe.cookieReads > 0;
    const digest = (e as { digest?: string })?.digest ?? "";
    // next/navigation's notFound() / redirect() throw; a route that uses them
    // answers 404 / a redirect in production.
    if (digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) return { status: 404, body: "", url, asked };
    if (digest.startsWith("NEXT_REDIRECT")) return { status: 307, body: "", url, asked, location: digest.split(";")[2] ?? null };
    return { status: 0, body: "", url, threw: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300), asked };
  } finally {
    clearTimeout(timer);
  }
}

/** The HTTP handlers a route module exports. */
export function handlersOf(mod: Record<string, unknown>): Array<[HttpMethod, (...a: never[]) => unknown]> {
  return HTTP_METHODS.filter((m) => typeof mod[m] === "function").map((m) => [m, mod[m] as (...a: never[]) => unknown]);
}

/**
 * What a 404 can prove. A 404 refuses only when the path ids point at real
 * rows: then "not found" means "not for you". Where the sweep has no row, a
 * handler that asks who the caller is, ignores the answer, and serves any row
 * by id also answers 404, and the sweep can't tell the two apart.
 */
export interface NotFoundEvidence {
  /** Path params (other than the org's) the sweep has no row for, and no listed reason. */
  unseeded: string[];
  /** The org's owner gets 404 here too, so the ids the sweep sent don't resolve. */
  ownerAlso404: boolean;
}

/** The origin every sweep request is made from. */
export const SWEEP_ORIGIN = "http://localhost";

/**
 * Why an outcome is NOT a refusal, or null when it is one.
 *
 * - 401 and 403 refuse.
 * - A redirect refuses only when it sends the caller to this app's own /login
 *   (what a browser-facing route does), or to the one page REDIRECT_REFUSALS
 *   names for this handler. One to any other path or host doesn't.
 * - A 404 refuses only if the handler asked who the caller is first AND the
 *   path ids are known to point at real rows (`NotFoundEvidence`). Otherwise
 *   it fails until the sweep is given a real row for the param, or the param
 *   is listed in UNSEEDED_PARAMS with a reason.
 * - Anything else (a 200, a 400 from validating before authenticating, a
 *   crash) answered someone the route never identified.
 */
export function refusal(
  o: Outcome,
  notFound: NotFoundEvidence = { unseeded: [], ownerAlso404: false },
  redirectRefusal?: string,
): string | null {
  if (o.threw) return `threw before refusing: ${o.threw}`;
  if (o.status === 401 || o.status === 403) return null;
  if (o.status >= 300 && o.status < 400 && o.location) {
    const to = new URL(o.location, SWEEP_ORIGIN);
    if (to.origin === SWEEP_ORIGIN && (to.pathname === "/login" || to.pathname === redirectRefusal)) return null;
    return `redirected to ${to.origin}${to.pathname}, not to this app's /login${redirectRefusal ? ` or ${redirectRefusal}` : ""}`;
  }
  if (o.status === 404) {
    if (!o.asked) return "answered 404 without asking who the caller is (authenticate first, or give the sweep a real row for this path)";
    if (notFound.unseeded.length > 0) {
      return `answered 404 for ${notFound.unseeded.join(", ")}, which the sweep has no row for, so the 404 proves nothing (seed one in route-sweep.ts, or list the param in UNSEEDED_PARAMS with a reason)`;
    }
    if (notFound.ownerAlso404) {
      return "answered 404, and so did the org's owner, so the ids the sweep sent don't resolve here and the 404 proves nothing (seed a row this route finds)";
    }
    return null;
  }
  return `answered ${o.status}${o.status === 400 ? " (validated the request before authenticating)" : ""}`;
}

/** Which of the world's secret strings and row ids a response carries that its caller didn't send. */
export function leaked(o: Outcome, world: Pick<World, "secrets" | "rowIds">): string[] {
  if (!o.body) return [];
  return [...world.secrets, ...world.rowIds].filter((v) => !o.url.includes(v) && o.body.includes(v));
}

// ── The sweep itself ─────────────────────────────────────────────────────────

/** Path values other than the org's: only those can be malformed by `bad-path`. */
const hasOwnPathValues = (rel: string) => paramNames(rel).some((n) => !["orgId", "orgSlug", "slug"].includes(n));

/**
 * One shard of the sweep: every route under src/app/api whose `shardOf` is
 * `shard`, one test per route file. The calling test file must install the
 * `next/headers`, `next/cache`, `next/server` and session mocks (vi.mock is
 * per file); see every-route-authenticates.db.test.ts.
 */
/** How many test files the sweep is split across, so they run in parallel. */
export const SWEEP_SHARDS = 4;

export function defineRouteSweep(shard: number, of = SWEEP_SHARDS) {
  let world: World;
  beforeAll(async () => {
    world = await seedWorld();
    // No handler reaches the network: a provider call fails like an outage.
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network disabled in the route sweep");
    });
  }, 60_000);
  afterAll(async () => {
    vi.unstubAllGlobals();
    await world?.cleanup();
  });

  const routes = discoverRoutes().filter((r) => shardOf(r.rel, of) === shard);
  for (const r of routes) {
    it(r.rel, async () => {
      const mod = (await import(/* @vite-ignore */ r.abs)) as Record<string, unknown>;
      const handlers = handlersOf(mod);
      expect(handlers.length, `${r.rel}/${path.basename(r.abs)} exports no HTTP handler`).toBeGreaterThan(0);
      const problems: string[] = [];

      // The positive control, first: the org's signed-in owner is not refused
      // as unidentified, so the refusals below came from asking, not from a
      // broken harness. GET only, since it changes nothing; sign-in and
      // sign-out are skipped, since signing out ends the control's session.
      // Whether the owner finds the path's rows is also what lets an
      // anonymous 404 count as a refusal (see NotFoundEvidence).
      const get = handlers.find(([m]) => m === "GET");
      let owner: Outcome | undefined;
      if (get && !r.rel.startsWith("auth/")) {
        owner = await callHandler(get[1] as never, "GET", r.rel, "owner", world);
        if (owner.threw || owner.status === 401) {
          problems.push(`GET ${r.rel} as the org's owner: ${owner.threw ? `threw ${owner.threw}` : "401"} (the positive control failed)`);
        }
      }
      const unseeded = unseededParams(r.rel, world).filter((n) => !(n in UNSEEDED_PARAMS));
      const ownIds = paramNames(r.rel).filter((n) => !ORG_PARAMS.has(n));
      const pathEvidence: NotFoundEvidence = {
        unseeded,
        ownerAlso404: owner?.status === 404 && ownIds.some((n) => !(n in UNSEEDED_PARAMS)),
      };

      for (const [method, handler] of handlers) {
        const key = `${method} ${r.rel}`;
        const isPublic = key in PUBLIC_HANDLERS;
        const knownOpen = key in KNOWN_OPEN || key in PLUGIN_KNOWN_OPEN;
        const callers: Caller[] = hasOwnPathValues(r.rel) ? ["anonymous", "fake-key", "bad-path"] : ["anonymous", "fake-key"];
        let answered = false;
        for (const caller of callers) {
          const o = await callHandler(handler as never, method, r.rel, caller, world);
          // `bad-path` sends ids that can't exist on purpose; it is there to
          // catch a handler that validates the path before it authenticates (a
          // 400), so its 404s need no evidence about rows.
          const why = refusal(o, caller === "bad-path" ? undefined : pathEvidence, REDIRECT_REFUSALS[key]?.to);
          if (why) answered = true;
          if (why && !isPublic && !knownOpen) problems.push(`${key} as ${caller}: ${why}`);
          const carried = knownOpen ? [] : leaked(o, world);
          if (carried.length > 0) {
            problems.push(`${key} as ${caller}: the response carries the org's data (${carried.length} value(s) the caller didn't send)`);
          }
        }
        if (knownOpen && !answered) {
          problems.push(`${key} now refuses every caller: remove it from ${key in KNOWN_OPEN ? "KNOWN_OPEN" : "PLUGIN_KNOWN_OPEN"} in route-auth-policy.ts`);
        }
      }
      expect(problems).toEqual([]);
    }, 120_000);
  }
}
