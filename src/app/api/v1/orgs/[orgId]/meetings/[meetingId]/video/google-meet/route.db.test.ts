// @vitest-environment node
//
// Adding a Google Meet to a meeting changes its link, which shows in Outlook:
// the attendees' Outlook copies get the new link at once, as any other edit
// to a synced field does. Through the real route and the real push, against
// the e2e DB and the in-memory Graph; only Google and the session are stubbed.
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";

const h = vi.hoisted(() => ({
  ctx: null as unknown,
  deps: null as null | { fetch: typeof fetch; sleep: (ms: number) => Promise<void> },
  runs: [] as Promise<unknown>[],
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
vi.mock("@/lib/auth/provider-config", () => ({
  getProviderConfig: async () => ({ enabled: true, clientId: "client-id", clientSecret: "client-secret", tenant: null }),
}));
vi.mock("@/lib/rate-limit/bucket", async (orig) => {
  const actual = await orig<typeof import("@/lib/rate-limit/bucket")>();
  return { ...actual, rateLimit: () => ({ allowed: true as const, remaining: 99 }) };
});
const MEET = "https://meet.google.com/abc-defg-hij";
vi.mock("@/lib/integrations/google", () => ({
  getMeetClient: async () => ({ spaces: { create: async () => ({ data: { name: "spaces/abc", meetingUri: MEET } }) } }),
}));
// The push runs for real, against the in-memory Graph.
vi.mock("@/lib/integrations/microsoft/calendar-sync.server", async (orig) => {
  const actual = await orig<typeof import("@/lib/integrations/microsoft/calendar-sync.server")>();
  return { ...actual, syncMeetingSoon: (orgId: string, id: string) => void h.runs.push(actual.syncMeeting(orgId, id, h.deps!)) };
});

import { fakeGraph } from "@/lib/testing/fake-graph";
import { MS_CALENDAR } from "@/lib/integrations/microsoft/calendar-connect";
import { _resetCalendarTokenCache, completeCalendarConnect } from "@/lib/integrations/microsoft/calendar-token.server";
import { syncMeeting } from "@/lib/integrations/microsoft/calendar-sync.server";
import { POST } from "./route";

const TENANT = "11111111-2222-3333-4444-555555555555";
const jwt = (p: object) => `x.${Buffer.from(JSON.stringify(p)).toString("base64url")}.y`;
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const email = `ann-${stamp}@gmeet.test`;
const ORIGINAL_VAULT_KEY = process.env.SSO_VAULT_KEY;
let orgId = "", userId = "", meetingId = "";

beforeAll(async () => {
  process.env.SSO_VAULT_KEY = crypto.randomBytes(32).toString("base64");
  _resetCalendarTokenCache();
  userId = (await prisma.user.create({ data: { email, displayName: "Ann" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `gmeet ${stamp}`, slug: `gmeet-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId, role: "ADMIN" } });
  await prisma.integration.create({
    data: { orgId, provider: MS_CALENDAR, displayName: "Outlook Calendar", config: { tenantId: TENANT }, status: "ACTIVE", installedById: userId },
  });
  const fetchFn = (async (url: unknown) =>
    String(url).includes("/me?")
      ? new Response(JSON.stringify({ mail: null, userPrincipalName: email }), { status: 200 })
      : new Response(
          JSON.stringify({ access_token: `at-${userId}`, refresh_token: "rt", expires_in: 3600, id_token: jwt({ tid: TENANT, oid: `oid-${userId}`, preferred_username: email }) }),
          { status: 200 },
        )) as unknown as typeof fetch;
  await completeCalendarConnect(
    { orgId, userId, code: "c", verifier: "v", redirectUri: "https://x/cb", origin: "https://cosmos.example" },
    { fetch: fetchFn },
  );
  meetingId = (await prisma.syncMeeting.create({
    data: { orgId, title: `meet ${stamp}`, meetingDate: new Date(Date.now() + 3_600_000), createdById: userId, notes: "", attendees: { create: [{ userId }] } },
  })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  if (ORIGINAL_VAULT_KEY === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = ORIGINAL_VAULT_KEY;
});

describe("adding a Google Meet (e2e DB, in-memory Graph)", () => {
  it("puts the Meet link in the attendees' Outlook copies at once", async () => {
    const g = fakeGraph();
    g.setAddress(`Bearer at-${userId}`, email);
    h.deps = { fetch: g.fetch, sleep: g.sleep };
    await syncMeeting(orgId, meetingId, h.deps); // their copy, before the Meet
    const copy = () => [...g.events.values()].map((e) => e.body?.content ?? "");
    expect(copy()).toHaveLength(1);
    expect(copy()[0]).not.toContain(MEET); // the positive control: not there yet

    h.ctx = { userId, orgId, orgRole: "ADMIN", abacRules: [], permissions: -1n, basePermissions: -1n } as AuthContext;
    const res = await POST(new NextRequest("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ orgId, meetingId }) });
    expect(res.status).toBe(200);
    await Promise.all(h.runs);
    expect(h.runs).toHaveLength(1);
    expect(copy()).toHaveLength(1); // the same copy, updated
    expect(copy()[0]).toContain(`Join: ${MEET}`);
  });
});
