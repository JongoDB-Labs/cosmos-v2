// @vitest-environment node
// (e2e DB) Filter subscriptions (query design §12.4): who may subscribe whom,
// the run (as each recipient, once per schedule, even with two ticks at once),
// what the email may carry (§6.6), and unsubscribing without a session.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { withCqlEnabled, withCqlEmailTitles } from "../flag";
import { viewerScope, type ViewerScope } from "../saved-filters.server";
import { createSubscription, loadView, runDueSubscriptions, subscriptionProblem, type SendFn } from "../subscriptions.server";
import { MARKED, unsubscribeToken } from "../subscription-email";
import { parseCql } from "../parser";
import { seedWorld, type World } from "./cql-fixture";

import { GET as unsubGet, POST as unsubPost } from "@/app/api/v1/unsubscribe/filter/[token]/route";

let w: World;
let actorScope: ViewerScope;
let actorEmail: string;
let bobEmail: string;

type Mail = Parameters<SendFn>[0];
const outbox: Mail[] = [];
const send: SendFn = async (m) => {
  outbox.push(m);
};

/** A filter owned by the actor, with this query and visibility. */
async function filter(cql: string, extra: { visibility?: "PRIVATE" | "PROJECT" | "TEAM" | "ORG"; projectId?: string; teamId?: string } = {}) {
  const v = await prisma.savedView.create({
    data: {
      orgId: w.orgA, ownerId: w.actor.id, name: `f-${Math.random().toString(36).slice(2, 8)}`,
      query: parseCql(cql).query as object, cqlText: cql, visibility: extra.visibility ?? "PRIVATE",
      projectId: extra.projectId ?? null, teamId: extra.teamId ?? null, shared: extra.visibility === "ORG",
    },
  });
  return (await loadView(w.orgA, v.id))!;
}

/** Make every live subscription due now, and run. */
async function runNow(now = new Date()) {
  await prisma.filterSubscription.updateMany({ where: { orgId: w.orgA, disabledAt: null }, data: { nextRunAt: new Date(now.getTime() - 1000) } });
  return runDueSubscriptions({ now, send });
}
const mailTo = (email: string) => outbox.filter((m) => m.to === email);

beforeAll(async () => {
  w = await seedWorld();
  await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
  actorScope = await viewerScope((await loadMemberAuthContext(w.orgA, w.actor.id))!);
  actorEmail = w.actor.email;
  bobEmail = (await prisma.user.findUniqueOrThrow({ where: { id: w.bob.id } })).email;
}, 60_000);
afterAll(async () => {
  await w?.cleanup();
});
// Each test's subscriptions go with it, so one failure can't make the next send twice.
afterEach(async () => {
  await prisma.filterSubscription.deleteMany({ where: { orgId: w.orgA } });
});

const ORIGIN = "https://cosmos.example";

describe("who may subscribe whom", () => {
  it("yourself, to any filter you can see; the schedule is checked", async () => {
    const v = await filter("priority = CRITICAL");
    expect(await subscriptionProblem(actorScope, v, { recipient: { kind: "me" }, cron: "0 8 * * 1-5", timezone: "UTC" })).toBeNull();
    expect(await subscriptionProblem(actorScope, v, { recipient: { kind: "me" }, cron: "* 8 * * *", timezone: "UTC" })).toMatch(/once an hour/);
    // Bob's private filter: not visible, so it doesn't exist.
    const bobs = await prisma.savedView.create({ data: { orgId: w.orgA, ownerId: w.bob.id, name: `b-${w.stamp}` } });
    expect(await subscriptionProblem(actorScope, (await loadView(w.orgA, bobs.id))!, { recipient: { kind: "me" }, cron: "0 8 * * *", timezone: "UTC" })).toBe("Filter not found");
  });

  it("a team: only one you're on, whose project you manage, and only for a filter shared with it", async () => {
    const team = { kind: "team" as const, teamId: w.teamP1 };
    const shared = await filter("priority = HIGH", { visibility: "PROJECT", projectId: w.P1.id });
    expect(await subscriptionProblem(actorScope, shared, { recipient: team, cron: "0 8 * * *", timezone: "UTC" })).toMatch(/team you're on/);

    const pm = await prisma.projectMember.findFirstOrThrow({ where: { projectId: w.P1.id, orgMember: { userId: w.actor.id } } });
    await prisma.teamMember.create({ data: { teamId: w.teamP1, projectMemberId: pm.id } });
    let s = await viewerScope((await loadMemberAuthContext(w.orgA, w.actor.id))!);
    expect(await subscriptionProblem(s, shared, { recipient: team, cron: "0 8 * * *", timezone: "UTC" })).toMatch(/managing its project/);

    await prisma.projectMember.update({ where: { id: pm.id }, data: { role: "MANAGER" } });
    s = await viewerScope((await loadMemberAuthContext(w.orgA, w.actor.id))!);
    const priv = await filter("priority = HIGH");
    expect(await subscriptionProblem(s, priv, { recipient: team, cron: "0 8 * * *", timezone: "UTC" })).toMatch(/Share the filter/);
    expect(await subscriptionProblem(s, shared, { recipient: team, cron: "0 8 * * *", timezone: "UTC" })).toBeNull();
    actorScope = s;
  });
});

describe("the run", () => {
  it("sends each recipient their own rows, keys and links only for GOV, once per schedule", async () => {
    outbox.length = 0;
    const v = await filter("priority = CRITICAL");
    const sub = await createSubscription(actorScope, v, { recipient: { kind: "me" }, cron: "0 8 * * *", timezone: "UTC" }, ORIGIN);
    const r = await runNow();
    expect(r.sent).toBeGreaterThanOrEqual(1);
    const [mail] = mailTo(actorEmail).filter((m) => m.subject.startsWith(v.name));
    const key = `${w.P1.key}-${w.items["p1-login-bug"].ticketNumber}`;
    expect(mail.text).toContain(key);
    expect(mail.text).toContain(`${ORIGIN}/`);
    // GOV by default: no titles.
    expect(mail.text).not.toContain("p1-login-bug");
    expect(mail.html).not.toContain("p1-login-bug");
    for (const secret of w.secrets) expect(mail.text + mail.html).not.toContain(secret);
    expect(mail.text).toContain(`/api/v1/unsubscribe/filter/${sub.id}.${w.actor.id}.`);

    // The next run is tomorrow 08:00; running again now sends nothing.
    const after = await prisma.filterSubscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    const before = outbox.length;
    await runDueSubscriptions({ now: new Date(), send });
    expect(outbox.length).toBe(before);
    await prisma.filterSubscription.delete({ where: { id: sub.id } });
  });

  it("two ticks at once send one email", async () => {
    outbox.length = 0;
    const v = await filter("priority = CRITICAL");
    await createSubscription(actorScope, v, { recipient: { kind: "me" }, cron: "0 8 * * *", timezone: "UTC" }, ORIGIN);
    await prisma.filterSubscription.updateMany({ where: { orgId: w.orgA, disabledAt: null }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    await Promise.all([runDueSubscriptions({ send }), runDueSubscriptions({ send }), runDueSubscriptions({ send })]);
    expect(mailTo(actorEmail).filter((m) => m.subject.startsWith(v.name))).toHaveLength(1);
    await prisma.filterSubscription.deleteMany({ where: { savedViewId: v.id } });
  });

  it("moves a slot missed by more than an hour (the jobs were down) on to the next one, and sends nothing for it", async () => {
    outbox.length = 0;
    const v = await filter("priority = CRITICAL");
    await createSubscription(actorScope, v, { recipient: { kind: "me" }, cron: "0 8 * * *", timezone: "UTC" }, ORIGIN);
    const now = new Date();
    await prisma.filterSubscription.updateMany({ where: { savedViewId: v.id }, data: { nextRunAt: new Date(now.getTime() - 2 * 3_600_000) } });
    const r = await runDueSubscriptions({ now, send });
    expect(r).toMatchObject({ missed: 1, sent: 0 });
    expect(mailTo(actorEmail).filter((m) => m.subject.startsWith(v.name))).toHaveLength(0);
    const after = await prisma.filterSubscription.findFirstOrThrow({ where: { savedViewId: v.id } });
    expect(after.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
    // Late by less than the window still goes out.
    await prisma.filterSubscription.updateMany({ where: { savedViewId: v.id }, data: { nextRunAt: new Date(now.getTime() - 30 * 60_000) } });
    expect(await runDueSubscriptions({ now, send })).toMatchObject({ missed: 0 });
    expect(mailTo(actorEmail).filter((m) => m.subject.startsWith(v.name))).toHaveLength(1);
    await prisma.filterSubscription.deleteMany({ where: { savedViewId: v.id } });
  });

  it("still sends a missed weekly digest late: its next slot is too far off to stand in for it", async () => {
    outbox.length = 0;
    const v = await filter("priority = CRITICAL");
    await createSubscription(actorScope, v, { recipient: { kind: "me" }, cron: "0 8 * * 1", timezone: "UTC" }, ORIGIN);
    // A Wednesday: the next Monday 08:00 is five days off.
    const now = new Date("2026-10-28T10:00:00.000Z");
    await prisma.filterSubscription.updateMany({ where: { savedViewId: v.id }, data: { nextRunAt: new Date(now.getTime() - 2 * 3_600_000) } });
    expect(await runDueSubscriptions({ now, send })).toMatchObject({ missed: 0 });
    expect(mailTo(actorEmail).filter((m) => m.subject.startsWith(v.name))).toHaveLength(1);
    expect((await prisma.filterSubscription.findFirstOrThrow({ where: { savedViewId: v.id } })).nextRunAt.toISOString()).toBe("2026-11-02T08:00:00.000Z");
    await prisma.filterSubscription.deleteMany({ where: { savedViewId: v.id } });
  });

  it("titles when the org allows them; a marked title or filter name is never sent", async () => {
    outbox.length = 0;
    await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEmailTitles(withCqlEnabled({}, true), true) as object } });
    const marked = await prisma.workItem.create({
      data: {
        orgId: w.orgA, projectId: w.P1.id, ticketNumber: 9000 + Math.floor(Math.random() * 999), title: "CUI//SP-PRVCY payroll export",
        description: "", columnKey: "todo", workItemTypeId: w.typeTask, createdById: w.actor.id, priority: "CRITICAL",
      },
    });
    try {
      const v = await filter("priority = CRITICAL");
      await prisma.savedView.update({ where: { id: v.id }, data: { name: `FOUO filter ${w.stamp}` } });
      await createSubscription(actorScope, v, { recipient: { kind: "me" }, cron: "0 8 * * *", timezone: "UTC" }, ORIGIN);
      await runNow();
      const [mail] = mailTo(actorEmail);
      expect(mail.text).toContain("p1-login-bug");
      expect(mail.text).toContain(MARKED);
      expect(mail.text + mail.html + mail.subject).not.toMatch(/payroll|FOUO/);
      expect(mail.subject).toMatch(/^Saved filter: /);
      await prisma.filterSubscription.deleteMany({ where: { savedViewId: v.id } });
    } finally {
      await prisma.workItem.delete({ where: { id: marked.id } });
      await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
    }
  });

  it("a team subscription runs as each member: `me` is the recipient, a muted member gets nothing", async () => {
    outbox.length = 0;
    const v = await filter("assignee = me", { visibility: "TEAM", teamId: w.teamP1 });
    const sub = await createSubscription(actorScope, v, { recipient: { kind: "team", teamId: w.teamP1 }, cron: "0 8 * * *", timezone: "UTC" }, ORIGIN);
    await runNow();
    const bobs = mailTo(bobEmail).filter((m) => m.subject.startsWith(v.name));
    const mine = mailTo(actorEmail).filter((m) => m.subject.startsWith(v.name));
    expect(bobs).toHaveLength(1);
    expect(mine).toHaveLength(1);
    const key = (n: string) => `${w.P1.key}-${w.items[n].ticketNumber}`;
    expect(bobs[0].text).toContain(key("p1-done"));
    expect(bobs[0].text).not.toContain(key("p1-login-bug"));
    expect(mine[0].text).toContain(key("p1-login-bug"));
    expect(mine[0].text).not.toContain(key("p1-done"));
    expect(bobs[0].text).toContain("your team Platform is subscribed");

    // Bob unsubscribes by link: muted, the team subscription carries on.
    const row = await prisma.filterSubscription.findUniqueOrThrow({ where: { id: sub.id } });
    const token = unsubscribeToken(row.unsubscribeKey, sub.id, w.bob.id);
    const res = await unsubPost(new NextRequest(`${ORIGIN}/api/v1/unsubscribe/filter/${token}`, { method: "POST" }), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(200);
    outbox.length = 0;
    await runNow();
    expect(mailTo(bobEmail).filter((m) => m.subject.startsWith(v.name))).toHaveLength(0);
    expect(mailTo(actorEmail).filter((m) => m.subject.startsWith(v.name))).toHaveLength(1);
    expect((await prisma.filterSubscription.findUniqueOrThrow({ where: { id: sub.id } })).disabledAt).toBeNull();
    await prisma.filterSubscription.delete({ where: { id: sub.id } });
  });

  it("only new items: nothing new, nothing sent; a new match, just that one", async () => {
    outbox.length = 0;
    const v = await filter(`priority = CRITICAL AND project = ${w.P1.key}`);
    await createSubscription(actorScope, v, { recipient: { kind: "me" }, cron: "0 8 * * *", timezone: "UTC", onlyChanges: true }, ORIGIN);
    await runNow();
    expect(mailTo(actorEmail)).toHaveLength(1);
    await runNow();
    expect(mailTo(actorEmail)).toHaveLength(1);
    const fresh = await prisma.workItem.create({
      data: {
        orgId: w.orgA, projectId: w.P1.id, ticketNumber: 8000 + Math.floor(Math.random() * 999), title: "fresh", description: "",
        columnKey: "todo", workItemTypeId: w.typeTask, createdById: w.actor.id, priority: "CRITICAL",
      },
    });
    try {
      await runNow();
      const last = mailTo(actorEmail).at(-1)!;
      expect(mailTo(actorEmail)).toHaveLength(2);
      expect(last.subject).toMatch(/: 1 new item$/);
      expect(last.text).toContain(`${w.P1.key}-${fresh.ticketNumber}`);
      expect(last.text).not.toContain(`${w.P1.key}-${w.items["p1-login-bug"].ticketNumber} `);
    } finally {
      await prisma.workItem.delete({ where: { id: fresh.id } });
      await prisma.filterSubscription.deleteMany({ where: { savedViewId: v.id } });
    }
  });

  it("no results: nothing, unless sendWhenEmpty", async () => {
    outbox.length = 0;
    const v = await filter('summary ~ "nothing-matches-this"');
    const quiet = await createSubscription(actorScope, v, { recipient: { kind: "me" }, cron: "0 8 * * *", timezone: "UTC" }, ORIGIN);
    await runNow();
    expect(mailTo(actorEmail)).toHaveLength(0);
    await prisma.filterSubscription.update({ where: { id: quiet.id }, data: { sendWhenEmpty: true } });
    await runNow();
    expect(mailTo(actorEmail)[0].subject).toMatch(/: 0 items$/);
    await prisma.filterSubscription.delete({ where: { id: quiet.id } });
  });

  it("each send uses the recipient's read scope at send time, not at subscribe time", async () => {
    outbox.length = 0;
    // Bob can read the restricted project while he subscribes...
    const mBob = await prisma.orgMember.findFirstOrThrow({ where: { orgId: w.orgA, userId: w.bob.id } });
    const pm = await prisma.projectMember.create({ data: { projectId: w.P2.id, orgMemberId: mBob.id } });
    const secretKey = `${w.P2.key}-${w.items[`p2-secret-${w.stamp}`].ticketNumber}`;
    try {
      const v = await filter("priority = CRITICAL", { visibility: "ORG" });
      const bobScope = await viewerScope((await loadMemberAuthContext(w.orgA, w.bob.id))!);
      await createSubscription(bobScope, v, { recipient: { kind: "me" }, cron: "0 8 * * *", timezone: "UTC", onlyChanges: false }, ORIGIN);
      await runNow();
      expect(mailTo(bobEmail).at(-1)!.text).toContain(secretKey);
      // ...and loses it before the next send: that item is gone from the email.
      await prisma.projectMember.delete({ where: { id: pm.id } });
      outbox.length = 0;
      await runNow();
      const [mail] = mailTo(bobEmail);
      expect(mail.text).toContain(`${w.P1.key}-${w.items["p1-login-bug"].ticketNumber}`);
      expect(mail.text + mail.html).not.toContain(secretKey);
    } finally {
      await prisma.projectMember.deleteMany({ where: { id: pm.id } });
    }
  });

  it("a recipient who left the org: disabled with the reason, nothing sent", async () => {
    outbox.length = 0;
    const view = await prisma.savedView.create({
      data: { orgId: w.orgA, ownerId: w.bob.id, name: `bob-${w.stamp}`, query: parseCql("priority = HIGH").query as object },
    });
    const sub = await prisma.filterSubscription.create({
      data: {
        orgId: w.orgA, savedViewId: view.id, createdById: w.bob.id, recipientUserId: w.bob.id, nextRunAt: new Date(Date.now() - 1000),
        unsubscribeKey: "k".repeat(64), appOrigin: ORIGIN,
      },
    });
    await prisma.orgMember.updateMany({ where: { orgId: w.orgA, userId: w.bob.id }, data: { removedAt: new Date() } });
    try {
      await runDueSubscriptions({ send });
      expect(mailTo(bobEmail)).toHaveLength(0);
      const row = await prisma.filterSubscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(row.disabledReason).toBe("recipient is no longer a member");
    } finally {
      const { prismaUnfiltered } = await import("@/lib/db/client");
      await prismaUnfiltered.orgMember.updateMany({ where: { orgId: w.orgA, userId: w.bob.id }, data: { removedAt: null } });
    }
  });

  it("the switch off: nothing goes out and nothing is disabled", async () => {
    outbox.length = 0;
    const v = await filter("priority = CRITICAL");
    const sub = await createSubscription(actorScope, v, { recipient: { kind: "me" }, cron: "0 8 * * *", timezone: "UTC" }, ORIGIN);
    await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, false) as object } });
    try {
      await runNow();
      expect(outbox).toHaveLength(0);
      expect((await prisma.filterSubscription.findUniqueOrThrow({ where: { id: sub.id } })).disabledAt).toBeNull();
    } finally {
      await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
      await prisma.filterSubscription.delete({ where: { id: sub.id } });
    }
  });

  it("a failed send records the error, and those ids aren't remembered as sent", async () => {
    const v = await filter("priority = CRITICAL");
    const sub = await createSubscription(actorScope, v, { recipient: { kind: "me" }, cron: "0 8 * * *", timezone: "UTC", onlyChanges: true }, ORIGIN);
    await prisma.filterSubscription.update({ where: { id: sub.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    await runDueSubscriptions({ send: vi.fn(async () => { throw new Error("transactional email not configured"); }) });
    const row = await prisma.filterSubscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row.lastError).toMatch(/not configured/);
    expect((row.lastResultIds as Record<string, string[]>)[w.actor.id] ?? []).toEqual([]);
    await prisma.filterSubscription.delete({ where: { id: sub.id } });
  });
});

describe("unsubscribe by link", () => {
  it("GET asks, POST disables; a tampered or foreign token does nothing", async () => {
    const v = await filter("priority = CRITICAL");
    const sub = await createSubscription(actorScope, v, { recipient: { kind: "me" }, cron: "0 8 * * *", timezone: "UTC" }, ORIGIN);
    const row = await prisma.filterSubscription.findUniqueOrThrow({ where: { id: sub.id } });
    const call = (fn: typeof unsubGet, token: string) =>
      fn(new NextRequest(`${ORIGIN}/api/v1/unsubscribe/filter/${token}`, { method: fn === unsubGet ? "GET" : "POST" }), { params: Promise.resolve({ token }) });

    const good = unsubscribeToken(row.unsubscribeKey, sub.id, w.actor.id);
    const tampered = good.slice(0, -2) + (good.endsWith("AA") ? "BB" : "AA");
    const someoneElse = unsubscribeToken(row.unsubscribeKey, sub.id, w.bob.id);
    expect((await call(unsubPost, tampered)).status).toBe(404);
    expect((await call(unsubPost, someoneElse)).status).toBe(404);
    expect((await call(unsubPost, "garbage")).status).toBe(404);
    expect((await prisma.filterSubscription.findUniqueOrThrow({ where: { id: sub.id } })).disabledAt).toBeNull();

    const ask = await call(unsubGet, good);
    expect(await ask.text()).toContain('<form method="post">');
    expect((await prisma.filterSubscription.findUniqueOrThrow({ where: { id: sub.id } })).disabledAt).toBeNull();

    expect((await call(unsubPost, good)).status).toBe(200);
    const after = await prisma.filterSubscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.disabledReason).toBe("unsubscribed");
    expect(await (await call(unsubGet, good)).text()).toContain("You're unsubscribed");
    expect(await prisma.auditLog.count({ where: { orgId: w.orgA, action: "saved_filter.unsubscribed_by_link" } })).toBeGreaterThanOrEqual(1);
  });

  it("a token minted for another subscription, or for one since deleted, does nothing", async () => {
    const call = (fn: typeof unsubGet, token: string) =>
      fn(new NextRequest(`${ORIGIN}/api/v1/unsubscribe/filter/${token}`, { method: fn === unsubGet ? "GET" : "POST" }), { params: Promise.resolve({ token }) });
    const v = await filter("priority = CRITICAL");
    const a = await createSubscription(actorScope, v, { recipient: { kind: "me" }, cron: "0 8 * * *", timezone: "UTC" }, ORIGIN);
    const b = await createSubscription(actorScope, v, { recipient: { kind: "me" }, cron: "0 9 * * *", timezone: "UTC" }, ORIGIN);
    const keyA = (await prisma.filterSubscription.findUniqueOrThrow({ where: { id: a.id } })).unsubscribeKey;
    // A's key, B's id: purpose-bound to one subscription.
    expect((await call(unsubPost, unsubscribeToken(keyA, b.id, w.actor.id))).status).toBe(404);
    expect((await prisma.filterSubscription.findUniqueOrThrow({ where: { id: b.id } })).disabledAt).toBeNull();
    // The link dies with its subscription.
    const good = unsubscribeToken(keyA, a.id, w.actor.id);
    await prisma.filterSubscription.delete({ where: { id: a.id } });
    expect((await call(unsubGet, good)).status).toBe(404);
    expect((await call(unsubPost, good)).status).toBe(404);
  });
});
