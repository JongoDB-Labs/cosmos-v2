// @vitest-environment node
//
// Who may manage an org's webhooks, and what a read of one sends back, against
// a real database.
//
// A webhook has no project filter: it is sent events from EVERY project in the
// org, and its delivery log holds their payloads. A key limited to some
// projects therefore can't manage one at all, whatever its scopes; an org-wide
// key with `webhooks:manage` and a browser session can. The signing secret is
// shown once, when the webhook is created, and never again: not by a read, and
// not by an edit's response.
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";

import type { AuthContext } from "@/lib/rbac/check";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import { scopeMask } from "@/lib/auth/api-key";
import { sealField } from "@/lib/crypto/field-seal";

const h = vi.hoisted(() => ({ ctx: null as unknown, posts: 0 }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
// The test send goes to the network; stand in for it. The address check it
// runs is tested on its own (outbound-post tests).
vi.mock("@/lib/security/outbound-post.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/security/outbound-post.server")>()),
  postToPublicUrl: async () => { h.posts++; return { status: 200, body: "ok" }; },
}));

import * as list from "./route";
import * as byId from "./[webhookId]/route";
import * as deliveries from "./[webhookId]/deliveries/route";
import * as test from "./[webhookId]/test/route";

const VAULT = process.env.SSO_VAULT_KEY;
process.env.SSO_VAULT_KEY = crypto.randomBytes(32).toString("base64");

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", userId = "", projectId = "", hookId = "", spareId = "";
const SECRET = `whsec-${stamp}-${crypto.randomBytes(8).toString("hex")}`;
let sealed = "";

type Handler = (req: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
const HANDLERS: Array<[string, Handler, () => Record<string, string>, unknown?]> = [
  ["GET list", list.GET as Handler, () => ({ orgId })],
  ["POST create", list.POST as Handler, () => ({ orgId }), { url: "https://hooks.example.com/in", events: ["work_item.created"] }],
  ["GET one", byId.GET as Handler, () => ({ orgId, webhookId: hookId })],
  ["PUT", byId.PUT as Handler, () => ({ orgId, webhookId: hookId }), { active: true }],
  ["PATCH", byId.PATCH as Handler, () => ({ orgId, webhookId: hookId }), { active: true }],
  ["GET deliveries", deliveries.GET as Handler, () => ({ orgId, webhookId: hookId })],
  ["POST test", test.POST as Handler, () => ({ orgId, webhookId: hookId })],
  ["DELETE", byId.DELETE as Handler, () => ({ orgId, webhookId: spareId })],
];

function call(handler: Handler, params: Record<string, string>, body?: unknown) {
  const req = new NextRequest(`http://localhost/api/v1/orgs/${orgId}/webhooks`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
  return handler(req, { params: Promise.resolve(params) });
}

const owner = (): AuthContext => ({
  userId, orgId, orgRole: OrgRole.OWNER, abacRules: [],
  permissions: RolePermissions.OWNER, basePermissions: RolePermissions.OWNER,
});
/** An OWNER's key with `webhooks:manage`, as apiKeyAuthContext builds it. */
const key = (projectScope?: string[]): AuthContext => {
  const mask = RolePermissions.OWNER & scopeMask(["webhooks:manage"]);
  return {
    userId, orgId, orgRole: OrgRole.OWNER, abacRules: [], permissions: mask, basePermissions: mask,
    isApiKey: true, scopes: ["webhooks:manage"], ...(projectScope ? { projectScope } : {}),
  };
};

async function freshSpare() {
  spareId = (await prisma.webhook.create({ data: { orgId, url: "https://spare.example.com/in", events: ["work_item.created"], secret: sealField("spare") } })).id;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `whk ${stamp}`, slug: `whk-${stamp}` } })).id;
  userId = (await prisma.user.create({ data: { email: `o-${stamp}@whk.test`, displayName: "Owner" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId, role: "OWNER", permissions: "0" } });
  projectId = (await prisma.project.create({ data: { orgId, name: "Scoped", key: `W${stamp.slice(0, 4).toUpperCase()}` } })).id;
  sealed = sealField(SECRET);
  hookId = (await prisma.webhook.create({ data: { orgId, url: "https://hooks.example.com/in", events: ["work_item.created"], secret: sealed } })).id;
  // A real delivery carries the domain event's id (a BigInt column).
  await prisma.webhookDelivery.create({
    data: { webhookId: hookId, event: "work_item.created", payload: { title: "from another project" }, status: "SUCCESS", attempts: 1, eventId: 42n },
  });
  await freshSpare();
});

afterAll(async () => {
  await prisma.webhook.deleteMany({ where: { orgId } });
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  // Audit rows are append-only, so an org that wrote some may not delete.
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  if (VAULT === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = VAULT;
});

describe("a key limited to some projects can't manage org-wide webhooks", () => {
  it.each(HANDLERS)("%s: refused, and nothing changes", async (_name, handler, params, body) => {
    h.ctx = key([projectId]);
    const before = await prisma.webhook.count({ where: { orgId } });
    const deliveriesBefore = await prisma.webhookDelivery.count({ where: { webhook: { orgId } } });
    const postsBefore = h.posts;
    const res = await call(handler, params(), body);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("from another project");
    expect(await prisma.webhook.count({ where: { orgId } })).toBe(before);
    expect(await prisma.webhookDelivery.count({ where: { webhook: { orgId } } })).toBe(deliveriesBefore);
    expect(h.posts).toBe(postsBefore);
  });
});

// Reading the delivery log also needs ITEM_READ, which webhooks:manage alone
// doesn't carry (creator-scope.db.test.ts covers who reads what in it).
const MANAGING = HANDLERS.filter(([n]) => n !== "GET deliveries");
describe.each([
  ["an org-wide key with webhooks:manage", () => key(), MANAGING],
  ["an owner's browser session", owner, HANDLERS],
])("%s still manages them", (_who, ctx, handlers) => {
  it.each(handlers)("%s", async (name, handler, params, body) => {
    h.ctx = ctx();
    const res = await call(handler, params(), body);
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    if (name === "DELETE") await freshSpare();
  });
});

describe("the signing secret is shown once", () => {
  it.each(HANDLERS.filter(([n]) => ["GET list", "GET one", "PUT", "PATCH"].includes(n)))(
    "%s never sends it, sealed or open",
    async (_name, handler, params, body) => {
      h.ctx = owner();
      const res = await call(handler, params(), body);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(sealed);
      expect(text).not.toContain(SECRET);
      expect(Object.keys(JSON.parse(text))).not.toContain("secret");
      // A positive control: the response is the webhook, not an empty shell.
      expect(text).toContain("hooks.example.com");
    },
  );

  it("creating one sends the new secret, once, in the clear", async () => {
    h.ctx = owner();
    const res = await list.POST(
      new NextRequest(`http://localhost/api/v1/orgs/${orgId}/webhooks`, {
        method: "POST",
        body: JSON.stringify({ url: "https://new.example.com/in", events: ["work_item.created"] }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ orgId }) },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; secret: string };
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
    const row = await prisma.webhook.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.secret).not.toBe(body.secret); // sealed at rest
  });
});

describe("the delivery log reads back", () => {
  it("lists a real delivery (its event id is a BigInt)", async () => {
    h.ctx = owner();
    const res = await call(deliveries.GET as Handler, { orgId, webhookId: hookId });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ event: string; eventId: string | null }>;
    expect(rows.find((r) => r.event === "work_item.created")?.eventId).toBe("42");
  });
});
