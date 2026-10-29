// @vitest-environment node
//
// COSMOS-202: changing a sharing level rewrites that person's Outlook copies,
// which is the same Graph work "Sync now" does. So it must spend the SAME
// per-person budget rather than a second one of its own — otherwise this route
// is an unmetered way to run "Sync now" as often as you like. The real rate
// limiter runs here (that is the thing under test); only the DB, auth and the
// sync itself are mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const ORG_ID = "11111111-1111-4111-a111-111111111111";

const { getAuthContext, prisma, syncUserSoon, syncUserNow, calendarConnection, patchCalendarMeta } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn(), update: vi.fn() },
  },
  syncUserSoon: vi.fn(),
  syncUserNow: vi.fn(),
  calendarConnection: vi.fn(),
  patchCalendarMeta: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/integrations/microsoft/calendar-sync.server", () => ({ syncUserSoon, syncUserNow }));
vi.mock("@/lib/integrations/microsoft/calendar-token.server", () => ({
  calendarConnection,
  patchCalendarMeta,
  calendarSharingState: async () => ({ level: "busy", orgDefault: "full", effective: "busy" }),
  CalendarNotConnected: class extends Error {},
  CalendarReconnectNeeded: class extends Error {},
}));
vi.mock("@/lib/integrations/microsoft/graph.server", () => ({ GraphThrottled: class extends Error {} }));

import { PUT } from "./route";
import { POST as SYNC_NOW } from "../sync/route";

/** A fresh person per test: the limiter is keyed by user, so buckets never leak across tests. */
let me: string;
const person = (): AuthContext => ({
  userId: me, orgId: ORG_ID, orgRole: OrgRole.ADMIN,
  permissions: Permission.INTEGRATION_MANAGE, basePermissions: Permission.INTEGRATION_MANAGE, abacRules: [],
});
const params = () => Promise.resolve({ orgId: ORG_ID });
const put = (body: object) =>
  new NextRequest("http://localhost/api/v1/orgs/o/microsoft/calendar/sharing", { method: "PUT", body: JSON.stringify(body) });
const syncReq = () => new NextRequest("http://localhost/api/v1/orgs/o/microsoft/calendar/sync", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  me = randomUUID();
  getAuthContext.mockImplementation(async () => person());
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme", settings: {} });
  prisma.organization.update.mockResolvedValue({});
  calendarConnection.mockResolvedValue({ id: "cred-1", meta: { status: "connected" }, updatedAt: new Date() });
  syncUserNow.mockResolvedValue({ applied: 0, ignored: 0, echoes: 0, detached: 0 });
});

describe("PUT /microsoft/calendar/sharing — the resync budget", () => {
  it("resyncs the first three changes a minute, then saves without resyncing and says so", async () => {
    for (let i = 1; i <= 3; i++) {
      const res = await PUT(put({ level: "busy" }), { params: params() });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ resyncNow: true });
      expect(syncUserSoon).toHaveBeenCalledTimes(i);
    }

    // Fourth in the same minute: the level is still SAVED, nothing is resynced,
    // and the answer says the calendar catches up later rather than now.
    const res = await PUT(put({ level: "full" }), { params: params() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resyncNow: false });
    expect(syncUserSoon).toHaveBeenCalledTimes(3);
    expect(patchCalendarMeta).toHaveBeenLastCalledWith("cred-1", { sharingLevel: "full" });
  });

  it("spends the SAME bucket as Sync now, so it cannot be used to get extra syncs", async () => {
    for (let i = 0; i < 3; i++) await PUT(put({ level: "busy" }), { params: params() });

    const res = await SYNC_NOW(syncReq(), { params: params() });
    expect(res.status).toBe(429);
    expect(syncUserNow).not.toHaveBeenCalled();
  });

  it("charges nothing when there is nothing to resync", async () => {
    // Bodies that set neither level nor default: no Graph work, so no token.
    // Three of them — a whole budget's worth — then Sync now must still run,
    // which a single wasted token per call would not allow.
    for (let i = 0; i < 3; i++) {
      const res = await PUT(put({}), { params: params() });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ resyncNow: false });
    }
    expect(syncUserSoon).not.toHaveBeenCalled();
    expect((await SYNC_NOW(syncReq(), { params: params() })).status).toBe(200);
  });

  it("does not resync, or charge, someone who has no connection to resync", async () => {
    calendarConnection.mockResolvedValue(null);
    for (let i = 0; i < 3; i++) {
      const res = await PUT(put({ orgDefault: "busy" }), { params: params() });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ resyncNow: false });
    }
    expect(syncUserSoon).not.toHaveBeenCalled();
    // The admin's own budget was not spent on syncs that never ran.
    expect((await SYNC_NOW(syncReq(), { params: params() })).status).toBe(200);
  });
});
