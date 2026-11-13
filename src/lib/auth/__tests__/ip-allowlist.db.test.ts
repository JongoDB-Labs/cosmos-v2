// @vitest-environment node
/**
 * The org IP allowlist trusts only the address the deployment's edge wrote,
 * and applies to every way in: a session, a key through getAuthContext, and a
 * key through resolveAuth (the routes that take a Request).
 *
 * Real auth against a real database. Only `next/headers` is replaced, by the
 * request's headers, which is what getAuthContext reads in production.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { current } = vi.hoisted(() => ({ current: { headers: new Headers() } }));
vi.mock("next/headers", () => {
  const jar = () =>
    new Map(
      (current.headers.get("cookie") ?? "")
        .split(";")
        .map((c) => c.trim().split("="))
        .filter(([k]) => k)
        .map(([k, ...v]) => [k, v.join("=")] as [string, string]),
    );
  return {
    headers: async () => current.headers,
    cookies: async () => {
      const j = jar();
      return {
        get: (name: string) => (j.has(name) ? { name, value: j.get(name)! } : undefined),
        getAll: () => [...j].map(([name, value]) => ({ name, value })),
        has: (name: string) => j.has(name),
        set: () => undefined,
        delete: () => undefined,
      };
    },
  };
});

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { NextRequest } from "next/server";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { mintApiKey } from "@/lib/auth/api-key";
import { securitySettingsFor } from "@/lib/auth/ip-allowlist";
import { GET as listProjectDocuments } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/documents/route";
import { POST as addEntry } from "@/app/api/v1/orgs/[orgId]/security/ip-allowlist/route";
import { DELETE as deleteEntry, PUT as relabelEntry } from "@/app/api/v1/orgs/[orgId]/security/ip-allowlist/[entryId]/route";
import { GET as readSettings, PUT as saveSettings } from "@/app/api/v1/orgs/[orgId]/security/settings/route";

const INSIDE = "198.51.100.7"; // in the org's allowlist
const OUTSIDE = "203.0.113.9"; // not

const stamp = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
let org: { id: string; slug: string };
let userId = "";
let projectId = "";
let sessionId = "";
let key = "";

beforeAll(async () => {
  org = await prisma.organization.create({ data: { name: `IP ${stamp}`, slug: `ip-${stamp}` } });
  userId = (await prisma.user.create({ data: { email: `ip-${stamp}@allowlist.test`, displayName: "Allowlist owner" } })).id;
  const member = await prisma.orgMember.create({ data: { orgId: org.id, userId, role: "OWNER" } });
  const project = await prisma.project.create({ data: { orgId: org.id, name: "Project", key: "IPAL" } });
  projectId = project.id;
  await prisma.projectMember.create({ data: { projectId, orgMemberId: member.id } });
  await prisma.orgSecuritySettings.create({ data: { orgId: org.id, ipAllowlistEnabled: true } });
  await prisma.ipAllowlist.create({ data: { orgId: org.id, cidr: "198.51.100.0/24" } });
  sessionId = randomBytes(32).toString("hex");
  await prisma.session.create({ data: { id: sessionId, userId, expiresAt: new Date(Date.now() + 3_600_000) } });
  key = (await mintApiKey({ orgId: org.id, name: "allowlist", scopes: ["read"], createdById: userId })).token;
}, 60_000);

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId: org.id } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
});

afterEach(() => vi.unstubAllEnvs());

/** getAuthContext for a request carrying these headers. */
function asRequest(h: Record<string, string>) {
  current.headers = new Headers(h);
  return getAuthContext(org.slug);
}
/** Read when called: the session id exists only once beforeAll has run. */
const session = () => ({ cookie: `session=${sessionId}` });

describe("a signed-in member, with the default setup (the edge sets X-Forwarded-For)", () => {
  it("is let in from inside the allowlist (the positive control)", async () => {
    expect(await asRequest({ ...session(), "x-forwarded-for": INSIDE })).not.toBeNull();
  });

  it("is refused from outside it", async () => {
    expect(await asRequest({ ...session(), "x-forwarded-for": OUTSIDE })).toBeNull();
  });

  it("can't get in by sending an allowed address in a header the edge doesn't set", async () => {
    for (const spoof of ["cf-connecting-ip", "x-real-ip"]) {
      expect(await asRequest({ ...session(), [spoof]: INSIDE, "x-forwarded-for": OUTSIDE }), spoof).toBeNull();
    }
  });

  it("can't get in by writing an allowed address ahead of the one the edge appended", async () => {
    expect(await asRequest({ ...session(), "x-forwarded-for": `${INSIDE}, ${OUTSIDE}` })).toBeNull();
    expect(await asRequest({ ...session(), "x-forwarded-for": `${OUTSIDE}, ${INSIDE}` })).not.toBeNull();
  });
});

describe("a deployment that names its edge's header", () => {
  it("TRUSTED_CLIENT_IP_HEADER: reads that header and nothing else", async () => {
    vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "CF-Connecting-IP");
    expect(await asRequest({ ...session(), "cf-connecting-ip": INSIDE, "x-forwarded-for": OUTSIDE })).not.toBeNull();
    expect(await asRequest({ ...session(), "cf-connecting-ip": OUTSIDE, "x-forwarded-for": INSIDE })).toBeNull();
  });

  it("TRUSTED_PROXY_HOPS: counts that many entries from the right", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(await asRequest({ ...session(), "x-forwarded-for": `${OUTSIDE}, ${INSIDE}, 10.0.0.2` })).not.toBeNull();
    expect(await asRequest({ ...session(), "x-forwarded-for": `${INSIDE}, ${OUTSIDE}, 10.0.0.2` })).toBeNull();
  });
});

describe("an API key meets the same allowlist", () => {
  const bearer = () => ({ authorization: `Bearer ${key}` });

  it("through getAuthContext", async () => {
    expect(await asRequest({ ...bearer(), "x-forwarded-for": INSIDE })).not.toBeNull();
    expect(await asRequest({ ...bearer(), "x-forwarded-for": OUTSIDE })).toBeNull();
    expect(await asRequest({ ...bearer(), "cf-connecting-ip": INSIDE, "x-forwarded-for": OUTSIDE })).toBeNull();
  });

  it("through a route that authenticates with resolveAuth", async () => {
    const call = (h: Record<string, string>) => {
      current.headers = new Headers(h);
      return listProjectDocuments(
        new NextRequest(`http://localhost/api/v1/orgs/${org.id}/projects/${projectId}/documents`, { headers: h }),
        { params: Promise.resolve({ orgId: org.id, projectId }) },
      );
    };
    expect((await call({ ...bearer(), "x-forwarded-for": INSIDE })).status).toBe(200);
    expect((await call({ ...bearer(), "x-forwarded-for": OUTSIDE })).status).toBe(401);
    expect((await call({ ...bearer(), "cf-connecting-ip": INSIDE, "x-forwarded-for": OUTSIDE })).status).toBe(401);
  });
});

describe("with the allowlist off, nothing changes", () => {
  it("lets the member and the key in from anywhere", async () => {
    await prisma.orgSecuritySettings.update({ where: { orgId: org.id }, data: { ipAllowlistEnabled: false } });
    try {
      expect(await asRequest({ ...session(), "x-forwarded-for": OUTSIDE })).not.toBeNull();
      expect(await asRequest({ authorization: `Bearer ${key}`, "x-forwarded-for": OUTSIDE })).not.toBeNull();
    } finally {
      await prisma.orgSecuritySettings.update({ where: { orgId: org.id }, data: { ipAllowlistEnabled: true } });
    }
  });
});

describe("an admin can't lock themselves out", () => {
  // An org of its own, so these changes can't disturb the cases above.
  const lockStamp = `${stamp}l`;
  let lockOrg: { id: string; slug: string };
  let lockUser = "";
  let lockSession = "";
  beforeAll(async () => {
    lockOrg = await prisma.organization.create({ data: { name: `Lock ${lockStamp}`, slug: `lock-${lockStamp}` } });
    lockUser = (await prisma.user.create({ data: { email: `lock-${lockStamp}@allowlist.test`, displayName: "Lock owner" } })).id;
    await prisma.orgMember.create({ data: { orgId: lockOrg.id, userId: lockUser, role: "OWNER" } });
    await prisma.orgSecuritySettings.create({ data: { orgId: lockOrg.id, ipAllowlistEnabled: false } });
    lockSession = randomBytes(32).toString("hex");
    await prisma.session.create({ data: { id: lockSession, userId: lockUser, expiresAt: new Date(Date.now() + 3_600_000) } });
  });
  afterAll(async () => {
    await prisma.session.deleteMany({ where: { userId: lockUser } });
    await prismaUnfiltered.orgMember.deleteMany({ where: { orgId: lockOrg.id } }).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { id: lockOrg.id } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: lockUser } }).catch(() => undefined);
  });

  /** Call a handler as the org's owner, from `from` (null: no address the edge wrote). */
  async function as<T extends Record<string, string>>(
    handler: (req: NextRequest, ctx: { params: Promise<T> }) => Promise<Response>,
    from: string | null,
    method: string,
    path: string,
    params: T,
    body?: unknown,
  ) {
    const h: Record<string, string> = { cookie: `session=${lockSession}`, "content-type": "application/json" };
    if (from) h["x-forwarded-for"] = from;
    current.headers = new Headers(h);
    const res = await handler(
      new NextRequest(`http://localhost/api/v1/orgs/${lockOrg.id}/security/${path}`, {
        method, headers: h, ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
      { params: Promise.resolve(params) },
    );
    return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as Record<string, unknown>) };
  }
  const org = () => ({ orgId: lockOrg.id });
  const add = (from: string | null, cidr: string) => as(addEntry, from, "POST", "ip-allowlist", org(), { cidr });
  const remove = (from: string | null, entryId: string) =>
    as(deleteEntry, from, "DELETE", `ip-allowlist/${entryId}`, { ...org(), entryId });
  const turnOn = (from: string | null) => as(saveSettings, from, "PUT", "settings", org(), { ipAllowlistEnabled: true });
  const enabled = async () =>
    (await prisma.orgSecuritySettings.findUniqueOrThrow({ where: { orgId: lockOrg.id } })).ipAllowlistEnabled;
  const cidrs = async () => (await prisma.ipAllowlist.findMany({ where: { orgId: lockOrg.id } })).map((e) => e.cidr).sort();
  const reset = async (on: boolean) => {
    await prisma.ipAllowlist.deleteMany({ where: { orgId: lockOrg.id } });
    await prisma.orgSecuritySettings.update({ where: { orgId: lockOrg.id }, data: { ipAllowlistEnabled: on } });
  };

  it("shows the address Cosmos sees, so the admin knows what to add", async () => {
    expect((await as(readSettings, OUTSIDE, "GET", "settings", org())).body?.clientIp).toBe(OUTSIDE);
    expect((await as(readSettings, null, "GET", "settings", org())).body?.clientIp).toBeNull();
  });

  it("gives the settings page the same answer as the route, address included", async () => {
    // The page renders from a server prefetch and never refetches, so a
    // prefetch without the address told every admin Cosmos couldn't read it.
    const fromRoute = (await as(readSettings, OUTSIDE, "GET", "settings", org())).body!;
    const forPage = await securitySettingsFor(lockOrg.id, new Headers({ "x-forwarded-for": OUTSIDE }));
    expect(forPage.clientIp).toBe(OUTSIDE);
    expect(Object.keys(forPage).sort()).toEqual(Object.keys(fromRoute).sort());
    // And the page does prefetch through it (a real call, not a name in a comment).
    const pageFile = path.resolve(__dirname, "../../../app/(dashboard)/[orgSlug]/settings/security/page.tsx");
    const sf = ts.createSourceFile(pageFile, readFileSync(pageFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let calls = 0;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "securitySettingsFor") calls++;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(calls).toBe(1);
  });

  it("refuses to turn the allowlist on while it doesn't hold the admin's address", async () => {
    await reset(false);
    expect((await add(OUTSIDE, "192.0.2.0/24")).status).toBe(201); // off: a list edit changes nobody's access
    const res = await turnOn(OUTSIDE);
    expect(res.status).toBe(409);
    expect(res.body?.error).toBe(`This would block your own address (Cosmos sees you as ${OUTSIDE}). Add it first.`);
    expect(await enabled()).toBe(false);
    // The positive control: from inside the list, it turns on.
    expect((await turnOn("192.0.2.5")).status).toBe(200);
    expect(await enabled()).toBe(true);
  });

  it("refuses an entry that would be the first and leave the admin out", async () => {
    await reset(true); // on, and empty: everyone is let in until the first entry
    const res = await add(OUTSIDE, "192.0.2.0/24");
    expect(res.status).toBe(409);
    expect(res.body?.error).toContain(`Cosmos sees you as ${OUTSIDE}`);
    expect(await cidrs()).toEqual([]);
    expect((await add(OUTSIDE, "203.0.113.0/24")).status).toBe(201);
    expect(await cidrs()).toEqual(["203.0.113.0/24"]);
  });

  it("refuses to delete the entry that holds the admin's address, and allows it from another one", async () => {
    await reset(true);
    expect((await add("192.0.2.5", "192.0.2.0/24")).status).toBe(201);
    expect((await add("192.0.2.5", "198.51.100.0/24")).status).toBe(201);
    const own = (await prisma.ipAllowlist.findFirstOrThrow({ where: { orgId: lockOrg.id, cidr: "192.0.2.0/24" } })).id;
    const res = await remove("192.0.2.5", own);
    expect(res.status).toBe(409);
    expect(await cidrs()).toEqual(["192.0.2.0/24", "198.51.100.0/24"]);
    // Relabelling changes nobody's access, so it is never refused.
    expect((await as(relabelEntry, "192.0.2.5", "PUT", `ip-allowlist/${own}`, { ...org(), entryId: own }, { label: "Office" })).status).toBe(200);
    expect((await remove("198.51.100.7", own)).status).toBe(204);
    expect(await cidrs()).toEqual(["198.51.100.0/24"]);
  });

  it("refuses when it can't read the admin's address at all", async () => {
    await reset(true);
    const res = await add(null, "192.0.2.0/24");
    expect(res.status).toBe(409);
    expect(String(res.body?.error)).toMatch(/can't read/);
    expect(await cidrs()).toEqual([]);
  });
});

