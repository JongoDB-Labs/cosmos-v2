// @vitest-environment node
//
// Foreman connect API routes (task 4) — initiate/exchange/status/disconnect for
// Foreman's OWN per-org Claude subscription, against the REAL e2e DB (a
// throwaway org per test, matching foreman-claude-subscription.test.ts's
// `makeOrg` convention) — only `getAuthContext` is mocked (session cookies
// aren't available in a route-handler test, matching foreman/routes.test.ts's
// style); `@/lib/db/client` is left unmocked so the real queries run. Proves:
//   - POST initiate returns { url } and sets the SEALED
//     `foreman_claude_oauth_pkce` cookie — a DISTINCT name from the org flow's
//     `claude_oauth_pkce`, so a concurrent org connect can't collide;
//   - GET status returns { connected: false } for an org with no Foreman
//     connection yet;
//   - POST exchange reads that distinct cookie, completes the flow, and
//     deletes the cookie; a missing cookie fails gracefully (no throw);
//   - POST disconnect closes the loop (status flips back to connected:false);
//   - a non-admin member (missing ORG_MANAGE_SETTINGS) gets 403 on all four.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { prisma } from "@/lib/db/client";
import { openSecret } from "@/lib/crypto/vault";
import { POST as initiate } from "./initiate/route";
import { POST as exchange } from "./exchange/route";
import { GET as getStatus } from "./status/route";
import { POST as disconnect } from "./disconnect/route";

const PKCE_COOKIE = "foreman_claude_oauth_pkce";
const ORG_PKCE_COOKIE = "claude_oauth_pkce"; // the org flow's cookie — must stay distinct

/* -------------------------------------------------------------------------- */
/*  Vault env — sealSecret/openSecret read process.env at call time            */
/* -------------------------------------------------------------------------- */

const VAULT_KEY = crypto.randomBytes(32).toString("base64");
const ORIGINAL_VAULT_KEY = process.env.SSO_VAULT_KEY;

beforeAll(() => {
  process.env.SSO_VAULT_KEY = VAULT_KEY;
  delete process.env.SSO_VAULT_KEYS;
  delete process.env.SSO_VAULT_ACTIVE_KID;
});

afterAll(() => {
  if (ORIGINAL_VAULT_KEY === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = ORIGINAL_VAULT_KEY;
});

/* -------------------------------------------------------------------------- */
/*  Fixtures — a throwaway org per test (e2e DB), cleaned up afterAll          */
/* -------------------------------------------------------------------------- */

const cleanup: { orgIds: string[] } = { orgIds: [] };
afterAll(async () => {
  await prisma.organization
    .deleteMany({ where: { id: { in: cleanup.orgIds } } })
    .catch(() => undefined);
});

async function makeOrg() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await prisma.user.findFirstOrThrow({
    where: { email: "alice@test.local" },
  });
  const org = await prisma.organization.create({
    data: {
      name: `org-foreman-routes-test ${stamp}`,
      slug: `org-foreman-routes-test-${stamp}`,
    },
  });
  cleanup.orgIds.push(org.id);
  return { org, owner };
}

function ctx(
  orgId: string,
  userId: string,
  perms: bigint,
  orgRole: OrgRole = OrgRole.ADMIN,
): AuthContext {
  return {
    userId,
    orgId,
    orgRole,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
  };
}

function params(orgId: string) {
  return Promise.resolve({ orgId });
}

// Next's NextRequest constructor declares its own (slightly stricter) local
// RequestInit type — derive from the constructor itself rather than importing
// the global DOM RequestInit, which isn't assignable to it (e.g. `signal`'s
// nullability differs).
type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function req(orgId: string, path: string, init?: NextRequestInit) {
  return new NextRequest(
    `http://localhost/api/v1/orgs/${orgId}/foreman/claude-subscription/${path}`,
    init,
  );
}

function exchangeReq(orgId: string, code: string, cookieValue?: string) {
  return new NextRequest(
    `http://localhost/api/v1/orgs/${orgId}/foreman/claude-subscription/exchange`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookieValue ? { cookie: `${PKCE_COOKIE}=${cookieValue}` } : {}),
      },
      body: JSON.stringify({ code }),
    },
  );
}

/** Stub global fetch so exchangeForemanClaudeCode's token-endpoint call succeeds
 *  without hitting the network (mirrors foreman-claude-subscription.test.ts). */
function stubTokenResponse(body: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body))),
  );
}

// The route handlers are typed to return `Response | NextResponse` (the
// 404/401 branches use a plain `new Response(...)`), so plain `Response`
// doesn't statically expose `.cookies`. On the success paths exercised below
// the concrete value is always the `success()` helper's `NextResponse` — cast
// at the call site rather than widen the (intentionally mirrored,
// unmodified) route implementations just for test convenience.
async function callInitiate(orgId: string): Promise<NextResponse> {
  return (await initiate(req(orgId, "initiate", { method: "POST" }), {
    params: params(orgId),
  })) as NextResponse;
}

async function callExchange(
  orgId: string,
  code: string,
  cookieValue?: string,
): Promise<NextResponse> {
  return (await exchange(exchangeReq(orgId, code, cookieValue), {
    params: params(orgId),
  })) as NextResponse;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */

describe("POST /foreman/claude-subscription/initiate", () => {
  it("returns { url } and sets the sealed foreman_claude_oauth_pkce cookie", async () => {
    const { org, owner } = await makeOrg();
    getAuthContext.mockResolvedValue(
      ctx(org.id, owner.id, Permission.ORG_MANAGE_SETTINGS),
    );

    const res = await callInitiate(org.id);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.url).toBe("string");
    // Foreman requests the broader claude_code session scope (task 3), not the
    // narrower inference-only scope the org/user flows use.
    expect(body.url).toContain(
      "scope=user%3Ainference+user%3Aprofile+user%3Asessions%3Aclaude_code",
    );

    const cookie = res.cookies.get(PKCE_COOKIE);
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);

    const pkce = JSON.parse(openSecret(cookie!.value)) as {
      verifier: string;
      state: string;
    };
    expect(pkce.verifier.length).toBeGreaterThan(0);
    expect(pkce.state.length).toBeGreaterThan(0);
  });
});

describe("GET /foreman/claude-subscription/status", () => {
  it("returns { connected: false } for an org with no Foreman connection", async () => {
    const { org, owner } = await makeOrg();
    getAuthContext.mockResolvedValue(
      ctx(org.id, owner.id, Permission.ORG_MANAGE_SETTINGS),
    );

    const res = await getStatus(req(org.id, "status"), {
      params: params(org.id),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ connected: false });
  });
});

describe("POST /foreman/claude-subscription/exchange", () => {
  it("reads the distinct foreman_claude_oauth_pkce cookie, completes the exchange, and deletes the cookie", async () => {
    const { org, owner } = await makeOrg();
    getAuthContext.mockResolvedValue(
      ctx(org.id, owner.id, Permission.ORG_MANAGE_SETTINGS),
    );

    const initiateRes = await callInitiate(org.id);
    const pkceCookieValue = initiateRes.cookies.get(PKCE_COOKIE)!.value;
    // The org flow's cookie must never be touched by the Foreman route.
    expect(initiateRes.cookies.get(ORG_PKCE_COOKIE)).toBeUndefined();

    stubTokenResponse({
      access_token: "FT",
      refresh_token: "FR",
      expires_in: 3600,
    });

    // A bare code (no `#state` suffix) skips state validation in
    // exchangeClaudeCodeCore, so this doesn't need to know the state minted
    // inside initiate — the route glue (cookie in → lib call → cookie out) is
    // what's under test here, not the core PKCE state-matching logic (already
    // covered by claude-oauth-core.test.ts).
    const res = await callExchange(org.id, "SOME-CODE", pkceCookieValue);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(res.cookies.get(PKCE_COOKIE)?.value).toBe("");

    const settings = await prisma.foremanAiSettings.findUnique({
      where: { orgId: org.id },
    });
    expect(settings?.oauthAccessToken).not.toBeNull();
    expect(settings?.updatedById).toBe(owner.id);
  });

  it("fails gracefully (no throw) when the PKCE cookie is missing", async () => {
    const { org, owner } = await makeOrg();
    getAuthContext.mockResolvedValue(
      ctx(org.id, owner.id, Permission.ORG_MANAGE_SETTINGS),
    );

    const res = await exchange(exchangeReq(org.id, "SOME-CODE"), {
      params: params(org.id),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/expired/i);
  });
});

describe("POST /foreman/claude-subscription/disconnect", () => {
  it("disconnects an existing connection; status flips back to connected:false", async () => {
    const { org, owner } = await makeOrg();
    getAuthContext.mockResolvedValue(
      ctx(org.id, owner.id, Permission.ORG_MANAGE_SETTINGS),
    );

    stubTokenResponse({
      access_token: "FT",
      refresh_token: "FR",
      expires_in: 3600,
    });
    const initiateRes = await callInitiate(org.id);
    const pkceCookieValue = initiateRes.cookies.get(PKCE_COOKIE)!.value;
    await callExchange(org.id, "SOME-CODE", pkceCookieValue);

    const disconnectRes = await disconnect(
      req(org.id, "disconnect", { method: "POST" }),
      { params: params(org.id) },
    );
    expect(disconnectRes.status).toBe(200);
    await expect(disconnectRes.json()).resolves.toEqual({ success: true });

    const statusRes = await getStatus(req(org.id, "status"), {
      params: params(org.id),
    });
    await expect(statusRes.json()).resolves.toEqual({ connected: false });
  });
});

describe("auth — a non-admin member is refused on all four routes", () => {
  it("403s initiate/exchange/status/disconnect for a member missing ORG_MANAGE_SETTINGS", async () => {
    const { org, owner } = await makeOrg();
    getAuthContext.mockResolvedValue(
      ctx(org.id, owner.id, Permission.PROJECT_READ, OrgRole.MEMBER),
    );

    const initiateRes = await initiate(
      req(org.id, "initiate", { method: "POST" }),
      { params: params(org.id) },
    );
    expect(initiateRes.status).toBe(403);

    const exchangeRes = await exchange(exchangeReq(org.id, "x", "whatever"), {
      params: params(org.id),
    });
    expect(exchangeRes.status).toBe(403);

    const statusRes = await getStatus(req(org.id, "status"), {
      params: params(org.id),
    });
    expect(statusRes.status).toBe(403);

    const disconnectRes = await disconnect(
      req(org.id, "disconnect", { method: "POST" }),
      { params: params(org.id) },
    );
    expect(disconnectRes.status).toBe(403);
  });
});
