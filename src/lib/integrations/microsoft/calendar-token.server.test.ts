// COSMOS-202 (B1, e2e DB): a person's Outlook Calendar tokens. The refresh
// token is the only thing stored (sealed); refreshing is single-flight and
// persists Microsoft's rotated token; a revoked token means "reconnect", once,
// with no retry loop; and a connection that should no longer exist is deleted.
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/db/client";
import { openSecret } from "@/lib/crypto/vault";
import { setProviderConfig } from "@/lib/auth/provider-config";
import { MS_CALENDAR } from "./calendar-connect";
import {
  CalendarNotConnected,
  CalendarReconnectNeeded,
  _resetCalendarTokenCache,
  calendarAccessToken,
  completeCalendarConnect,
  purgeOrgCalendarConnections,
} from "./calendar-token.server";

const TENANT = "11111111-2222-3333-4444-555555555555";
const jwt = (p: object) => `x.${Buffer.from(JSON.stringify(p)).toString("base64url")}.y`;
const ID_TOKEN = jwt({ tid: TENANT, oid: "oid-1", preferred_username: "alice@contoso.example" });

/** A stand-in token endpoint: records calls, answers from a script. */
function tokenEndpoint(reply: (body: URLSearchParams, n: number) => { status: number; json: object }) {
  const calls: URLSearchParams[] = [];
  const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    calls.push(body);
    // Simulate network latency so concurrent callers really overlap.
    await new Promise((r) => setTimeout(r, 50));
    const { status, json } = reply(body, calls.length);
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

// The real vault, under a throwaway key.
const ORIGINAL_VAULT_KEY = process.env.SSO_VAULT_KEY;
beforeAll(() => {
  process.env.SSO_VAULT_KEY = crypto.randomBytes(32).toString("base64");
});
afterAll(() => {
  if (ORIGINAL_VAULT_KEY === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = ORIGINAL_VAULT_KEY;
});

describe("Outlook Calendar tokens (e2e DB)", () => {
  const orgIds: string[] = [];
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
    await prisma.authProviderConfig.deleteMany({ where: { provider: "microsoft" } }).catch(() => undefined);
  });
  beforeEach(() => _resetCalendarTokenCache());

  async function setup({ tenantId = TENANT } = {}) {
    await setProviderConfig("microsoft", { clientId: "client-id", clientSecret: "client-secret", enabled: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const user = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({ data: { name: `msc ${stamp}`, slug: `msc-${stamp}` } });
    orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: user.id, role: "MEMBER" } });
    const integration = await prisma.integration.create({
      data: { orgId: org.id, provider: MS_CALENDAR, displayName: "Outlook Calendar", config: { tenantId }, status: "ACTIVE", installedById: user.id },
    });
    return { org, user, integration };
  }

  async function connect(orgId: string, userId: string, refreshToken = "rt-0") {
    const ep = tokenEndpoint(() => ({ status: 200, json: { access_token: "at-0", refresh_token: refreshToken, id_token: ID_TOKEN, expires_in: 3600 } }));
    await completeCalendarConnect({ orgId, userId, code: "code", verifier: "v", redirectUri: "https://x/cb" }, { fetch: ep.fetchFn });
    return ep;
  }

  const storedRt = async (orgId: string, userId: string) => {
    const row = await prisma.connectorCredential.findFirstOrThrow({ where: { orgId, provider: MS_CALENDAR, userId } });
    return (JSON.parse(openSecret(row.secretEnc)) as { refreshToken: string }).refreshToken;
  };

  it("connects: exchanges the code with the PKCE verifier and stores only a sealed refresh token", async () => {
    const { org, user } = await setup();
    const ep = await connect(org.id, user.id);
    expect(ep.calls[0].get("grant_type")).toBe("authorization_code");
    expect(ep.calls[0].get("code_verifier")).toBe("v");
    const row = await prisma.connectorCredential.findFirstOrThrow({ where: { orgId: org.id, provider: MS_CALENDAR, userId: user.id } });
    expect(row.secretEnc).not.toContain("rt-0");
    expect(await storedRt(org.id, user.id)).toBe("rt-0");
    expect(row.meta).toMatchObject({ tid: TENANT, oid: "oid-1", upn: "alice@contoso.example", status: "connected" });
    expect(JSON.stringify(row.meta)).not.toMatch(/rt-0|at-0/);
  });

  it("refuses an account from another tenant and stores nothing", async () => {
    const { org, user } = await setup({ tenantId: "99999999-0000-0000-0000-000000000000" });
    await expect(connect(org.id, user.id)).rejects.toThrow(/different organization/);
    expect(await prisma.connectorCredential.count({ where: { orgId: org.id, provider: MS_CALENDAR } })).toBe(0);
  });

  it("refreshes once for two concurrent callers, and keeps Microsoft's rotated refresh token", async () => {
    const { org, user } = await setup();
    await connect(org.id, user.id, "rt-1");
    _resetCalendarTokenCache(); // force a refresh
    const ep = tokenEndpoint(() => ({ status: 200, json: { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 } }));
    const [a, b] = await Promise.all([
      calendarAccessToken(org.id, user.id, { fetch: ep.fetchFn }),
      calendarAccessToken(org.id, user.id, { fetch: ep.fetchFn }),
    ]);
    expect([a, b]).toEqual(["at-2", "at-2"]);
    expect(ep.calls).toHaveLength(1);
    expect(ep.calls[0].get("grant_type")).toBe("refresh_token");
    expect(ep.calls[0].get("refresh_token")).toBe("rt-1");
    expect(await storedRt(org.id, user.id)).toBe("rt-2");
    // Cached afterwards: no further call.
    await calendarAccessToken(org.id, user.id, { fetch: ep.fetchFn });
    expect(ep.calls).toHaveLength(1);
  });

  it("turns a revoked refresh token into 'reconnect' once, and never calls Microsoft again for it", async () => {
    const { org, user } = await setup();
    await connect(org.id, user.id);
    _resetCalendarTokenCache();
    const ep = tokenEndpoint(() => ({ status: 400, json: { error: "invalid_grant", error_codes: [70008] } }));
    await expect(calendarAccessToken(org.id, user.id, { fetch: ep.fetchFn })).rejects.toBeInstanceOf(CalendarReconnectNeeded);
    const row = await prisma.connectorCredential.findFirstOrThrow({ where: { orgId: org.id, provider: MS_CALENDAR, userId: user.id } });
    expect(row.meta).toMatchObject({ status: "reconnect" });
    await expect(calendarAccessToken(org.id, user.id, { fetch: ep.fetchFn })).rejects.toBeInstanceOf(CalendarReconnectNeeded);
    expect(ep.calls).toHaveLength(1);
  });

  it("surfaces a transient Microsoft error without marking the connection for reconnect", async () => {
    const { org, user } = await setup();
    await connect(org.id, user.id);
    _resetCalendarTokenCache();
    const ep = tokenEndpoint(() => ({ status: 503, json: { error: "temporarily_unavailable" } }));
    await expect(calendarAccessToken(org.id, user.id, { fetch: ep.fetchFn })).rejects.toThrow(/503/);
    const row = await prisma.connectorCredential.findFirstOrThrow({ where: { orgId: org.id, provider: MS_CALENDAR, userId: user.id } });
    expect(row.meta).toMatchObject({ status: "connected" });
    expect(await storedRt(org.id, user.id)).toBe("rt-0");
  });

  it("deletes the connection when the org turns the integration off", async () => {
    const { org, user, integration } = await setup();
    await connect(org.id, user.id);
    await prisma.integration.update({ where: { id: integration.id }, data: { status: "INACTIVE" } });
    await expect(calendarAccessToken(org.id, user.id)).rejects.toBeInstanceOf(CalendarNotConnected);
    expect(await prisma.connectorCredential.count({ where: { orgId: org.id, provider: MS_CALENDAR } })).toBe(0);
  });

  it("deletes the connection when the person leaves the org, or the pinned tenant changes", async () => {
    const left = await setup();
    await connect(left.org.id, left.user.id);
    await prisma.orgMember.deleteMany({ where: { orgId: left.org.id, userId: left.user.id } });
    await expect(calendarAccessToken(left.org.id, left.user.id)).rejects.toBeInstanceOf(CalendarNotConnected);
    expect(await prisma.connectorCredential.count({ where: { orgId: left.org.id, provider: MS_CALENDAR } })).toBe(0);

    const moved = await setup();
    await connect(moved.org.id, moved.user.id);
    await prisma.integration.update({ where: { id: moved.integration.id }, data: { config: { tenantId: "another-tenant" } } });
    await expect(calendarAccessToken(moved.org.id, moved.user.id)).rejects.toBeInstanceOf(CalendarNotConnected);
    expect(await prisma.connectorCredential.count({ where: { orgId: moved.org.id, provider: MS_CALENDAR } })).toBe(0);
  });

  it("purges every person's connection in one org, and only that org", async () => {
    const a = await setup();
    const b = await setup();
    await connect(a.org.id, a.user.id);
    await connect(b.org.id, b.user.id);
    expect(await purgeOrgCalendarConnections(a.org.id)).toBe(1);
    expect(await prisma.connectorCredential.count({ where: { orgId: a.org.id, provider: MS_CALENDAR } })).toBe(0);
    expect(await prisma.connectorCredential.count({ where: { orgId: b.org.id, provider: MS_CALENDAR } })).toBe(1);
  });
});
