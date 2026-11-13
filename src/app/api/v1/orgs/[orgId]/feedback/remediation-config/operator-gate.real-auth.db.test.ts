// @vitest-environment node
//
// The operator gate through the production auth resolution. Only next/headers
// is faked, so the session cookie and the bearer header go through the real
// getAuthContext and getCurrentUser, as they do for a live request.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma, prismaUnfiltered } from "@/lib/db/client";

const h = vi.hoisted(() => ({ auth: null as string | null, cookie: null as string | null }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(h.auth ? { authorization: h.auth } : {}),
  cookies: async () => ({
    get: (name: string) => (name === "session" && h.cookie ? { name, value: h.cookie } : undefined),
  }),
}));
vi.mock("@/lib/realtime/broker", () => ({ publishToOrg: () => {} }));
vi.mock("@/lib/cache/queries", () => ({ revalidateOrg: () => {} }));

import { GET, PUT } from "./route";
import { mintApiKey } from "@/lib/auth/api-key";

const OPERATOR_ONLY = "Only the instance operator can turn on automated delivery or add build workers.";
const stamp = Math.random().toString(36).slice(2, 8);
const operatorEmail = `ra-op-${stamp}@delivery-gate.test`;
const ownerEmail = `ra-owner-${stamp}@delivery-gate.test`;
const operatorSession = `sess-op-${stamp}`;
const ownerSession = `sess-owner-${stamp}`;
let orgId = "";
let operatorId = "";
let ownerId = "";
let projectA = "";
let operatorKey = "";

const url = () => `http://localhost/api/v1/orgs/${orgId}/feedback/remediation-config`;
const at = () => ({ params: Promise.resolve({ orgId }) });
const deliveryOn = () => ({
  autoRemediation: { enabled: false, projectIds: [], defaultProjectId: null },
  autonomousDelivery: { enabled: true, projectIds: [projectA], notify: { parked: true, shipped: true }, workers: 2 },
});
const put = (body: unknown) => PUT(new NextRequest(url(), { method: "PUT", body: JSON.stringify(body) }), at());
const get = () => GET(new NextRequest(url()), at());
const storedDelivery = async () =>
  ((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).settings as { autonomousDelivery?: { enabled?: boolean } })
    .autonomousDelivery;

beforeAll(async () => {
  vi.stubEnv("INTERNAL_ADMINS", operatorEmail);
  orgId = (await prisma.organization.create({ data: { name: `ra ${stamp}`, slug: `ra-${stamp}` } })).id;
  operatorId = (await prisma.user.create({ data: { email: operatorEmail, displayName: "Operator" } })).id;
  ownerId = (await prisma.user.create({ data: { email: ownerEmail, displayName: "Owner" } })).id;
  for (const userId of [operatorId, ownerId]) {
    await prisma.orgMember.create({ data: { orgId, userId, role: "OWNER", permissions: "0" } });
  }
  projectA = (await prisma.project.create({ data: { orgId, name: "Alpha", key: `RA${stamp.slice(0, 3).toUpperCase()}` } })).id;
  const expiresAt = new Date(Date.now() + 3_600_000);
  await prisma.session.create({ data: { id: operatorSession, userId: operatorId, expiresAt } });
  await prisma.session.create({ data: { id: ownerSession, userId: ownerId, expiresAt } });
  // Every scope there is, minted by the operator.
  operatorKey = (
    await mintApiKey({
      orgId,
      name: "every scope",
      createdById: operatorId,
      scopes: ["read", "items:write", "items:delete", "planning:write", "time:read", "time:write", "members:read", "webhooks:manage", "audit:read", "documents:write", "rules:run"],
    })
  ).token;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.session.deleteMany({ where: { id: { in: [operatorSession, ownerSession] } } });
  await prisma.apiKey.deleteMany({ where: { orgId } });
  await prisma.project.deleteMany({ where: { orgId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: [operatorId, ownerId] } } });
});

beforeEach(async () => {
  await prisma.organization.update({ where: { id: orgId }, data: { settings: {} } });
  h.auth = null;
  h.cookie = null;
});

describe("the operator gate with real sign-in resolution", () => {
  it("the operator's own session turns delivery on", async () => {
    h.cookie = operatorSession;
    expect((await put(deliveryOn())).status).toBe(200);
    expect((await storedDelivery())?.enabled).toBe(true);
  });

  it("an owner's session is refused with the operator sentence", async () => {
    h.cookie = ownerSession;
    const res = await put(deliveryOn());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe(OPERATOR_ONLY);
    expect(await storedDelivery()).toBeUndefined();
  });

  it("an operator-minted key with the operator's cookie alongside is refused, and nothing is stored", async () => {
    h.cookie = operatorSession;
    h.auth = `Bearer ${operatorKey}`;
    expect((await put(deliveryOn())).status).toBe(403);
    expect(await storedDelivery()).toBeUndefined();
  });

  it("the form learns viewerIsOperator: true for the operator, false for an owner", async () => {
    h.cookie = operatorSession;
    expect(((await (await get()).json()) as { viewerIsOperator?: boolean }).viewerIsOperator).toBe(true);
    h.cookie = ownerSession;
    expect(((await (await get()).json()) as { viewerIsOperator?: boolean }).viewerIsOperator).toBe(false);
  });
});
