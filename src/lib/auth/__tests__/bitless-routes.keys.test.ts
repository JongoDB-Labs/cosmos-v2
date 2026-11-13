// @vitest-environment node
//
// The table in bitless-routes.table.ts, driven through the real handlers.
//
// For each route a key is refused: a key holding EVERY scope gets 403 and the
// handler touches nothing (no table, no storage, no audit row), while a
// browser session gets past the gate and reaches its work. For each route a
// key needs scopes for: a key without them gets 403, one with them gets
// through. The database is a stand-in that records what a request touched and
// returns nothing, so "got through" means "reached the database", whatever
// status the empty stand-in then produces.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";
import { API_KEY_SCOPES } from "@/lib/auth/api-key-scopes";
import { BITLESS_ROUTES, BRANCH_BITLESS_ROUTES, type KeyAccess } from "./bitless-routes.table";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "88888888-8888-4888-8888-888888888888";

const h = vi.hoisted(() => ({ ctx: null as unknown, touched: [] as string[] }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
vi.mock("@/lib/auth/api-key", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/api-key")>()),
  resolveAuth: async () => h.ctx,
}));
vi.mock("@/lib/audit", () => ({ logAudit: async () => { h.touched.push("audit"); } }));
// The caller's membership, as the request's context holds it. Minting a key
// judges its creator by this (api-key-manage.server mintStanding); the empty
// database below would otherwise say they are no member at all.
vi.mock("@/lib/rbac/effective-permissions", async (orig) => ({
  ...(await orig<typeof import("@/lib/rbac/effective-permissions")>()),
  loadEffectivePermissions: async () => {
    h.touched.push("orgMember.findUnique");
    const c = h.ctx as AuthContext | null;
    return c && { orgRole: c.orgRole, permissions: c.permissions, basePermissions: c.permissions, abacRules: [] };
  },
}));
vi.mock("@/lib/storage", () => ({
  getStorage: () => new Proxy({}, { get: (_t, op: string) => async () => { h.touched.push(`storage.${op}`); return null; } }),
}));
vi.mock("@/lib/db/client", () => {
  // The org every handler looks up first; anything past that records what it
  // touched and finds nothing.
  const org = { id: ORG, slug: "acme", tenantClass: "COMMERCIAL", settings: {
    logoStorageKey: `${ORG}/branding/logo.png`, logoContentType: "image/png",
    // So a session reaches the calendar-feed handlers' work, not the off switch.
    calendarFeeds: { enabled: true },
  } };
  const model = (name: string) =>
    new Proxy({}, { get: (_m, op: string) => async () => { h.touched.push(`${name}.${op}`); return null; } });
  const prisma = new Proxy({}, {
    get: (_t, name: string) => {
      if (name === "organization") return { findUnique: async () => org, findFirst: async () => org };
      if (name === "$transaction") return async () => { h.touched.push("$transaction"); return null; };
      return model(name);
    },
  });
  return { prisma, prismaUnfiltered: prisma };
});

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

// keyId is a uuid because the key routes 404 any other id before looking.
const IDS = {
  orgId: ORG, feedId: "f1", feedbackId: "fb1", attachmentId: "a1", projectId: "p1", docId: "d1",
  keyId: "99999999-9999-4999-8999-999999999999",
};

/** The route module for a table key. */
async function load(entry: string): Promise<Handler> {
  const [method, path] = entry.split(" ");
  const mod = (await import(/* @vite-ignore */ `${process.cwd()}/src/app/api/${path}/route.ts`)) as Record<string, Handler>;
  return mod[method];
}

function req(entry: string): NextRequest {
  const method = entry.split(" ")[0];
  const body = method === "GET" || method === "DELETE" ? undefined : JSON.stringify({ title: "x" });
  return new NextRequest(`http://localhost/x?invites=cancel`, {
    method,
    ...(body ? { body, headers: { "Content-Type": "application/json" } } : {}),
  });
}

/** A key minted by an OWNER (every bit), narrowed to `scopes`, as apiKeyAuthContext builds it. */
async function key(scopes: string[]): Promise<AuthContext> {
  const { scopeMask } = await import("@/lib/auth/api-key");
  const mask = RolePermissions.OWNER & scopeMask(scopes);
  return { userId: ME, orgId: ORG, orgRole: OrgRole.OWNER, permissions: mask, basePermissions: mask, abacRules: [], isApiKey: true, scopes };
}

/** A MEMBER's browser session. */
const session = (): AuthContext => ({
  userId: ME, orgId: ORG, orgRole: OrgRole.MEMBER,
  permissions: RolePermissions.MEMBER, basePermissions: RolePermissions.MEMBER, abacRules: [],
});

async function call(entry: string, ctx: AuthContext) {
  h.ctx = ctx;
  h.touched.length = 0;
  const res = await (await load(entry))(req(entry), { params: Promise.resolve(IDS) });
  return { status: res.status, touched: [...h.touched] };
}

beforeEach(() => { h.touched.length = 0; h.ctx = null; });

const ALL = { ...BITLESS_ROUTES, ...BRANCH_BITLESS_ROUTES } as Record<string, KeyAccess>;
const of = (kind: KeyAccess["key"]) => Object.entries(ALL).filter(([, a]) => a.key === kind).map(([e]) => e);

describe("routes that refuse a key", () => {
  it.each(of("refused"))("%s: a key with every scope is refused before any work", async (entry) => {
    const r = await call(entry, await key([...API_KEY_SCOPES]));
    expect(r.status).toBe(403);
    expect(r.touched).toEqual([]);
  });

  it.each(of("refused"))("%s: a browser session gets past the gate", async (entry) => {
    const r = await call(entry, session());
    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(401);
    // The positive control: the session reached the handler's work.
    expect(r.touched.length + (r.status < 300 ? 1 : 0)).toBeGreaterThan(0);
  });
});

describe("routes a key may use with the right scopes", () => {
  const scoped = Object.entries(ALL).filter((e): e is [string, Extract<KeyAccess, { key: "scope" }>] => e[1].key === "scope");

  it.each(scoped)("%s: a key without its scopes is refused", async (entry) => {
    const r = await call(entry, await key(["time:read", "rules:run"]));
    expect(r.status).toBe(403);
    expect(r.touched).toEqual([]);
  });

  it.each(scoped)("%s: a key with its scopes gets through", async (entry, access) => {
    const r = await call(entry, await key(access.scopes));
    expect(r.status).not.toBe(403);
    expect(r.touched.length + (r.status < 300 ? 1 : 0)).toBeGreaterThan(0);
  });

  it.each(scoped)("%s: a browser session gets through", async (entry) => {
    const r = await call(entry, session());
    expect(r.status).not.toBe(403);
    expect(r.touched.length + (r.status < 300 ? 1 : 0)).toBeGreaterThan(0);
  });
});

describe("a key acting on its own upload needs the scope that uploads", () => {
  const entry = "DELETE v1/orgs/[orgId]/projects/[projectId]/documents/[docId]";

  it("a read key is refused before the file is looked up", async () => {
    const r = await call(entry, await key(["read"]));
    expect(r.status).toBe(403);
    expect(r.touched).toEqual([]);
  });

  it.each([["planning:write"], ["items:write"], ["documents:write"]])("a %s key gets through", async (scope) => {
    const r = await call(entry, await key([scope]));
    expect(r.status).not.toBe(403);
    expect(r.touched).toContain("document.findFirst");
  });

  it("a session gets through with no bit, as the uploader always could", async () => {
    const r = await call(entry, { ...session(), permissions: Permission.ORG_READ, basePermissions: Permission.ORG_READ });
    expect(r.status).not.toBe(403);
    expect(r.touched).toContain("document.findFirst");
  });
});
