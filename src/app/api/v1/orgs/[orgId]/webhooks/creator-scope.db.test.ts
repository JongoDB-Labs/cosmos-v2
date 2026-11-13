// @vitest-environment node
//
// A webhook acts for the person who created it, against a real database.
//
// It has no project filter of its own, so it is held to what its creator can
// read: an event is sent only if the creator can read its project when it is
// sent, and a webhook whose creator has left the org sends nothing (the page
// says why). Its delivery log holds those events' payloads, so reading the log
// needs ITEM_READ as well as WEBHOOK_MANAGE, and shows only deliveries from
// projects the reader can read. Audit rows keep only the URL's origin: a
// path can be a credential (a chat-tool hook's path is).
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { Permission, RolePermissions, maskToDb } from "@/lib/rbac/permissions";
import { scopeMask } from "@/lib/auth/api-key";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { sealField } from "@/lib/crypto/field-seal";
import { sendDueDeliveries, type Post } from "@/lib/webhooks/deliver.server";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import * as list from "./route";
import * as byId from "./[webhookId]/route";
import * as deliveries from "./[webhookId]/deliveries/route";

const VAULT = process.env.SSO_VAULT_KEY;
process.env.SSO_VAULT_KEY = crypto.randomBytes(32).toString("base64");

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", ownerId = "", makerId = "", makerMemberId = "", readerId = "";
let openProject = "", teamProject = "";

type Handler = (req: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
function call(handler: Handler, params: Record<string, string>, method = "GET", body?: unknown) {
  const req = new NextRequest(`http://localhost/api/v1/orgs/${orgId}/webhooks`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
  return handler(req, { params: Promise.resolve(params) });
}
const asMember = async (id: string) => (await loadMemberAuthContext(orgId, id))!;
const ownerKey = (scopes: string[]): AuthContext => {
  const mask = RolePermissions.OWNER & scopeMask(scopes);
  return { userId: ownerId, orgId, orgRole: OrgRole.OWNER, abacRules: [], permissions: mask, basePermissions: mask, isApiKey: true, scopes };
};
const hook = (createdById: string | null) =>
  prisma.webhook.create({ data: { orgId, url: "https://hooks.example.com/in", events: ["work_item.created"], secret: sealField("s"), createdById } });
const queue = (webhookId: string, projectId: string | null) =>
  prisma.webhookDelivery.create({
    data: { webhookId, event: "work_item.created", projectId, payload: { projectId, marker: `p-${projectId ?? "none"}` }, status: "PENDING", nextAttemptAt: new Date(Date.now() - 1000) },
  });
function recorder() {
  const sent: string[] = [];
  const post: Post = async (_url, { body }) => {
    sent.push((JSON.parse(body) as { data: { marker: string } }).data.marker);
    return { status: 200, body: "ok" };
  };
  return { sent, post };
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `whc ${stamp}`, slug: `whc-${stamp}` } })).id;
  ownerId = (await prisma.user.create({ data: { email: `o-${stamp}@whc.test`, displayName: "Owner" } })).id;
  makerId = (await prisma.user.create({ data: { email: `m-${stamp}@whc.test`, displayName: "Maker" } })).id;
  readerId = (await prisma.user.create({ data: { email: `r-${stamp}@whc.test`, displayName: "Reader" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: ownerId, role: "OWNER", permissions: "0" } });
  makerMemberId = (await prisma.orgMember.create({ data: { orgId, userId: makerId, role: "MEMBER", permissions: "0" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: readerId, role: "MEMBER", permissions: "0" } });
  // The maker manages webhooks through a work role, and isn't on the team project.
  const role = await prisma.workRole.create({ data: { orgId, key: `hooks_${stamp}`, name: "Hooks", grants: maskToDb(Permission.WEBHOOK_MANAGE) } });
  await prisma.orgMemberWorkRole.create({ data: { orgMemberId: makerMemberId, workRoleId: role.id } });
  const key = stamp.slice(0, 4).toUpperCase();
  openProject = (await prisma.project.create({ data: { orgId, name: "Open", key: `O${key}` } })).id;
  teamProject = (await prisma.project.create({ data: { orgId, name: "Team", key: `T${key}`, teamScopedAccess: true } })).id;
});

afterAll(async () => {
  await prisma.webhook.deleteMany({ where: { orgId } });
  await prisma.project.deleteMany({ where: { orgId } });
  await prisma.workRole.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  // Audit rows are append-only, so an org that wrote some may not delete.
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, makerId, readerId] } } }).catch(() => undefined);
  if (VAULT === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = VAULT;
});

describe("creating a webhook records who created it", () => {
  it("as the person (or the person behind the key) who asked", async () => {
    h.ctx = await asMember(makerId);
    const res = await call(list.POST as Handler, { orgId }, "POST", { url: "https://hooks.example.com/made", events: ["work_item.created"] });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect((await prisma.webhook.findUniqueOrThrow({ where: { id } })).createdById).toBe(makerId);
    await prisma.webhook.delete({ where: { id } });
  });
});

describe("an event is sent only if the webhook's creator can read its project", () => {
  it("the maker's webhook sends the open project's event and the test ping, not the team project's", async () => {
    const w = await hook(makerId);
    const [open, team, ping] = [await queue(w.id, openProject), await queue(w.id, teamProject), await queue(w.id, null)];
    const { sent, post } = recorder();
    await sendDueDeliveries(prisma, { orgId, post });
    expect(sent.sort()).toEqual([`p-${openProject}`, "p-none"].sort());
    const rows = await prisma.webhookDelivery.findMany({ where: { id: { in: [open.id, team.id, ping.id] } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(open.id)!.status).toBe("SUCCESS");
    expect(byId.get(team.id)).toMatchObject({ status: "FAILED", attempts: 0, statusCode: null });
    expect(byId.get(team.id)!.responseBody).toMatch(/can't read this project/);
    await prisma.webhook.delete({ where: { id: w.id } });
  });

  it("the owner's webhook sends the team project's event (control)", async () => {
    const w = await hook(ownerId);
    await queue(w.id, teamProject);
    const { sent, post } = recorder();
    await sendDueDeliveries(prisma, { orgId, post });
    expect(sent).toEqual([`p-${teamProject}`]);
    await prisma.webhook.delete({ where: { id: w.id } });
  });

  it("a webhook with no recorded creator sends nothing", async () => {
    const w = await hook(null);
    const d = await queue(w.id, openProject);
    const { sent, post } = recorder();
    await sendDueDeliveries(prisma, { orgId, post });
    expect(sent).toEqual([]);
    expect((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("FAILED");
    await prisma.webhook.delete({ where: { id: w.id } });
  });
});

describe("reading the delivery log", () => {
  let w = "";
  beforeAll(async () => {
    w = (await hook(ownerId)).id;
    for (const p of [openProject, teamProject, null]) {
      await prisma.webhookDelivery.create({ data: { webhookId: w, event: "work_item.created", projectId: p, payload: { marker: `log-${p ?? "none"}` }, status: "SUCCESS", attempts: 1 } });
    }
  });
  const read = async () => {
    const res = await call(deliveries.GET as Handler, { orgId, webhookId: w });
    return { status: res.status, text: await res.text() };
  };

  it("a key with only webhooks:manage can't read payloads", async () => {
    h.ctx = ownerKey(["webhooks:manage"]);
    expect((await read()).status).toBe(403);
  });

  it("a key that can also read sees every project's deliveries (control)", async () => {
    h.ctx = ownerKey(["webhooks:manage", "read"]);
    const r = await read();
    expect(r.status).toBe(200);
    for (const m of [`log-${openProject}`, `log-${teamProject}`, "log-none"]) expect(r.text).toContain(m);
  });

  it("someone who manages webhooks but can't see the team project doesn't see its deliveries", async () => {
    h.ctx = await asMember(makerId);
    const r = await read();
    expect(r.status).toBe(200);
    expect(r.text).toContain(`log-${openProject}`);
    expect(r.text).toContain("log-none");
    expect(r.text).not.toContain(`log-${teamProject}`);
  });

  it("someone who can read items but not manage webhooks can't read the log", async () => {
    h.ctx = await asMember(readerId);
    expect((await read()).status).toBe(403);
  });
});

describe("audit rows keep only the URL's origin", () => {
  const SECRET_URL = `https://hooks.example.com/services/T0/B0/${stamp}secretpath?token=${stamp}tok`;
  it("on create, edit and delete", async () => {
    h.ctx = await asMember(ownerId);
    const since = new Date();
    const res = await call(list.POST as Handler, { orgId }, "POST", { url: SECRET_URL, events: ["work_item.created"] });
    const { id } = (await res.json()) as { id: string };
    await call(byId.PATCH as Handler, { orgId, webhookId: id }, "PATCH", { url: `${SECRET_URL}&v=2` });
    await call(byId.PUT as Handler, { orgId, webhookId: id }, "PUT", { url: `${SECRET_URL}&v=3` });
    await call(byId.DELETE as Handler, { orgId, webhookId: id }, "DELETE");
    const rows = await prisma.auditLog.findMany({
      where: { orgId, entity: "webhook", entityId: id, createdAt: { gte: since } },
      select: { action: true, metadata: true },
    });
    expect(rows.map((r) => r.action).sort()).toEqual(["webhook.created", "webhook.deleted", "webhook.patched", "webhook.updated"]);
    for (const r of rows) {
      expect((r.metadata as { url?: string }).url).toBe("https://hooks.example.com");
      expect(JSON.stringify(r.metadata)).not.toContain("secretpath");
      expect(JSON.stringify(r.metadata)).not.toContain(`${stamp}tok`);
    }
  });
});

describe("an edit that changes where a webhook sends, or what, makes it act for the editor", () => {
  // The owner reads both projects; the maker reads only the open one.
  const sendBoth = async (webhookId: string) => {
    await queue(webhookId, openProject);
    await queue(webhookId, teamProject);
    const { sent, post } = recorder();
    await sendDueDeliveries(prisma, { orgId, post });
    return sent.sort();
  };
  const actsFor = async (id: string) => (await prisma.webhook.findUniqueOrThrow({ where: { id } })).createdById;

  it("the maker re-pointing the owner's webhook gets only what the maker can read", async () => {
    const w = await hook(ownerId);
    h.ctx = await asMember(makerId);
    const since = new Date();
    expect((await call(byId.PATCH as Handler, { orgId, webhookId: w.id }, "PATCH", { url: `https://hooks.example.com/maker-${stamp}/x` })).status).toBe(200);
    expect(await actsFor(w.id)).toBe(makerId);
    expect(await sendBoth(w.id)).toEqual([`p-${openProject}`]);
    // The audit row says whose access it now carries, and still only the URL's origin.
    const row = await prisma.auditLog.findFirst({ where: { orgId, entityId: w.id, action: "webhook.patched", createdAt: { gte: since } } });
    expect(row?.metadata).toMatchObject({ url: "https://hooks.example.com", actsFor: makerId, previouslyActedFor: ownerId });
    expect(JSON.stringify(row?.metadata)).not.toContain(`maker-${stamp}`);
    await prisma.webhook.delete({ where: { id: w.id } });
  });

  it("so does changing its events (PUT), or turning it back on", async () => {
    const a = await hook(ownerId);
    h.ctx = await asMember(makerId);
    expect((await call(byId.PUT as Handler, { orgId, webhookId: a.id }, "PUT", { events: ["work_item.created", "work_item.updated"] })).status).toBe(200);
    expect(await actsFor(a.id)).toBe(makerId);

    const b = await prisma.webhook.create({ data: { orgId, url: "https://hooks.example.com/off", events: ["work_item.created"], secret: sealField("s"), createdById: ownerId, active: false } });
    expect((await call(byId.PATCH as Handler, { orgId, webhookId: b.id }, "PATCH", { active: true })).status).toBe(200);
    expect(await actsFor(b.id)).toBe(makerId);
    await prisma.webhook.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  });

  it("an edit that sends nothing new elsewhere leaves it acting for its creator", async () => {
    const w = await hook(ownerId);
    h.ctx = await asMember(makerId);
    // Turning it off, and saving the same URL and events.
    await call(byId.PATCH as Handler, { orgId, webhookId: w.id }, "PATCH", { active: false });
    await call(byId.PUT as Handler, { orgId, webhookId: w.id }, "PUT", { url: "https://hooks.example.com/in", events: ["work_item.created"] });
    expect(await actsFor(w.id)).toBe(ownerId);
    await prisma.webhook.delete({ where: { id: w.id } });
  });

  it("the creator's own edit keeps sending both projects' events (control)", async () => {
    const w = await hook(ownerId);
    h.ctx = await asMember(ownerId);
    expect((await call(byId.PATCH as Handler, { orgId, webhookId: w.id }, "PATCH", { url: "https://hooks.example.com/owner-moved" })).status).toBe(200);
    expect(await actsFor(w.id)).toBe(ownerId);
    expect(await sendBoth(w.id)).toEqual([`p-${openProject}`, `p-${teamProject}`].sort());
    await prisma.webhook.delete({ where: { id: w.id } });
  });
});

// Last: it removes the maker from the org.
describe("a webhook whose creator has left", () => {
  it("sends nothing, and the list says why", async () => {
    const w = await hook(makerId);
    const d = await queue(w.id, openProject);
    await prismaUnfiltered.orgMember.update({ where: { id: makerMemberId }, data: { removedAt: new Date() } });
    const { sent, post } = recorder();
    await sendDueDeliveries(prisma, { orgId, post });
    expect(sent).toEqual([]);
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } });
    expect(row).toMatchObject({ status: "FAILED", attempts: 0 });
    expect(row.responseBody).toMatch(/no longer a member/);

    h.ctx = await asMember(ownerId);
    const listed = (await (await call(list.GET as Handler, { orgId })).json()) as Array<{ id: string; pausedReason: string | null }>;
    expect(listed.find((x) => x.id === w.id)?.pausedReason).toMatch(/no longer a member/);
    const one = (await (await call(byId.GET as Handler, { orgId, webhookId: w.id })).json()) as { pausedReason: string | null };
    expect(one.pausedReason).toMatch(/no longer a member/);
  });
});
