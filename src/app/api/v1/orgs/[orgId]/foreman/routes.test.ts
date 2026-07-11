// @vitest-environment node
//
// Org-scoped Foreman observability routes (status + events), against the REAL
// e2e DB (seeded `test-org`) — only `getAuthContext` is mocked, matching the
// style of feedback/route.test.ts (session cookies aren't available in a route
// handler test; `@/lib/db/client` is left unmocked so the real queries run).
// Proves:
//   - GET status returns the ForemanStatusPayload shape for a seeded
//     foreman_state "host" row (state.pulse, paused, inFlight[], config);
//   - GET events paginates newest-first via an id cursor, honors `limit`, and
//     nulls out nextCursor once a page comes back short;
//   - GET events `?kind=` filters to that kind only;
//   - a caller without ORG_UPDATE is rejected (non-200) on both routes.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { prisma } from "@/lib/db/client";
import { GET as getStatus } from "./status/route";
import { GET as getEvents } from "./events/route";

let orgId: string;
let userId: string;

function ctx(perms: bigint): AuthContext {
  return {
    userId,
    orgId,
    orgRole: OrgRole.ADMIN,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
  };
}

function params() {
  return Promise.resolve({ orgId });
}

function req(pathAndQuery: string) {
  return new NextRequest(`http://localhost/api/v1/orgs/${orgId}/foreman/${pathAndQuery}`);
}

beforeAll(async () => {
  const org = await prisma.organization.findFirstOrThrow({
    where: { slug: "test-org" },
    select: { id: true },
  });
  orgId = org.id;

  const user = await prisma.user.findFirstOrThrow({
    where: { email: "alice@test.local" },
    select: { id: true },
  });
  userId = user.id;

  // `observe-db.test.ts`'s "track resolves orgId from workItemId" case writes a
  // {kind:"gated", message:"m"} event scoped to this org and never cleans it
  // up, so it accumulates across runs of the shared e2e DB. Left in place it
  // pollutes the exact-count pagination assertions below (an extra older row
  // between "our oldest" and "off the end" flips nextCursor from null to set).
  // It's unambiguous test debris (literal message "m"), safe to purge here.
  await prisma.foremanEvent.deleteMany({ where: { orgId, message: "m" } });
});

beforeEach(() => {
  getAuthContext.mockResolvedValue(ctx(Permission.ORG_UPDATE));
});

describe("GET /foreman/status", () => {
  it("returns the status payload shape for test-org", async () => {
    await prisma.foremanState.upsert({
      where: { id: "host" },
      create: {
        id: "host",
        startedAt: new Date(),
        lastPassAt: new Date(),
        daemonVersion: "t",
        pid: 1,
        workerTarget: 2,
        slotsBusy: 0,
        queueDepth: 0,
        inFlight: [],
        breaker: { build: 0, deploy: 0, tripped: false },
        stopFileSeen: false,
      },
      update: {
        startedAt: new Date(),
        lastPassAt: new Date(),
        daemonVersion: "t",
        pid: 1,
        workerTarget: 2,
        slotsBusy: 0,
        queueDepth: 0,
        inFlight: [],
        breaker: { build: 0, deploy: 0, tripped: false },
        stopFileSeen: false,
      },
    });

    const res = await getStatus(req("status"), { params: params() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state?.pulse).toBeDefined();
    expect(typeof body.paused).toBe("boolean");
    expect(Array.isArray(body.inFlight)).toBe(true);
    expect(body.config.autonomousDelivery).toBeDefined();
  });
});

describe("GET /foreman/events", () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const oldestMsg = `[foreman-routes-test] oldest ${stamp}`;
  const middleMsg = `[foreman-routes-test] middle ${stamp}`;
  const newestMsg = `[foreman-routes-test] newest ${stamp}`;
  const messages = [oldestMsg, middleMsg, newestMsg];

  async function purgeFixtures() {
    await prisma.foremanEvent.deleteMany({ where: { orgId, message: { in: messages } } });
  }

  beforeEach(async () => {
    await purgeFixtures();
    // Timestamps set explicitly, well past "now", so these three rows are
    // unambiguously the newest for this org regardless of scheduling jitter —
    // keeps the newest-first ordering assertions below deterministic. Kinds
    // are shipped/gated/shipped, in creation order.
    const base = Date.now() + 60_000;
    await prisma.foremanEvent.create({
      data: { orgId, kind: "shipped", message: oldestMsg, ts: new Date(base) },
    });
    await prisma.foremanEvent.create({
      data: { orgId, kind: "gated", message: middleMsg, ts: new Date(base + 1000) },
    });
    await prisma.foremanEvent.create({
      data: { orgId, kind: "shipped", message: newestMsg, ts: new Date(base + 2000) },
    });
  });

  afterEach(purgeFixtures);

  it("paginates newest-first via id cursor, nulling nextCursor once a page comes back short", async () => {
    const page1 = await getEvents(req("events?limit=2"), { params: params() });
    expect(page1.status).toBe(200);
    const body1 = await page1.json();
    expect(body1.events).toHaveLength(2);
    expect(body1.events.map((e: { message: string }) => e.message)).toEqual([newestMsg, middleMsg]);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await getEvents(req(`events?limit=2&cursor=${body1.nextCursor}`), { params: params() });
    expect(page2.status).toBe(200);
    const body2 = await page2.json();
    // The 3rd seeded row (oldest) is what remains once the first two newest
    // rows have been paged through.
    expect(body2.events.map((e: { message: string }) => e.message)).toEqual([oldestMsg]);
    expect(body2.nextCursor).toBeNull();
  });

  it("?kind=shipped returns only kind:shipped rows", async () => {
    const res = await getEvents(req("events?kind=shipped&limit=10"), { params: params() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(2);
    expect(body.events.every((e: { kind: string }) => e.kind === "shipped")).toBe(true);
    expect(body.events.map((e: { message: string }) => e.message)).toEqual([newestMsg, oldestMsg]);
  });
});

describe("GET /foreman/status and /foreman/events — auth", () => {
  it("rejects a caller without ORG_UPDATE on both routes (non-200)", async () => {
    getAuthContext.mockResolvedValue(ctx(Permission.PROJECT_READ));

    const statusRes = await getStatus(req("status"), { params: params() });
    expect(statusRes.status).not.toBe(200);
    expect(statusRes.status).toBeGreaterThanOrEqual(400);

    const eventsRes = await getEvents(req("events"), { params: params() });
    expect(eventsRes.status).not.toBe(200);
    expect(eventsRes.status).toBeGreaterThanOrEqual(400);
  });
});
