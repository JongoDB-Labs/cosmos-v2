// @vitest-environment node
// (e2e DB) The subscription routes and the emailTitles setting, with only the
// session mocked: behind the switch, validated, the team rules enforced over
// HTTP, and only a subscription's creator, recipient or an admin can change it.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { withCqlEnabled } from "../flag";
import { parseCql } from "../parser";
import { seedWorld, type World } from "./cql-fixture";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { GET as list, POST as create } from "@/app/api/v1/orgs/[orgId]/saved-views/[viewId]/subscriptions/route";
import { PATCH as patch, DELETE as del } from "@/app/api/v1/orgs/[orgId]/saved-views/[viewId]/subscriptions/[subId]/route";
import { GET as qlGet, PUT as qlPut } from "@/app/api/v1/orgs/[orgId]/query-language/route";

let w: World;
let viewId: string;
const as = async (userId: string) => getAuthContext.mockImplementation(async () => loadMemberAuthContext(w.orgA, userId));
const req = (method: string, path: string, body?: unknown) =>
  new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
const p = () => ({ params: Promise.resolve({ orgId: w.orgA, viewId }) });
const ps = (subId: string) => ({ params: Promise.resolve({ orgId: w.orgA, viewId, subId }) });

beforeAll(async () => {
  w = await seedWorld();
  await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
  viewId = (
    await prisma.savedView.create({
      data: { orgId: w.orgA, ownerId: w.actor.id, name: `r-${w.stamp}`, query: parseCql("priority = HIGH").query as object, visibility: "PROJECT", projectId: w.P1.id },
    })
  ).id;
}, 60_000);
afterAll(async () => {
  await w?.cleanup();
});

describe("subscription routes", () => {
  it("create for me, list it back with my teams; a bad schedule or body is a 400", async () => {
    await as(w.actor.id);
    const res = await create(req("POST", "x", { recipient: { kind: "me" }, cron: "0 8 * * 1-5", timezone: "Europe/London" }), p());
    expect(res.status).toBe(201);
    const { subscription } = (await res.json()) as { subscription: { id: string; recipientUser: { id: string }; nextRunAt: string } };
    expect(subscription.recipientUser.id).toBe(w.actor.id);
    const row = await prisma.filterSubscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(row.appOrigin).toBe("http://localhost");
    expect(row.unsubscribeKey).toMatch(/^[0-9a-f]{64}$/);

    const got = (await (await list(req("GET", "x"), p())).json()) as { subscriptions: { id: string }[]; teams: unknown[] };
    expect(got.subscriptions.map((s) => s.id)).toContain(subscription.id);
    expect(got.teams).toEqual([]);

    expect((await create(req("POST", "x", { recipient: { kind: "me" }, cron: "*/5 * * * *", timezone: "UTC" }), p())).status).toBe(400);
    expect((await create(req("POST", "x", { recipient: { kind: "me" }, cron: "0 8 * * *", timezone: "Nowhere/Land" }), p())).status).toBe(400);
    expect((await create(req("POST", "x", { recipient: { kind: "someone", userId: w.bob.id }, cron: "0 8 * * *", timezone: "UTC" }), p())).status).toBe(400);
    expect(await prisma.auditLog.count({ where: { orgId: w.orgA, action: "saved_filter.subscribed" } })).toBe(1);
  });

  it("a team you're not on is refused; the filter must be one you can see", async () => {
    await as(w.actor.id);
    const res = await create(req("POST", "x", { recipient: { kind: "team", teamId: w.teamP1 }, cron: "0 8 * * *", timezone: "UTC" }), p());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/team you're on/);
    const ghostView = await prisma.savedView.create({ data: { orgId: w.orgA, ownerId: w.bob.id, name: `bobs-${w.stamp}` } });
    const hidden = await create(req("POST", "x", { recipient: { kind: "me" }, cron: "0 8 * * *", timezone: "UTC" }), { params: Promise.resolve({ orgId: w.orgA, viewId: ghostView.id }) });
    expect(hidden.status).toBe(404);
  });

  it("only the creator, the recipient or an admin may change or delete it", async () => {
    await as(w.actor.id);
    const { subscription } = (await (
      await create(req("POST", "x", { recipient: { kind: "me" }, cron: "0 9 * * *", timezone: "UTC" }), p())
    ).json()) as { subscription: { id: string } };
    // Bob can see the filter (P1 reader) but didn't make this and isn't its recipient.
    await as(w.bob.id);
    expect((await patch(req("PATCH", "x", { enabled: false }), ps(subscription.id))).status).toBe(404);
    expect((await del(req("DELETE", "x"), ps(subscription.id))).status).toBe(404);
    const bobsList = (await (await list(req("GET", "x"), p())).json()) as { subscriptions: { id: string }[] };
    expect(bobsList.subscriptions.map((s) => s.id)).not.toContain(subscription.id);

    await as(w.actor.id);
    expect((await patch(req("PATCH", "x", { cron: "* 9 * * *" }), ps(subscription.id))).status).toBe(400);
    const paused = await patch(req("PATCH", "x", { enabled: false }), ps(subscription.id));
    expect(((await paused.json()) as { subscription: { disabledReason: string } }).subscription.disabledReason).toBe("paused");
    const resumed = await patch(req("PATCH", "x", { enabled: true }), ps(subscription.id));
    expect(((await resumed.json()) as { subscription: { disabledAt: string | null } }).subscription.disabledAt).toBeNull();
    expect((await del(req("DELETE", "x"), ps(subscription.id))).status).toBe(204);
    expect(await prisma.filterSubscription.count({ where: { id: subscription.id } })).toBe(0);
  });

  it("an API key needs the contract's scopes: a read key can list, not subscribe, change or delete", async () => {
    await as(w.actor.id);
    const { subscription } = (await (
      await create(req("POST", "x", { recipient: { kind: "me" }, cron: "0 10 * * *", timezone: "UTC" }), p())
    ).json()) as { subscription: { id: string } };
    const asKey = (scopes: string[]) =>
      getAuthContext.mockImplementation(async () => ({ ...(await loadMemberAuthContext(w.orgA, w.actor.id)), isApiKey: true, scopes }));
    try {
      asKey(["read"]);
      expect((await list(req("GET", "x"), p())).status).toBe(200);
      expect((await create(req("POST", "x", { recipient: { kind: "me" }, cron: "0 8 * * *", timezone: "UTC" }), p())).status).toBe(403);
      expect((await patch(req("PATCH", "x", { enabled: false }), ps(subscription.id))).status).toBe(403);
      expect((await del(req("DELETE", "x"), ps(subscription.id))).status).toBe(403);
      asKey(["items:write"]);
      expect((await patch(req("PATCH", "x", { enabled: false }), ps(subscription.id))).status).toBe(200);
      expect((await del(req("DELETE", "x"), ps(subscription.id))).status).toBe(204);
    } finally {
      await as(w.actor.id);
    }
  });

  it("all of it is a 404 with the switch off", async () => {
    await as(w.actor.id);
    await prisma.organization.update({ where: { id: w.orgA }, data: { settings: {} } });
    try {
      expect((await list(req("GET", "x"), p())).status).toBe(404);
      expect((await create(req("POST", "x", { recipient: { kind: "me" }, cron: "0 8 * * *", timezone: "UTC" }), p())).status).toBe(404);
    } finally {
      await prisma.organization.update({ where: { id: w.orgA }, data: { settings: withCqlEnabled({}, true) as object } });
    }
  });
});

describe("emailTitles setting", () => {
  it("defaults off for GOV; admins turn it on (audited); members can't", async () => {
    await as(w.actor.id);
    const qp = { params: Promise.resolve({ orgId: w.orgA }) };
    expect(((await (await qlGet(req("GET", "query-language"), qp)).json()) as { emailTitles: boolean }).emailTitles).toBe(false);
    expect((await qlPut(req("PUT", "query-language", { emailTitles: true }), qp)).status).toBe(403);
    await prisma.orgMember.updateMany({ where: { orgId: w.orgA, userId: w.actor.id }, data: { role: "ADMIN" } });
    try {
      const res = await qlPut(req("PUT", "query-language", { emailTitles: true }), qp);
      expect(await res.json()).toEqual({ enabled: true, emailTitles: true });
      expect(await prisma.auditLog.count({ where: { orgId: w.orgA, action: "cql.email_titles_on" } })).toBe(1);
      expect((await qlPut(req("PUT", "query-language", {}), qp)).status).toBe(400);
    } finally {
      await prisma.orgMember.updateMany({ where: { orgId: w.orgA, userId: w.actor.id }, data: { role: "MEMBER" } });
    }
  });
});
