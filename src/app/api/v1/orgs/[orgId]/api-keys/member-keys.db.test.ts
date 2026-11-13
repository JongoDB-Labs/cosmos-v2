// @vitest-environment node
//
// Every member can mint their own API keys, and each key acts with that
// person's own access. Against a real database, through the real routes AND
// the real `getAuthContext`: only `next/headers` is stood in for, so a cookie
// request runs the session path and a bearer request runs the key path, as
// they do in production.
//
// The rule under test, in one line: a key authenticates only while its creator
// may hold keys (API_KEY_CREATE or API_KEY_MANAGE, and the org's switch on for
// people without API_KEY_MANAGE), and, where the org requires single sign-on,
// a key of someone without API_KEY_MANAGE only if it was made through that
// org's IdP. Minting asks the same question.
//
// Own users and org throughout: the seeded test users are shared by every DB
// spec running in parallel, and this file demotes and re-promotes people.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";

// The request the route is answering. Each call below sets it first.
const h = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => h.headers,
  cookies: async () => ({
    get: (name: string) => {
      const m = (h.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
      return m ? { name, value: m[1] } : undefined;
    },
  }),
}));
// getAuthContext is wrapped in React's per-request `cache`; every call here is
// its own request.
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
// A project edit revalidates the org's cached project list, which needs the
// Next request store; outside Next there is nothing to revalidate.
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidateTag: () => undefined }));

import { GET as listKeys, POST as mintKey } from "./route";
import { DELETE as revokeKey } from "./[keyId]/route";
import { GET as listProjects } from "../projects/route";
import { PUT as updateProject } from "../projects/[projectId]/route";
import { PUT as updateItem } from "../projects/[projectId]/work-items/[itemId]/route";
import { PUT as putSecurity } from "../security/settings/route";
import { GET as listMembers, POST as addMember } from "../members/route";
import { DELETE as removeMember } from "../members/[memberId]/route";
import { GET as listKpis } from "../projects/[projectId]/kpis/route";
import { GET as listKpiPoints } from "../projects/[projectId]/kpis/[kpiId]/data-points/route";
import { POST as postTeamsDigest } from "../integrations/teams/digest/route";
import { Permission, RolePermissions, maskToDb } from "@/lib/rbac/permissions";
import { scopeGrantable } from "@/lib/auth/api-key-policy";
import { completeSsoLogin, type SsoClaims } from "@/lib/auth/sso";

const stamp = Math.random().toString(36).slice(2, 8);
const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

type Person = { userId: string; memberId: string; session: string; name: string; email: string };
let orgId = "";
let visible = ""; // a project every member can see
let hidden = ""; // a team-scoped project no member here is on
let typeId = "";
let kpiId = "";
const kpiName = `Revenue KPI ${stamp}`;
const people: Record<string, Person> = {};
const userIds: string[] = [];
const orgIds: string[] = [];

type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | "GUEST" | "BILLING_ADMIN";
async function person(key: string, role: Role, opts: { org?: string; permissions?: bigint } = {}) {
  const name = `Person ${key} ${stamp}`;
  const email = `${key}-${stamp}@memberkeys.test`;
  const userId = (await prisma.user.create({ data: { email, displayName: name } })).id;
  userIds.push(userId);
  const memberId = (await prisma.orgMember.create({
    data: { orgId: opts.org ?? orgId, userId, role, permissions: maskToDb(opts.permissions ?? 0n) },
  })).id;
  const session = randomBytes(24).toString("hex");
  await prisma.session.create({ data: { id: session, userId, expiresAt: new Date(Date.now() + DAY) } });
  people[key] = { userId, memberId, session, name, email };
  return people[key];
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `mk ${stamp}`, slug: `mk-${stamp}` } })).id;
  orgIds.push(orgId);
  for (const [key, role] of [
    ["owner", "OWNER"], ["admin", "ADMIN"], ["member", "MEMBER"], ["other", "MEMBER"],
    ["viewer", "VIEWER"], ["guest", "GUEST"], ["demoted", "MEMBER"], ["capped", "MEMBER"],
    ["billing", "BILLING_ADMIN"], ["leaver", "MEMBER"], ["exadmin", "ADMIN"], ["racer", "MEMBER"],
  ] as const) {
    await person(key, role);
  }
  // A member who may run rules (an explicit grant, as a work role could give)
  // but may not manage integrations.
  await person("scheduler", "MEMBER", { permissions: Permission.RULES_RUN });
  // A member the org's access policy denies KPIs, though their role grants them.
  const denied = await person("denied", "MEMBER");
  await prisma.orgMember.update({
    where: { id: denied.memberId },
    data: { abacRules: { rules: [{ effect: "deny", actions: ["ANALYTICS_READ"], conditions: [] }] } },
  });
  // The same policy on an owner: their session's break-glass passes it, their keys don't.
  const deniedOwner = await person("deniedowner", "OWNER");
  await prisma.orgMember.update({
    where: { id: deniedOwner.memberId },
    data: { abacRules: { rules: [{ effect: "deny", actions: ["ANALYTICS_READ"], conditions: [] }] } },
  });
  visible = (await prisma.project.create({ data: { orgId, name: "Open", key: `MO${stamp.slice(0, 3).toUpperCase()}` } })).id;
  hidden = (await prisma.project.create({
    data: { orgId, name: "Team only", key: `MH${stamp.slice(0, 3).toUpperCase()}`, teamScopedAccess: true },
  })).id;
  await ensureFixtureStatuses(visible);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;
  kpiId = (await prisma.kpi.create({ data: { orgId, projectId: visible, name: kpiName, targetValue: 100, currentValue: 42 } })).id;
  await prisma.kpiDataPoint.create({ data: { kpiId, value: 42 } });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

// ── requests ────────────────────────────────────────────────────────────────
const asSession = (p: Person) => { h.headers = new Headers({ cookie: `session=${p.session}` }); };
const asKey = (token: string) => { h.headers = new Headers({ authorization: `Bearer ${token}` }); };
const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    headers: h.headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const orgParams = () => ({ params: Promise.resolve({ orgId }) });

type Minted = { id: string; token: string; scopes: string[]; projectIds: string[]; expiresAt: string | null };
async function mintAs(p: Person, body: Record<string, unknown>) {
  asSession(p);
  const res = await mintKey(req("POST", { name: "k", expiresAt: inDays(30), ...body }), orgParams());
  return { res, json: (await res.json().catch(() => null)) as (Minted & { error?: string; detail?: string }) | null };
}
async function listAs(p: Person) {
  asSession(p);
  const res = await listKeys(req("GET"), orgParams());
  return { res, text: res.status === 200 ? await res.clone().text() : "", rows: res.status === 200 ? ((await res.json()) as Array<Record<string, unknown>>) : [] };
}
/** What the key list says about each key, by id: null when it works, else why not. */
async function standingIn(viewer: Person, org = orgId) {
  asSession(viewer);
  const res = await listKeys(req("GET"), { params: Promise.resolve({ orgId: org }) });
  expect(res.status).toBe(200);
  const rows = (await res.json()) as Array<{ id: string; inactiveReason: string | null }>;
  return Object.fromEntries(rows.map((r) => [r.id, r.inactiveReason]));
}
async function revokeAs(p: Person, keyId: string) {
  asSession(p);
  return revokeKey(req("DELETE"), { params: Promise.resolve({ orgId, keyId }) });
}
async function projectsWithKey(token: string) {
  asKey(token);
  return listProjects(req("GET"), orgParams());
}
/** A key written straight to the table: isolates the AUTHENTICATION rule from minting. */
async function fixtureKeyRow(
  p: Person,
  scopes: string[],
  opts: { org?: string; createdAt?: Date; expiresAt?: Date | null; idpConnId?: string } = {},
) {
  const prefix = randomBytes(6).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const { id } = await prisma.apiKey.create({
    data: {
      orgId: opts.org ?? orgId, name: "fixture", prefix, keyHash: createHash("sha256").update(secret).digest("hex"), scopes,
      createdById: p.userId, projectIds: [], expiresAt: opts.expiresAt ?? null, ...(opts.createdAt && { createdAt: opts.createdAt }),
      ...(opts.idpConnId && { idpConnId: opts.idpConnId }),
    },
  });
  return { id, prefix, token: `cosmos_${prefix}_${secret}` };
}
const fixtureKey = async (p: Person, scopes: string[], opts?: Parameters<typeof fixtureKeyRow>[2]) =>
  (await fixtureKeyRow(p, scopes, opts)).token;
const keyExists = async (id: string) => !!(await prisma.apiKey.findUnique({ where: { id } }));
const errorText = (j: { error?: string; detail?: string } | null) => `${j?.error ?? ""} ${j?.detail ?? ""}`;

// ── tests ───────────────────────────────────────────────────────────────────

describe("a member manages their own keys", () => {
  it("mints, lists and revokes their own key; mint and revoke are audited without the token", async () => {
    const m = people.member;
    const { res, json } = await mintAs(m, { name: "my script", scopes: ["read", "items:write"] });
    expect(res.status).toBe(201);
    expect(json!.token).toMatch(/^cosmos_[0-9a-f]+_/);
    const keyId = json!.id;

    const listed = await listAs(m);
    expect(listed.res.status).toBe(200);
    expect(listed.rows.map((r) => r.id)).toContain(keyId);
    expect(listed.text).not.toContain("keyHash");
    expect(listed.text).not.toContain(json!.token);

    expect((await revokeAs(m, keyId)).status).toBe(204);
    expect(await keyExists(keyId)).toBe(false);
    expect((await listAs(m)).rows.map((r) => r.id)).not.toContain(keyId);

    const audit = await prisma.auditLog.findMany({ where: { orgId, entityId: keyId }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["api_key.created", "api_key.revoked"]);
    // The secret is everything after the hex prefix. It is base64url, so it can
    // hold "_" itself: split("_")[2] would cut it short, and an empty piece
    // (a secret starting with "_") is "contained" in every string.
    const secret = json!.token.split("_").slice(2).join("_");
    expect(secret.length).toBeGreaterThan(20);
    for (const a of audit) {
      expect(a.userId).toBe(m.userId);
      expect(a.metadata).toMatchObject({ name: "my script", scopes: ["read", "items:write"], projectIds: [] });
      expect(typeof (a.metadata as Record<string, unknown>).prefix).toBe("string");
      expect((a.metadata as Record<string, unknown>).expiresAt).toEqual(expect.any(String));
      expect(JSON.stringify(a.metadata)).not.toContain(secret);
    }
  });

  it("can't list or revoke someone else's key: 404 like a missing one, and the row survives", async () => {
    const own = await mintAs(people.member, { scopes: ["read"] });
    const theirs = await mintAs(people.other, { scopes: ["read"] });
    expect(own.res.status).toBe(201);
    expect(theirs.res.status).toBe(201);

    const ids = (await listAs(people.member)).rows.map((r) => r.id);
    expect(ids).toContain(own.json!.id); // positive control: the list is not just empty
    expect(ids).not.toContain(theirs.json!.id);

    const res = await revokeAs(people.member, theirs.json!.id);
    expect(res.status).toBe(404);
    expect(await keyExists(theirs.json!.id)).toBe(true);
    // The same answer as an id that does not exist at all.
    expect((await revokeAs(people.member, randomUUID())).status).toBe(404);
  });
});

describe("an admin oversees every key", () => {
  it("sees all keys with their creator (no email addresses) and can revoke any", async () => {
    const theirs = await mintAs(people.other, { scopes: ["read"] });
    expect(theirs.res.status).toBe(201);

    const listed = await listAs(people.admin);
    expect(listed.res.status).toBe(200);
    const row = listed.rows.find((r) => r.id === theirs.json!.id);
    expect(row).toBeDefined();
    expect(row!.createdBy).toEqual({ id: people.other.userId, name: people.other.name });
    expect(listed.text).not.toContain(people.other.email);
    expect(listed.text).not.toContain("keyHash");

    expect((await revokeAs(people.admin, theirs.json!.id)).status).toBe(204);
    expect(await keyExists(theirs.json!.id)).toBe(false);
  });

  it("may still mint a key that never expires", async () => {
    const { res, json } = await mintAs(people.admin, { scopes: ["read"], expiresAt: null });
    expect(res.status).toBe(201);
    expect(json!.expiresAt).toBeNull();
  });
});

describe("a key can't manage keys", () => {
  it("can't mint (even an owner's key) and can't revoke, and nothing changes", async () => {
    const ownerKey = await fixtureKey(people.owner, ["read", "items:write", "items:delete", "planning:write", "webhooks:manage", "audit:read"]);
    // Positive control: the key itself authenticates.
    expect((await projectsWithKey(ownerKey)).status).toBe(200);

    const before = await prisma.apiKey.count({ where: { orgId } });
    asKey(ownerKey);
    const mint = await mintKey(req("POST", { name: "from a key", scopes: ["read"], expiresAt: inDays(10) }), orgParams());
    expect(mint.status).toBe(403);
    expect(await prisma.apiKey.count({ where: { orgId } })).toBe(before);

    const victim = await fixtureKeyRow(people.member, ["read"]);
    asKey(ownerKey);
    const del = await revokeKey(req("DELETE"), { params: Promise.resolve({ orgId, keyId: victim.id }) });
    expect(del.status).toBe(403);
    expect(await keyExists(victim.id)).toBe(true);
  });
});

describe("who may mint", () => {
  it("a guest is refused (mint and list), and no key is written", async () => {
    const before = await prisma.apiKey.count({ where: { orgId, createdById: people.guest.userId } });
    const { res } = await mintAs(people.guest, { scopes: ["read"] });
    expect(res.status).toBe(403);
    expect((await listAs(people.guest)).res.status).toBe(403);
    expect(await prisma.apiKey.count({ where: { orgId, createdById: people.guest.userId } })).toBe(before);
  });

  it("a viewer may mint a read key", async () => {
    const { res } = await mintAs(people.viewer, { scopes: ["read"] });
    expect(res.status).toBe(201);
  });
});

describe("the org switch", () => {
  it("off: members can't mint and their keys stop working; admins' keys and minting go on; on again restores them", async () => {
    const memberKey = await fixtureKey(people.member, ["read"]);
    const adminKey = await fixtureKey(people.admin, ["read"]);
    expect((await projectsWithKey(memberKey)).status).toBe(200); // positive control
    expect((await projectsWithKey(adminKey)).status).toBe(200);

    const memberKeyId = (await prisma.apiKey.findFirstOrThrow({ where: { prefix: memberKey.split("_")[1] } })).id;
    const adminKeyId = (await prisma.apiKey.findFirstOrThrow({ where: { prefix: adminKey.split("_")[1] } })).id;
    expect(await standingIn(people.admin)).toMatchObject({ [memberKeyId]: null, [adminKeyId]: null });

    asSession(people.admin);
    expect((await putSecurity(req("PUT", { memberApiKeysEnabled: false }), orgParams())).status).toBe(200);
    try {
      // The list says so, rather than showing an expiry the key won't reach.
      expect(await standingIn(people.admin)).toMatchObject({ [memberKeyId]: "switch_off", [adminKeyId]: null });
      expect((await projectsWithKey(memberKey)).status).toBe(401);
      expect((await projectsWithKey(adminKey)).status).toBe(200);
      expect((await mintAs(people.member, { scopes: ["read"] })).res.status).toBe(403);
      expect((await mintAs(people.admin, { scopes: ["read"] })).res.status).toBe(201);
    } finally {
      asSession(people.admin);
      expect((await putSecurity(req("PUT", { memberApiKeysEnabled: true }), orgParams())).status).toBe(200);
    }
    // It is the switch, not a deletion: the same key works again.
    expect((await projectsWithKey(memberKey)).status).toBe(200);
  });
});

describe("the creator's current access", () => {
  it("demoting the creator to guest makes their key fail authentication", async () => {
    const row = await fixtureKeyRow(people.demoted, ["read"]);
    const key = row.token;
    expect((await projectsWithKey(key)).status).toBe(200); // positive control
    expect((await standingIn(people.admin))[row.id]).toBeNull();
    await prisma.orgMember.update({ where: { id: people.demoted.memberId }, data: { role: "GUEST" } });
    try {
      expect((await projectsWithKey(key)).status).toBe(401);
      expect((await standingIn(people.admin))[row.id]).toBe("role");
    } finally {
      await prisma.orgMember.update({ where: { id: people.demoted.memberId }, data: { role: "MEMBER" } });
    }
    expect((await projectsWithKey(key)).status).toBe(200);
  });

  it("a member's key never does more than the member: it edits an item they can edit, and is refused a project edit they can't make", async () => {
    const item = await createFixtureWorkItem({ orgId, projectId: visible, workItemTypeId: typeId, createdById: people.member.userId, title: "before", columnKey: "todo" });
    const minted = await mintAs(people.member, { scopes: ["items:write"] });
    expect(minted.res.status).toBe(201);
    const memberKey = minted.json!.token;

    asKey(memberKey);
    const edit = await updateItem(req("PUT", { title: "after" }), { params: Promise.resolve({ orgId, projectId: visible, itemId: item.id }) });
    expect(edit.status).toBe(200);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } })).title).toBe("after");

    // items:write carries PROJECT_UPDATE, which a member doesn't hold.
    asKey(memberKey);
    const rename = await updateProject(req("PUT", { name: "Renamed by member key" }), { params: Promise.resolve({ orgId, projectId: visible }) });
    expect(rename.status).toBe(403);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: visible } })).name).toBe("Open");

    // Positive control: the same scope on an admin's key does reach it.
    const adminKey = await fixtureKey(people.admin, ["items:write"]);
    asKey(adminKey);
    const adminRename = await updateProject(req("PUT", { name: "Open" }), { params: Promise.resolve({ orgId, projectId: visible }) });
    expect(adminRename.status).toBe(200);
  });

  it("a member's key lists only the projects the member can see", async () => {
    const key = await fixtureKey(people.member, ["read"]);
    const res = await projectsWithKey(key);
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(visible);
    expect(ids).not.toContain(hidden);
  });
});

describe("a key never reaches what its creator's session is refused", () => {
  // Some routes ask a key for a different bit than a session, because no scope
  // carries the session's bit (KPIs gate a session on ANALYTICS_READ and a key
  // on PROJECT_READ). The key must ALSO meet the session's bit through its
  // creator, or a role without it reads through a key what it can't in the app.
  const kpiParams = () => ({ params: Promise.resolve({ orgId, projectId: visible }) });
  const pointParams = () => ({ params: Promise.resolve({ orgId, projectId: visible, kpiId }) });

  it("a billing admin's read key can't read a project's KPIs, which their session can't either; an admin's read key can", async () => {
    asSession(people.billing);
    expect((await listKpis(req("GET"), kpiParams())).status).toBe(403);

    const minted = await mintAs(people.billing, { scopes: ["read"] });
    expect(minted.res.status).toBe(201);
    const billingKey = minted.json!.token;
    expect((await projectsWithKey(billingKey)).status).toBe(200); // the key itself works
    asKey(billingKey);
    const kpis = await listKpis(req("GET"), kpiParams());
    expect(kpis.status).toBe(403);
    expect(await kpis.text()).not.toContain(kpiName);
    asKey(billingKey);
    expect((await listKpiPoints(req("GET"), pointParams())).status).toBe(403);

    // Positive control: the same scope on an admin's key reads both.
    const adminKey = await fixtureKey(people.admin, ["read"]);
    asKey(adminKey);
    const adminKpis = await listKpis(req("GET"), kpiParams());
    expect(adminKpis.status).toBe(200);
    expect(await adminKpis.text()).toContain(kpiName);
    asKey(adminKey);
    expect((await listKpiPoints(req("GET"), pointParams())).status).toBe(200);
  });

  it("an access policy that denies the creator KPIs denies their key too, though the key's own bit is allowed", async () => {
    asSession(people.denied);
    expect((await listKpis(req("GET"), kpiParams())).status).toBe(403);
    const key = await fixtureKey(people.denied, ["read"]);
    expect((await projectsWithKey(key)).status).toBe(200); // the key itself works
    asKey(key);
    expect((await listKpis(req("GET"), kpiParams())).status).toBe(403);
    // Positive control: an ordinary member's read key reads them.
    asKey(await fixtureKey(people.member, ["read"]));
    expect((await listKpis(req("GET"), kpiParams())).status).toBe(200);
  });

  it("an owner's key meets the policy their session's break-glass passes: denied KPIs with the key, not in the session", async () => {
    asSession(people.deniedowner);
    expect((await listKpis(req("GET"), kpiParams())).status).toBe(200); // an owner's session can always undo a policy
    const key = await fixtureKey(people.deniedowner, ["read"]);
    expect((await projectsWithKey(key)).status).toBe(200); // the key itself works
    asKey(key);
    expect((await listKpis(req("GET"), kpiParams())).status).toBe(403);
    // Positive control: the plain owner's read key reads them.
    asKey(await fixtureKey(people.owner, ["read"]));
    expect((await listKpis(req("GET"), kpiParams())).status).toBe(200);
  });

  it("a member who may run rules can't post the Teams digest with a key when their session can't; an admin's key can", async () => {
    const digestParams = () => ({ params: Promise.resolve({ orgId }) });
    asSession(people.scheduler);
    expect((await postTeamsDigest(req("POST", {}), digestParams())).status).toBe(403);

    const minted = await mintAs(people.scheduler, { scopes: ["rules:run", "read"] });
    expect(minted.res.status).toBe(201);
    asKey(minted.json!.token);
    expect((await postTeamsDigest(req("POST", {}), digestParams())).status).toBe(403);

    // Positive control: an admin's key with the same scopes passes the gate
    // (the digest is off for this org, so nothing is posted).
    asKey(await fixtureKey(people.admin, ["rules:run", "read"]));
    const ok = await postTeamsDigest(req("POST", {}), digestParams());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ posted: false });
  });
});

describe("removing a member revokes their keys", () => {
  it("deletes their keys with the removal and audits it, so re-adding them brings no key back; other people's keys are untouched", async () => {
    const leaving = await fixtureKeyRow(people.leaver, ["read"]);
    const staying = await fixtureKey(people.other, ["read"]);
    expect((await projectsWithKey(leaving.token)).status).toBe(200); // positive control
    expect((await projectsWithKey(staying)).status).toBe(200);

    asSession(people.admin);
    const removed = await removeMember(req("DELETE"), { params: Promise.resolve({ orgId, memberId: people.leaver.memberId }) });
    expect(removed.status).toBe(204);
    expect(await keyExists(leaving.id)).toBe(false);
    expect((await projectsWithKey(staying)).status).toBe(200);

    const audit = await prisma.auditLog.findFirst({
      where: { orgId, action: "member.api_keys_revoked", entityId: people.leaver.memberId },
    });
    expect(audit).not.toBeNull();
    const meta = JSON.stringify(audit!.metadata);
    expect(meta).toContain(leaving.prefix);
    expect(meta).not.toContain(leaving.token.split("_").slice(2).join("_"));

    // Re-adding reinstates the same membership row (as the members POST and an
    // SSO sign-in do). The key is gone, so it stays refused.
    await prisma.orgMember.update({ where: { id: people.leaver.memberId }, data: { removedAt: null } });
    expect((await projectsWithKey(leaving.token)).status).toBe(401);
  });

  it("re-adding someone removed before removal deleted keys deletes the keys left on their row; other people's stay", async () => {
    const back = await person("returner", "MEMBER");
    const old = await fixtureKeyRow(back, ["read"]);
    const other = await fixtureKeyRow(people.other, ["read"]);
    expect((await projectsWithKey(old.token)).status).toBe(200); // positive control
    // Removed the old way: the row hidden, the keys left in place.
    await prismaUnfiltered.orgMember.update({ where: { id: back.memberId }, data: { removedAt: new Date() } });
    expect((await projectsWithKey(old.token)).status).toBe(401);
    expect(await keyExists(old.id)).toBe(true);
    expect(await standingIn(people.admin)).toMatchObject({ [old.id]: "creator_gone" });

    asSession(people.admin);
    const res = await addMember(req("POST", { userId: back.userId, role: "MEMBER" }), orgParams());
    expect(res.status).toBe(201);
    expect(await keyExists(old.id)).toBe(false);
    expect((await projectsWithKey(old.token)).status).toBe(401);
    expect(await keyExists(other.id)).toBe(true);
    const audit = await prisma.auditLog.findFirst({ where: { orgId, action: "member.api_keys_revoked", entityId: back.memberId } });
    expect(audit?.metadata).toMatchObject({ reason: "reinstated", revokedCount: 1, prefixes: [old.prefix] });
  });
});

describe("a key outlives its creator's right to an unlimited one", () => {
  it("an admin's never-expiring key ends 366 days after it was made once the admin can't manage keys; a newer one keeps working", async () => {
    const old = await fixtureKey(people.exadmin, ["read"], { createdAt: new Date(Date.now() - 400 * DAY), expiresAt: null });
    const recent = await fixtureKey(people.exadmin, ["read"], { expiresAt: null });
    expect((await projectsWithKey(old)).status).toBe(200); // positive control: an admin's key may be old
    expect((await projectsWithKey(recent)).status).toBe(200);

    // Each of a person's keys, by prefix: "<stored expiry> | <when it really stops>".
    const stopsAt = async (p: Person, viewer: Person = p) =>
      Object.fromEntries((await listAs(viewer)).rows.filter((r) => (r.createdBy as { id: string } | null)?.id === p.userId)
        .map((r) => [String(r.prefix), `${r.expiresAt} | ${r.effectiveExpiresAt}`]));
    // An admin's never-expiring keys: the list says so.
    expect(Object.values(await stopsAt(people.exadmin))).toEqual(["null | null", "null | null"]);

    await prisma.orgMember.update({ where: { id: people.exadmin.memberId }, data: { role: "MEMBER" } });
    try {
      expect((await projectsWithKey(old)).status).toBe(401);
      expect((await projectsWithKey(recent)).status).toBe(200);
      // The list now says when each one stops, as the creator and as an admin
      // sees it: the end of the 366th day after it was made. Still stored as
      // never-expiring.
      const rows = (await listAs(people.exadmin)).rows;
      const byPrefix = (token: string) => rows.find((r) => token.startsWith(`cosmos_${r.prefix}_`))!;
      for (const token of [old, recent]) {
        const row = byPrefix(token);
        expect(row.expiresAt).toBeNull();
        const made = new Date(String(row.createdAt));
        const end = new Date(Date.UTC(made.getUTCFullYear(), made.getUTCMonth(), made.getUTCDate() + 366, 23, 59, 59, 999));
        expect(row.effectiveExpiresAt).toBe(end.toISOString());
      }
      expect(new Date(String(byPrefix(old).effectiveExpiresAt)).getTime()).toBeLessThan(Date.now()); // the one that stopped
      expect(await stopsAt(people.exadmin, people.admin)).toEqual(await stopsAt(people.exadmin));
    } finally {
      await prisma.orgMember.update({ where: { id: people.exadmin.memberId }, data: { role: "ADMIN" } });
    }
    // The rule, not a deletion: promoted again, the old key works again.
    expect((await projectsWithKey(old)).status).toBe(200);
  });
});

describe("what a member may put on a key", () => {
  it("a scope the member can't use is refused with a 400 naming it, and no key is written", async () => {
    const before = await prisma.apiKey.count({ where: { orgId, createdById: people.member.userId } });
    const { res, json } = await mintAs(people.member, { scopes: ["read", "items:delete", "webhooks:manage"] });
    expect(res.status).toBe(400);
    const msg = errorText(json);
    expect(msg).toContain("items:delete");
    expect(msg).toContain("webhooks:manage");
    expect(msg).not.toMatch(/\bread\b(?!:)/);
    expect(await prisma.apiKey.count({ where: { orgId, createdById: people.member.userId } })).toBe(before);
  });

  it("every scope a member can use is accepted together (positive control for the refusal)", async () => {
    const { res } = await mintAs(people.member, {
      scopes: ["read", "items:write", "planning:write", "time:read", "time:write", "documents:write", "members:read"],
    });
    expect(res.status).toBe(201);
  });

  it("a hidden or unknown project is refused with the same 400; a visible one is accepted", async () => {
    const hiddenRes = await mintAs(people.member, { scopes: ["read"], projectIds: [hidden] });
    const unknownRes = await mintAs(people.member, { scopes: ["read"], projectIds: [randomUUID()] });
    const mixedRes = await mintAs(people.member, { scopes: ["read"], projectIds: [visible, hidden] });
    expect(hiddenRes.res.status).toBe(400);
    expect(unknownRes.res.status).toBe(400);
    expect(mixedRes.res.status).toBe(400);
    expect(errorText(hiddenRes.json)).toBe(errorText(unknownRes.json));

    const ok = await mintAs(people.member, { scopes: ["read"], projectIds: [visible] });
    expect(ok.res.status).toBe(201);
    expect(ok.json!.projectIds).toEqual([visible]);
    // The admin sees the hidden project, so the admin may name it.
    expect((await mintAs(people.admin, { scopes: ["read"], projectIds: [hidden] })).res.status).toBe(201);
  });

  it("must expire, within 366 days; an admin may choose no expiry", async () => {
    expect((await mintAs(people.member, { scopes: ["read"], expiresAt: null })).res.status).toBe(400);
    expect((await mintAs(people.member, { scopes: ["read"], expiresAt: undefined })).res.status).toBe(400);
    expect((await mintAs(people.member, { scopes: ["read"], expiresAt: inDays(368) })).res.status).toBe(400);
    expect((await mintAs(people.member, { scopes: ["read"], expiresAt: inDays(-1) })).res.status).toBe(400);
    expect((await mintAs(people.member, { scopes: ["read"], expiresAt: inDays(365) })).res.status).toBe(201);
    expect((await mintAs(people.admin, { scopes: ["read"], expiresAt: inDays(800) })).res.status).toBe(201);
  });

  it("at most 20 working keys per person; expired ones don't count", async () => {
    const c = people.capped;
    const rows = Array.from({ length: 19 }, (_, i) => ({
      orgId, name: `bulk ${i}`, prefix: randomBytes(6).toString("hex"), keyHash: "x", scopes: ["read"], createdById: c.userId, projectIds: [],
      expiresAt: new Date(Date.now() + 10 * DAY),
    }));
    rows.push({ ...rows[0], name: "expired", prefix: randomBytes(6).toString("hex"), expiresAt: new Date(Date.now() - DAY) });
    await prisma.apiKey.createMany({ data: rows });

    expect((await mintAs(c, { scopes: ["read"] })).res.status).toBe(201); // the 20th unexpired key
    const over = await mintAs(c, { scopes: ["read"] });
    expect(over.res.status).toBe(409);
    expect(errorText(over.json)).toContain("20");
    expect(await prisma.apiKey.count({ where: { orgId, createdById: c.userId } })).toBe(21);
  });

  it("a former admin's never-expiring keys stop counting toward the 20 once they pass the 366-day limit, as they stop working", async () => {
    const p = await person("lapsedcap", "MEMBER");
    const old = new Date(Date.now() - 400 * DAY);
    await prisma.apiKey.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        orgId, name: `old ${i}`, prefix: randomBytes(6).toString("hex"), keyHash: "x", scopes: ["read"],
        createdById: p.userId, projectIds: [], expiresAt: null, createdAt: old,
      })),
    });
    // None of the 20 works for a member: each passed the 366 days.
    const standing = await standingIn(people.admin);
    const ids = (await prisma.apiKey.findMany({ where: { orgId, createdById: p.userId }, select: { id: true } })).map((k) => k.id);
    expect(ids.map((id) => standing[id])).toEqual(Array(20).fill("lapsed"));
    expect((await mintAs(p, { scopes: ["read"] })).res.status).toBe(201);

    // Control: the same 20 keys, made recently, still work, so they count.
    const q = await person("freshcap", "MEMBER");
    await prisma.apiKey.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        orgId, name: `new ${i}`, prefix: randomBytes(6).toString("hex"), keyHash: "x", scopes: ["read"],
        createdById: q.userId, projectIds: [], expiresAt: null,
      })),
    });
    expect((await mintAs(q, { scopes: ["read"] })).res.status).toBe(409);
  });

  it("an owner whose API_KEY_MANAGE an org restriction removes mints as their keys are judged: no never-expiring key", async () => {
    const rx = (await prisma.organization.create({ data: { name: `mk rx ${stamp}`, slug: `mk-rx-${stamp}` } })).id;
    orgIds.push(rx);
    const owner = await person("rxowner", "OWNER", { org: rx });
    const rxParams = () => ({ params: Promise.resolve({ orgId: rx }) });
    const mint = async (expiresAt: string | null) => {
      asSession(owner);
      return (await mintKey(req("POST", { name: "k", scopes: ["read"], expiresAt }), rxParams())).status;
    };
    expect(await mint(null)).toBe(201); // positive control: an owner may, unrestricted

    await prisma.orgSecuritySettings.create({
      data: { orgId: rx, actionRestrictions: { rules: [{ effect: "deny", actions: ["API_KEY_MANAGE"], conditions: [] }] } },
    });
    // Their session keeps API_KEY_MANAGE (an owner's break-glass); their keys
    // don't, so a key minted now would lapse in 366 days. Minting says so.
    expect(await mint(null)).toBe(400);
    expect(await mint(inDays(800))).toBe(400);
    expect(await mint(inDays(30))).toBe(201);

    await prisma.orgSecuritySettings.update({ where: { orgId: rx }, data: { actionRestrictions: {} } });
    expect(await mint(null)).toBe(201);
  });

  it("holds when one member mints 25 keys at once: exactly 20 are made, the rest get 409", async () => {
    const r = people.racer;
    asSession(r); // what getAuthContext reads; each request below carries the same cookie
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        mintKey(
          new NextRequest("http://localhost/x", {
            method: "POST",
            headers: new Headers({ cookie: `session=${r.session}` }),
            body: JSON.stringify({ name: "race", scopes: ["read"], expiresAt: inDays(30) }),
          }),
          orgParams(),
        ),
      ),
    );
    const statuses = results.map((x) => x.status).sort();
    // Every request is answered as itself: no 500 for one that queued too long.
    expect(statuses.filter((s) => s !== 201 && s !== 409)).toEqual([]);
    expect(statuses.filter((s) => s === 201)).toHaveLength(20);
    expect(statuses.filter((s) => s === 409)).toHaveLength(5);
    expect(await prisma.apiKey.count({ where: { orgId, createdById: r.userId } })).toBe(20);
  });

  it("time:write is only for people who can log time: a viewer is refused it, a member gets it", async () => {
    const viewer = await mintAs(people.viewer, { scopes: ["time:write"] });
    expect(viewer.res.status).toBe(400);
    expect(errorText(viewer.json)).toContain("time:write");
    expect((await mintAs(people.viewer, { scopes: ["time:read"] })).res.status).toBe(201);
    expect((await mintAs(people.member, { scopes: ["time:write"] })).res.status).toBe(201);
  });
});

describe("members:read follows what a session can already see", () => {
  // api-key-policy.ts lets anyone who may mint put `members:read` on a key,
  // because every session role sees members' email addresses on GET /members.
  // This drives that route as each role, so the day it withholds them from
  // someone, this fails until the policy says the same.
  const roles = [
    ["owner", "OWNER"], ["admin", "ADMIN"], ["billing", "BILLING_ADMIN"],
    ["member", "MEMBER"], ["viewer", "VIEWER"], ["guest", "GUEST"],
  ] as const;
  it.each(roles)("%s: the policy offers members:read exactly when the session sees emails", async (key, role) => {
    asSession(people[key]);
    const res = await listMembers(req("GET"), orgParams());
    expect(res.status).toBe(200);
    const text = await res.text();
    // Positive control: the roster really came back (names are never withheld).
    expect(text).toContain(people.other.name);
    const seesEmails = text.includes(people.other.email);
    expect(scopeGrantable(RolePermissions[role], "members:read")).toBe(seesEmails);
  });
});

describe("turning on Require MFA revokes the keys of people who can't manage keys", () => {
  // Its own org: tightening revokes keys org-wide, and in a GOV org it also
  // signs everyone out. COMMERCIAL, because keys go in every tenant class.
  it("turning on Require MFA deletes every key whose creator can't manage keys, audits it and reports the count; admins' keys stay", async () => {
    const tight = (await prisma.organization.create({
      data: { name: `mk tight ${stamp}`, slug: `mk-tight-${stamp}`, tenantClass: "COMMERCIAL" },
    })).id;
    orgIds.push(tight);
    const admin = await person("tadmin", "ADMIN", { org: tight });
    const member = await person("tmember", "MEMBER", { org: tight });
    const memberKeys = [await fixtureKeyRow(member, ["read"], { org: tight }), await fixtureKeyRow(member, ["items:write"], { org: tight })];
    const adminKey = await fixtureKeyRow(admin, ["read"], { org: tight });
    const tightParams = () => ({ params: Promise.resolve({ orgId: tight }) });
    asKey(memberKeys[0].token);
    expect((await listProjects(req("GET"), tightParams())).status).toBe(200); // positive control

    // Re-saving without tightening revokes nothing.
    asSession(admin);
    const unchanged = await putSecurity(req("PUT", { sessionTimeoutMins: 600 }), tightParams());
    expect(unchanged.status).toBe(200);
    expect(await unchanged.json()).toMatchObject({ apiKeysRevoked: 0 });
    expect(await keyExists(memberKeys[0].id)).toBe(true);

    asSession(admin);
    const res = await putSecurity(req("PUT", { mfaRequired: true }), tightParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mfaRequired: true, apiKeysRevoked: 2 });
    for (const k of memberKeys) expect(await keyExists(k.id)).toBe(false);
    expect(await keyExists(adminKey.id)).toBe(true);
    asKey(memberKeys[0].token);
    expect((await listProjects(req("GET"), tightParams())).status).toBe(401);
    asKey(adminKey.token);
    expect((await listProjects(req("GET"), tightParams())).status).toBe(200);

    const audit = await prisma.auditLog.findFirst({ where: { orgId: tight, action: "security_settings.api_keys_revoked" } });
    expect(audit).not.toBeNull();
    const meta = JSON.stringify(audit!.metadata);
    expect(meta).toContain(memberKeys[0].prefix);
    expect(meta).not.toContain(adminKey.prefix);
  });

  it("the Enforce SSO setting revokes no keys: single sign-on binds keys through the org's IdP connection, when they are used", async () => {
    const flag = (await prisma.organization.create({
      data: { name: `mk flag ${stamp}`, slug: `mk-flag-${stamp}`, tenantClass: "COMMERCIAL" },
    })).id;
    orgIds.push(flag);
    const admin = await person("fadmin", "ADMIN", { org: flag });
    const member = await person("fmember", "MEMBER", { org: flag });
    const key = await fixtureKeyRow(member, ["read"], { org: flag });
    const flagParams = () => ({ params: Promise.resolve({ orgId: flag }) });

    asSession(admin);
    const res = await putSecurity(req("PUT", { ssoEnforced: true }), flagParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ssoEnforced: true, apiKeysRevoked: 0 });
    expect(await keyExists(key.id)).toBe(true);
    asKey(key.token);
    expect((await listProjects(req("GET"), flagParams())).status).toBe(200);
  });
});

describe("where the org requires single sign-on, a member's key works only if made through it", () => {
  // Its own GOV org (the tenant class that can require it) and IdP connection.
  const ISSUER = `https://idp-mk-${stamp}.example.com`;
  const claims = (subject: string): SsoClaims =>
    ({ subject, email: null, emailVerified: false, groups: [], acr: null, amr: [], issuer: ISSUER }) as SsoClaims;

  it("refuses a member's earlier key, admits one made from an SSO session, keeps an admin's, and restores all when it is turned off", async () => {
    const gov = await prisma.organization.create({ data: { name: `mk sso ${stamp}`, slug: `mk-sso-${stamp}` }, select: { id: true, slug: true, tenantClass: true } });
    expect(gov.tenantClass).toBe("GOV");
    orgIds.push(gov.id);
    const admin = await person("sadmin", "ADMIN", { org: gov.id });
    const member = await person("smember", "MEMBER", { org: gov.id });
    const earlier = await fixtureKeyRow(member, ["read"], { org: gov.id });
    const adminKey = await fixtureKeyRow(admin, ["read"], { org: gov.id });
    const govParams = () => ({ params: Promise.resolve({ orgId: gov.id }) });
    const status = async (token: string) => {
      asKey(token);
      return (await listProjects(req("GET"), govParams())).status;
    };
    // Positive control: before the requirement, both keys work.
    expect(await status(earlier.token)).toBe(200);
    expect(await status(adminKey.token)).toBe(200);

    const conn = await prisma.idpConnection.create({
      data: { orgId: gov.id, issuerUrl: ISSUER, clientId: "c", clientSecretEnc: "not-opened-by-these-tests", enabled: true, enforced: true },
    });
    await prisma.federatedIdentity.create({ data: { userId: member.userId, idpConnId: conn.id, subject: `s-${stamp}`, issuer: ISSUER } });
    // The admin looks at the key list through the org's IdP too: now nothing else opens it.
    const adminSso = { ...admin, session: randomBytes(24).toString("hex") };
    await prisma.session.create({
      data: { id: adminSso.session, userId: admin.userId, expiresAt: new Date(Date.now() + DAY), authMethod: "oidc", idpConnId: conn.id },
    });

    // The member's own (non-SSO) session is refused here, and now so is the key it made.
    asSession(member);
    expect((await listProjects(req("GET"), govParams())).status).toBe(401);
    expect(await status(earlier.token)).toBe(401);
    // Refused, not deleted.
    expect(await keyExists(earlier.id)).toBe(true);
    // An admin's key keeps working, as every key did before this rule.
    expect(await status(adminKey.token)).toBe(200);

    // Signed in through the org's IdP, the member mints a key that works.
    const login = await completeSsoLogin(gov.slug, conn, claims(`s-${stamp}`), {});
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    h.headers = new Headers({ cookie: `session=${login.sessionId}` });
    const minted = await mintKey(req("POST", { name: "via sso", scopes: ["read"], expiresAt: inDays(30) }), govParams());
    expect(minted.status).toBe(201);
    const viaSso = (await minted.json()) as Minted;
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: viaSso.id } })).idpConnId).toBe(conn.id);
    expect(await status(viaSso.token)).toBe(200);

    // The list says which work and why the earlier one doesn't.
    expect(await standingIn(adminSso, gov.id)).toMatchObject({ [earlier.id]: "sso", [viaSso.id]: null, [adminKey.id]: null });

    // Turned off, the earlier key works again: it is the rule, not a deletion.
    await prisma.idpConnection.update({ where: { id: conn.id }, data: { enforced: false } });
    expect(await status(earlier.token)).toBe(200);
    expect(await status(viaSso.token)).toBe(200);
    expect((await standingIn(adminSso, gov.id))[earlier.id]).toBeNull();
  });

  it("re-admitting a removed member through SSO deletes the keys they made before the removal", async () => {
    const org = await prisma.organization.create({ data: { name: `mk ssor ${stamp}`, slug: `mk-ssor-${stamp}` }, select: { id: true, slug: true } });
    orgIds.push(org.id);
    const conn = await prisma.idpConnection.create({
      data: { orgId: org.id, issuerUrl: ISSUER, clientId: "c", clientSecretEnc: "not-opened-by-these-tests", enabled: true },
    });
    const gone = await person("ssogone", "MEMBER", { org: org.id });
    const stays = await person("ssostays", "MEMBER", { org: org.id });
    for (const [p, sub] of [[gone, `g-${stamp}`], [stays, `t-${stamp}`]] as const) {
      await prisma.federatedIdentity.create({ data: { userId: p.userId, idpConnId: conn.id, subject: sub, issuer: ISSUER } });
    }
    const goneKey = await fixtureKeyRow(gone, ["read"], { org: org.id });
    const staysKey = await fixtureKeyRow(stays, ["read"], { org: org.id });
    // Removed the way it was done before removal deleted keys: the row hidden, the keys left.
    await prismaUnfiltered.orgMember.update({ where: { id: gone.memberId }, data: { removedAt: new Date() } });

    expect((await completeSsoLogin(org.slug, conn, claims(`g-${stamp}`), {})).ok).toBe(true);
    expect(await prisma.orgMember.findUnique({ where: { id: gone.memberId }, select: { id: true } })).not.toBeNull(); // reinstated
    expect(await keyExists(goneKey.id)).toBe(false);
    const audit = await prisma.auditLog.findFirst({ where: { orgId: org.id, action: "member.api_keys_revoked", entityId: gone.memberId } });
    expect(audit?.metadata).toMatchObject({ reason: "reinstated", revokedCount: 1 });

    // Control: an SSO sign-in by someone never removed deletes nothing.
    expect((await completeSsoLogin(org.slug, conn, claims(`t-${stamp}`), {})).ok).toBe(true);
    expect(await keyExists(staysKey.id)).toBe(true);
  });
});

describe("the IP allowlist holds a member's key exactly as it holds an admin's", () => {
  // Its own org, so the allowlist touches no other case here.
  it("from outside the allowlist both keys get 401; from inside, both get 200", async () => {
    const fenced = (await prisma.organization.create({ data: { name: `mk ip ${stamp}`, slug: `mk-ip-${stamp}` } })).id;
    orgIds.push(fenced);
    const keys = {
      admin: await fixtureKeyRow(await person("ipadmin", "ADMIN", { org: fenced }), ["read"], { org: fenced }),
      member: await fixtureKeyRow(await person("ipmember", "MEMBER", { org: fenced }), ["read"], { org: fenced }),
    };
    await prisma.orgSecuritySettings.create({ data: { orgId: fenced, ipAllowlistEnabled: true } });
    await prisma.ipAllowlist.create({ data: { orgId: fenced, cidr: "10.20.0.0/16" } });
    const fencedParams = () => ({ params: Promise.resolve({ orgId: fenced }) });
    // Every client-address header says the same thing, so the case holds
    // whichever of them the server trusts.
    const from = (token: string, ip: string) => {
      h.headers = new Headers({ authorization: `Bearer ${token}`, "cf-connecting-ip": ip, "x-real-ip": ip, "x-forwarded-for": ip });
    };
    const seen: Record<string, number> = {};
    for (const who of ["admin", "member"] as const) {
      from(keys[who].token, "10.20.3.4");
      seen[`${who} inside`] = (await listProjects(req("GET"), fencedParams())).status;
      from(keys[who].token, "203.0.113.9");
      seen[`${who} outside`] = (await listProjects(req("GET"), fencedParams())).status;
    }
    expect(seen).toEqual({ "admin inside": 200, "admin outside": 401, "member inside": 200, "member outside": 401 });
  });
});
