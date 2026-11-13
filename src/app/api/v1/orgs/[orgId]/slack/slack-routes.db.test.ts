// @vitest-environment node
//
// Connecting Slack and linking members, through the real routes against a
// real database and a stand-in Slack (src/lib/testing/fake-slack.ts). The
// install is OAuth v2 with a sealed state cookie (the CSRF check); the bot
// token is sealed at rest and never returned; disconnect revokes it at Slack.
// Members are linked only on an email Slack says they confirmed, and one
// Slack user shared by two members waits for an admin.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { scopeMask } from "@/lib/auth/api-key";
import { fakeSlack } from "@/lib/testing/fake-slack";

process.env.SSO_VAULT_KEY = Buffer.alloc(32, 5).toString("base64");
delete process.env.SSO_VAULT_KEYS;
delete process.env.SSO_VAULT_ACTIVE_KID;
delete process.env.COSMOS_PUBLIC_URL;
delete process.env.SLACK_API_ORIGIN;

const h = vi.hoisted(() => ({ ctx: null as unknown, user: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => h.user }));

const setup = await import("./route");
const install = await import("./install/route");
const links = await import("./links/route");
const link = await import("./links/[linkId]/route");
const me = await import("./me/route");
const callback = await import("@/app/api/v1/slack/oauth/callback/route");
const { getOrgCredential } = await import("@/lib/integrations/credentials");
const { setNotifyTypes } = await import("@/lib/integrations/slack/links.server");
const { _resetUsedInstallStates, exchangeInstallCode } = await import("@/lib/integrations/slack/oauth.server");
const { completeSlackInstall } = await import("@/lib/integrations/slack/install.server");

const CALLBACK = "http://localhost/api/v1/slack/oauth/callback";
const orgIds: string[] = [];
const userIds: string[] = [];
let fake = fakeSlack();

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});
beforeEach(() => {
  fake = fakeSlack();
  vi.stubGlobal("fetch", fake.fetch);
  process.env.SLACK_CLIENT_ID = fake.state.clientId;
  process.env.SLACK_CLIENT_SECRET = fake.state.clientSecret;
  _resetUsedInstallStates();
});
afterEach(() => vi.unstubAllGlobals());

async function org(members: { name: string; role?: string; email?: string }[]) {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const o = await prisma.organization.create({ data: { name: `sr ${stamp}`, slug: `sr-${stamp}` } });
  orgIds.push(o.id);
  const people: Record<string, { id: string; email: string }> = {};
  for (const m of members) {
    const u = await prisma.user.create({ data: { email: m.email ?? `${m.name}-${stamp}@sr.test`, displayName: m.name } });
    userIds.push(u.id);
    await prisma.orgMember.create({ data: { orgId: o.id, userId: u.id, role: (m.role ?? "MEMBER") as "MEMBER", permissions: "0" } });
    people[m.name] = { id: u.id, email: u.email };
  }
  return { org: o, people, stamp };
}

/** Act as `userId`, with exactly the permissions their membership gives them. */
async function as(orgId: string, userId: string) {
  h.ctx = await loadMemberAuthContext(orgId, userId);
  h.user = { id: userId };
}
const asKey = (orgId: string, userId: string) => {
  const scopes = ["integrations:manage", "members:read", "org:read"];
  h.ctx = { userId, orgId, orgRole: "OWNER", permissions: scopeMask(scopes), basePermissions: scopeMask(scopes), abacRules: [], isApiKey: true, scopes } satisfies AuthContext;
};

const p = <T extends Record<string, string>>(orgId: string, extra: T = {} as T) => ({ params: Promise.resolve({ orgId, ...extra }) });
const req = (method: string, body?: unknown, url = "http://localhost/x") =>
  new NextRequest(url, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) });

/** "Add to Slack": the redirect to Slack, its state, and the sealed cookie. */
async function start(orgId: string) {
  const res = await install.GET(req("GET"), p(orgId));
  const location = new URL(res.headers.get("location")!);
  return { res, location, state: location.searchParams.get("state")!, cookie: res.cookies.get("slack_oauth_state")! };
}
const back = (q: string, cookie?: string) =>
  callback.GET(new NextRequest(`${CALLBACK}?${q}`, { headers: cookie ? { cookie: `slack_oauth_state=${cookie}` } : {} }));

/** Connect the org through the real flow, as `adminId`. */
async function connect(orgId: string, adminId: string) {
  await as(orgId, adminId);
  const s = await start(orgId);
  const res = await back(`code=${fake.issueCode(CALLBACK)}&state=${s.state}`, s.cookie.value);
  expect(res.headers.get("location")).toMatch(/\?slack=connected$/);
}

const stored = (orgId: string) => prisma.connectorCredential.findMany({ where: { orgId, provider: "slack-notifications" } });

describe("Add to Slack (e2e DB)", () => {
  it("starts only for an admin: to Slack's authorize page with exactly four scopes, this instance's callback, and a sealed httpOnly state", async () => {
    const { org: o, people } = await org([{ name: "admin", role: "ADMIN" }, { name: "dana" }]);
    await as(o.id, people.dana.id);
    expect((await install.GET(req("GET"), p(o.id))).status).toBe(403);
    asKey(o.id, people.admin.id);
    expect((await install.GET(req("GET"), p(o.id))).status).toBe(403);

    await as(o.id, people.admin.id);
    const s = await start(o.id);
    expect(s.res.status).toBe(307);
    expect(`${s.location.origin}${s.location.pathname}`).toBe("https://slack.com/oauth/v2/authorize");
    expect(Object.fromEntries(s.location.searchParams)).toEqual({
      client_id: fake.state.clientId, scope: "chat:write,im:write,users:read,users:read.email", redirect_uri: CALLBACK, state: s.state,
    });
    expect(s.cookie).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/api/v1/slack/oauth/callback", maxAge: 600 });
    // Sealed: neither the state nor whose install it is can be read off it.
    expect(s.cookie.value).not.toContain(s.state);
    expect(s.cookie.value).not.toContain(o.id);

    delete process.env.SLACK_CLIENT_SECRET;
    expect((await install.GET(req("GET"), p(o.id))).headers.get("location")).toBe(`http://localhost/${o.slug}/settings/integrations?slack=not_configured`);
  });

  it("the callback refuses a mismatched state, a missing cookie, another person's install, and a denial, and keeps no token", async () => {
    const { org: o, people } = await org([{ name: "admin", role: "ADMIN" }, { name: "boss", role: "ADMIN" }]);
    await as(o.id, people.admin.id);
    const s = await start(o.id);
    const code = fake.issueCode(CALLBACK);
    expect((await back(`code=${code}&state=not-it`, s.cookie.value)).headers.get("location")).toBe("http://localhost/");
    expect((await back(`code=${code}&state=${s.state}`)).headers.get("location")).toBe("http://localhost/");
    const forged = s.cookie.value.slice(0, -4) + (s.cookie.value.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect((await back(`code=${code}&state=${s.state}`, forged)).headers.get("location")).toBe("http://localhost/");
    await as(o.id, people.boss.id); // another admin, holding this admin's link
    expect((await back(`code=${code}&state=${s.state}`, s.cookie.value)).headers.get("location")).toBe("http://localhost/");

    await as(o.id, people.admin.id);
    const d = await start(o.id);
    expect((await back(`error=access_denied&state=${d.state}`, d.cookie.value)).headers.get("location")).toMatch(/\?slack=denied$/);

    expect(fake.callsOf("oauth.v2.access")).toHaveLength(0);
    expect(await stored(o.id)).toEqual([]);
    expect(await prisma.slackInstallation.count({ where: { orgId: o.id } })).toBe(0);
  });

  it("a good callback seals the bot token and records the install; replaying it is refused; nothing ever returns the token", async () => {
    const { org: o, people } = await org([{ name: "admin", role: "ADMIN" }, { name: "dana" }]);
    await as(o.id, people.admin.id);
    const s = await start(o.id);
    const res = await back(`code=${fake.issueCode(CALLBACK)}&state=${s.state}`, s.cookie.value);
    expect(res.headers.get("location")).toBe(`http://localhost/${o.slug}/settings/integrations?slack=connected`);
    expect(res.cookies.get("slack_oauth_state")?.value).toBe("");

    const token = fake.state.issued[0];
    const rows = await stored(o.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBeNull();
    expect(rows[0].secretEnc.startsWith("v2.")).toBe(true);
    expect(rows[0].secretEnc).not.toContain(token);
    expect(JSON.stringify(rows[0].meta)).not.toContain(token);
    expect(await getOrgCredential(o.id, "slack-notifications")).toEqual({ botToken: token });
    expect(await prisma.slackInstallation.findUniqueOrThrow({ where: { orgId: o.id } })).toMatchObject({
      teamId: fake.state.team.id, teamName: "Fake workspace", installedById: people.admin.id, status: "ACTIVE", publicOrigin: "http://localhost",
    });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { orgId: o.id, action: "slack.connected" } });
    expect(JSON.stringify(audit.metadata)).not.toContain(token);

    // The same state again (even with a fresh code) is refused, and Slack isn't asked.
    expect((await back(`code=${fake.issueCode(CALLBACK)}&state=${s.state}`, s.cookie.value)).headers.get("location")).toBe("http://localhost/");
    expect(fake.callsOf("oauth.v2.access")).toHaveLength(1);

    const view = await setup.GET(req("GET"), p(o.id));
    const text = await view.text();
    expect(view.status).toBe(200);
    expect(text).not.toContain("xoxb-");
    expect(JSON.parse(text)).toMatchObject({
      appConfigured: true, redirectUri: CALLBACK, installation: { teamName: "Fake workspace", status: "ACTIVE", installedBy: "admin" },
    });
    await as(o.id, people.dana.id);
    expect((await setup.GET(req("GET"), p(o.id))).status).toBe(403);
  });

  it("the callback re-checks the admin: someone who lost the right in between gets 'forbidden' and no token", async () => {
    const { org: o, people } = await org([{ name: "admin", role: "ADMIN" }]);
    await as(o.id, people.admin.id);
    const s = await start(o.id);
    await prisma.orgMember.updateMany({ where: { orgId: o.id, userId: people.admin.id }, data: { role: "MEMBER" } });
    await as(o.id, people.admin.id); // the callback request's own sign-in, as it stands now
    expect((await back(`code=${fake.issueCode(CALLBACK)}&state=${s.state}`, s.cookie.value)).headers.get("location")).toMatch(/\?slack=forbidden$/);
    expect(await stored(o.id)).toEqual([]);
  });

  it("refuses a grant missing a scope, or an organization-wide install", async () => {
    const { org: o, people } = await org([{ name: "admin", role: "ADMIN" }]);
    await as(o.id, people.admin.id);
    fake.state.scopes = ["chat:write", "users:read"];
    let s = await start(o.id);
    expect((await back(`code=${fake.issueCode(CALLBACK)}&state=${s.state}`, s.cookie.value)).headers.get("location")).toMatch(/\?slack=missing_scopes$/);
    fake.state.scopes = ["chat:write", "im:write", "users:read", "users:read.email"];
    fake.state.enterprise = true;
    s = await start(o.id);
    expect((await back(`code=${fake.issueCode(CALLBACK)}&state=${s.state}`, s.cookie.value)).headers.get("location")).toMatch(/\?slack=enterprise_install$/);
    expect(await stored(o.id)).toEqual([]);
  });

  it("disconnect revokes the token at Slack and deletes it, the install and waiting messages; members' opt-outs and unlinks stay", async () => {
    const { org: o, people } = await org([{ name: "admin", role: "ADMIN" }, { name: "dana" }, { name: "eli" }, { name: "finn" }]);
    for (const n of ["dana", "eli", "finn"]) fake.state.users.push({ id: `U${n.toUpperCase()}`, email: people[n].email });
    await connect(o.id, people.admin.id);
    expect(await (await links.POST(req("POST"), p(o.id))).json()).toMatchObject({ linked: 4 - 1, review: 0 });
    await setNotifyTypes(o.id, people.eli.id, []);
    await as(o.id, people.finn.id);
    await me.DELETE(req("DELETE"), p(o.id));
    await prisma.slackOutbox.create({ data: { orgId: o.id, userId: people.dana.id, kind: "notification", payload: {} } });

    await as(o.id, people.dana.id);
    expect((await setup.DELETE(req("DELETE"), p(o.id))).status).toBe(403);
    await as(o.id, people.admin.id);
    const res = await setup.DELETE(req("DELETE"), p(o.id));
    expect(await res.json()).toEqual({ disconnected: true, revoked: true, revokeError: null });
    const token = fake.state.issued[0];
    expect(fake.callsOf("auth.revoke").map((c) => c.token)).toEqual([token]);
    expect(fake.state.revoked.has(token)).toBe(true);
    expect(await stored(o.id)).toEqual([]);
    expect(await prisma.slackInstallation.count({ where: { orgId: o.id } })).toBe(0);
    expect(await prisma.slackOutbox.count({ where: { orgId: o.id } })).toBe(0);
    const after = await prisma.slackUserLink.findMany({ where: { orgId: o.id }, select: { userId: true, status: true, slackUserId: true, notifyTypes: true } });
    const of = (n: string) => after.find((l) => l.userId === people[n].id);
    expect(of("dana")).toMatchObject({ status: "NO_MATCH", slackUserId: null });
    expect(of("eli")).toMatchObject({ slackUserId: null, notifyTypes: [] });
    expect(of("finn")).toMatchObject({ status: "UNLINKED", slackUserId: null });
  });

  it("disconnect still deletes everything when Slack can't be reached to revoke, and says so", async () => {
    const { org: o, people } = await org([{ name: "admin", role: "ADMIN" }]);
    await connect(o.id, people.admin.id);
    fake.state.fail["auth.revoke"] = [{ status: 503 }];
    const res = await setup.DELETE(req("DELETE"), p(o.id));
    expect(await res.json()).toEqual({ disconnected: true, revoked: false, revokeError: "http_503" });
    expect(await stored(o.id)).toEqual([]);
    expect(await prisma.slackInstallation.count({ where: { orgId: o.id } })).toBe(0);
  });
});

describe("Add to Slack: one workspace, one org (e2e DB)", () => {
  it("refuses a workspace another org already connected, and leaves that org's install alone; the database holds the rule too", async () => {
    const a = await org([{ name: "admin", role: "ADMIN" }]);
    const b = await org([{ name: "admin", role: "ADMIN" }]);
    await connect(a.org.id, a.people.admin.id);
    const before = await prisma.slackInstallation.findUniqueOrThrow({ where: { orgId: a.org.id } });
    const tokenA = fake.state.issued[0];

    await as(b.org.id, b.people.admin.id);
    const s = await start(b.org.id);
    const res = await back(`code=${fake.issueCode(CALLBACK)}&state=${s.state}`, s.cookie.value);
    expect(res.headers.get("location")).toBe(`http://localhost/${b.org.slug}/settings/integrations?slack=workspace_taken`);
    expect(await stored(b.org.id)).toEqual([]);
    expect(await prisma.slackInstallation.count({ where: { orgId: b.org.id } })).toBe(0);
    // The other org is untouched: same install, same token, and nothing revoked at Slack.
    expect(await prisma.slackInstallation.findUniqueOrThrow({ where: { orgId: a.org.id } })).toEqual(before);
    expect(await getOrgCredential(a.org.id, "slack-notifications")).toEqual({ botToken: tokenA });
    expect(fake.callsOf("auth.revoke")).toHaveLength(0);

    // Two installs racing past that check still can't both land.
    await expect(
      prisma.slackInstallation.create({ data: { orgId: b.org.id, teamId: before.teamId, installedById: b.people.admin.id, publicOrigin: "http://localhost" } }),
    ).rejects.toMatchObject({ code: "P2002" });
    // And the loser of such a race is refused the same way, with no token kept.
    const missed = vi.spyOn(prisma.slackInstallation, "findFirst").mockResolvedValueOnce(null);
    await expect(
      completeSlackInstall(
        { clientId: fake.state.clientId, clientSecret: fake.state.clientSecret },
        { orgId: b.org.id, userId: b.people.admin.id, code: fake.issueCode(), redirectUri: CALLBACK, publicOrigin: "http://localhost" },
      ),
    ).rejects.toMatchObject({ code: "workspace_taken" });
    expect(missed).toHaveBeenCalled();
    missed.mockRestore();
    expect(await stored(b.org.id)).toEqual([]);
    expect(await prisma.slackInstallation.findUniqueOrThrow({ where: { orgId: a.org.id } })).toEqual(before);
  });

  it("reconnecting to a different workspace revokes the old workspace's token; reconnecting to the same one doesn't", async () => {
    const { org: o, people } = await org([{ name: "admin", role: "ADMIN" }]);
    await connect(o.id, people.admin.id);
    // Same workspace: Slack hands back the token already in use, so revoking it would cut off the new install.
    await connect(o.id, people.admin.id);
    expect(fake.callsOf("auth.revoke")).toHaveLength(0);
    const old = fake.state.issued[1];

    fake.state.team = { id: `TNEW${Math.random().toString(36).slice(2, 8).toUpperCase()}`, name: "New workspace" };
    await connect(o.id, people.admin.id);
    expect(fake.callsOf("auth.revoke").map((c) => c.token)).toEqual([old]);
    expect(fake.state.revoked.has(old)).toBe(true);
    expect(await getOrgCredential(o.id, "slack-notifications")).toEqual({ botToken: fake.state.issued[2] });
    expect(await prisma.slackInstallation.findUniqueOrThrow({ where: { orgId: o.id } })).toMatchObject({ teamId: fake.state.team.id, status: "ACTIVE" });

    // Best effort: Slack failing to revoke the old one doesn't stop the new install.
    fake.state.team = { id: `TNEW${Math.random().toString(36).slice(2, 8).toUpperCase()}`, name: "Third workspace" };
    fake.state.fail["auth.revoke"] = [{ status: 503 }];
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await connect(o.id, people.admin.id);
    expect(await getOrgCredential(o.id, "slack-notifications")).toEqual({ botToken: fake.state.issued[3] });
    expect(warned.mock.calls.flat().join(" ")).toContain("http_503");
    warned.mockRestore();
  });

  it("the callback holds the org's own sign-in rules: a session the org refuses (MFA, idle timeout, IP allowlist) or an API key installs nothing", async () => {
    const { org: o, people } = await org([{ name: "admin", role: "ADMIN" }]);
    await as(o.id, people.admin.id);
    let s = await start(o.id);
    // Still signed in, but not in a way this org accepts: getAuthContext says no.
    h.ctx = null;
    let res = await back(`code=${fake.issueCode(CALLBACK)}&state=${s.state}`, s.cookie.value);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");

    await as(o.id, people.admin.id);
    s = await start(o.id);
    asKey(o.id, people.admin.id);
    res = await back(`code=${fake.issueCode(CALLBACK)}&state=${s.state}`, s.cookie.value);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");

    expect(fake.callsOf("oauth.v2.access")).toHaveLength(0);
    expect(await stored(o.id)).toEqual([]);
  });

  it("refuses a grant with more scopes than the app manifest asks for, and names them", async () => {
    const { org: o, people } = await org([{ name: "admin", role: "ADMIN" }]);
    await as(o.id, people.admin.id);
    fake.state.scopes = ["chat:write", "im:write", "users:read", "users:read.email", "channels:history", "files:read"];
    const s = await start(o.id);
    expect((await back(`code=${fake.issueCode(CALLBACK)}&state=${s.state}`, s.cookie.value)).headers.get("location")).toMatch(/\?slack=extra_scopes$/);
    expect(await stored(o.id)).toEqual([]);
    await expect(
      exchangeInstallCode({ clientId: fake.state.clientId, clientSecret: fake.state.clientSecret }, { code: fake.issueCode(), redirectUri: CALLBACK }),
    ).rejects.toMatchObject({ code: "extra_scopes", message: expect.stringMatching(/channels:history, files:read/) });
  });
});

describe("Linking members (e2e DB)", () => {
  it("matches only members whose Slack email is confirmed, in this workspace, and never someone who unlinked", async () => {
    const { org: o, people } = await org([{ name: "admin", role: "ADMIN" }, { name: "dana" }, { name: "eli" }, { name: "gus" }, { name: "hal" }]);
    fake.state.users.push(
      { id: "UDANA", email: people.dana.email },
      { id: "UELI", email: people.eli.email, confirmed: false },
      { id: "UGUS", email: people.gus.email, teamId: "TOTHER" },
      { id: "UHAL", email: people.hal.email },
    );
    await connect(o.id, people.admin.id);
    await as(o.id, people.hal.id);
    await me.DELETE(req("DELETE"), p(o.id));

    await as(o.id, people.dana.id);
    expect((await links.POST(req("POST"), p(o.id))).status).toBe(403);
    await as(o.id, people.admin.id);
    expect(await (await links.POST(req("POST"), p(o.id))).json()).toEqual({ linked: 1, review: 0, notFound: 3, remaining: 0 });
    const rows = await prisma.slackUserLink.findMany({ where: { orgId: o.id }, select: { userId: true, status: true, slackUserId: true } });
    const of = (n: string) => rows.find((r) => r.userId === people[n].id);
    expect(of("dana")).toMatchObject({ status: "LINKED", slackUserId: "UDANA" });
    expect(of("eli")).toMatchObject({ status: "NO_MATCH", slackUserId: null });
    expect(of("gus")).toMatchObject({ status: "NO_MATCH", slackUserId: null });
    expect(of("hal")).toMatchObject({ status: "UNLINKED", slackUserId: null });
    expect(fake.callsOf("users.lookupByEmail").map((c) => c.params.email)).not.toContain(people.hal.email);
  });

  it("a second member on the same Slack user waits for an admin, who can allow or remove it", async () => {
    const shared = `shared-${Math.random().toString(36).slice(2, 8)}@sr.test`;
    const { org: o, people } = await org([{ name: "admin", role: "ADMIN" }, { name: "one", email: shared }, { name: "two", email: shared }]);
    fake.state.users.push({ id: "USHARED", email: shared });
    await connect(o.id, people.admin.id);
    expect(await (await links.POST(req("POST"), p(o.id))).json()).toMatchObject({ linked: 1, review: 1 });

    const view = await (await setup.GET(req("GET"), p(o.id))).json();
    expect(view.links[0]).toMatchObject({ status: "NEEDS_REVIEW", slackUserId: "USHARED", approved: false });
    expect(view.links.filter((l: { slackUserId: string }) => l.slackUserId === "USHARED")).toHaveLength(2);

    // The database holds the rule too: two unapproved links to one Slack user can't both stand.
    await expect(
      prisma.slackUserLink.update({ where: { id: view.links[0].id }, data: { status: "LINKED" } }),
    ).rejects.toMatchObject({ code: "P2002" });

    await as(o.id, people.two.id);
    expect((await link.PATCH(req("PATCH", { action: "approve" }), p(o.id, { linkId: view.links[0].id }))).status).toBe(403);
    await as(o.id, people.admin.id);
    expect((await link.PATCH(req("PATCH", { action: "approve" }), p(o.id, { linkId: view.links[0].id }))).status).toBe(200);
    expect(await prisma.slackUserLink.findUniqueOrThrow({ where: { id: view.links[0].id } })).toMatchObject({ status: "LINKED", approvedById: people.admin.id });
    expect((await link.PATCH(req("PATCH", { action: "approve" }), p(o.id, { linkId: view.links[0].id }))).status).toBe(409);
    expect((await link.PATCH(req("PATCH", { action: "unlink" }), p(o.id, { linkId: view.links[0].id }))).status).toBe(200);
    expect(await prisma.slackUserLink.findUniqueOrThrow({ where: { id: view.links[0].id } })).toMatchObject({ status: "UNLINKED", slackUserId: null });
  });

  it("a link id from another org is not found", async () => {
    const a = await org([{ name: "admin", role: "ADMIN" }, { name: "dana" }]);
    const b = await org([{ name: "admin", role: "ADMIN" }]);
    fake.state.users.push({ id: "UDANA", email: a.people.dana.email });
    await connect(a.org.id, a.people.admin.id);
    await links.POST(req("POST"), p(a.org.id));
    const row = await prisma.slackUserLink.findFirstOrThrow({ where: { orgId: a.org.id, userId: a.people.dana.id } });
    expect(row.status).toBe("LINKED");
    await as(b.org.id, b.people.admin.id);
    expect((await link.PATCH(req("PATCH", { action: "unlink" }), p(b.org.id, { linkId: row.id }))).status).toBe(404);
    expect(await prisma.slackUserLink.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "LINKED" });
  });

  it("a member sees only their own link, picks what comes to Slack, unlinks, and links again", async () => {
    const { org: o, people } = await org([{ name: "admin", role: "ADMIN" }, { name: "dana" }, { name: "eli" }]);
    fake.state.users.push({ id: "UDANA", email: people.dana.email }, { id: "UELI", email: people.eli.email, confirmed: false });

    await as(o.id, people.dana.id);
    expect(await (await me.GET(req("GET"), p(o.id))).json()).toEqual({ available: false, workspace: null, status: null, reason: null, notifyTypes: ["assigned", "mentioned"] });
    expect((await me.POST(req("POST"), p(o.id))).status).toBe(409);

    await connect(o.id, people.admin.id);
    await as(o.id, people.dana.id);
    expect(await (await me.POST(req("POST"), p(o.id))).json()).toMatchObject({ available: true, workspace: "Fake workspace", status: "LINKED" });
    expect(await (await me.PUT(req("PUT", { notifyTypes: [] }), p(o.id))).json()).toMatchObject({ status: "LINKED", notifyTypes: [] });
    expect((await me.PUT(req("PUT", { notifyTypes: ["everything"] }), p(o.id))).status).toBe(400);
    expect(await (await me.PUT(req("PUT", { notifyTypes: ["mentioned"] }), p(o.id))).json()).toMatchObject({ notifyTypes: ["mentioned"] });
    expect(await (await me.DELETE(req("DELETE"), p(o.id))).json()).toMatchObject({ status: "UNLINKED", reason: "unlinked", notifyTypes: ["mentioned"] });
    expect(await (await me.POST(req("POST"), p(o.id))).json()).toMatchObject({ status: "LINKED", reason: null });

    await as(o.id, people.eli.id);
    expect(await (await me.POST(req("POST"), p(o.id))).json()).toMatchObject({ status: "NO_MATCH", reason: "unconfirmed" });
    // Only their own row moved.
    expect(await prisma.slackUserLink.findUniqueOrThrow({ where: { orgId_userId: { orgId: o.id, userId: people.dana.id } } })).toMatchObject({ status: "LINKED" });

    asKey(o.id, people.dana.id);
    expect((await me.GET(req("GET"), p(o.id))).status).toBe(403);
    // A role without notifications (a guest) has no Slack choices either.
    await prisma.orgMember.updateMany({ where: { orgId: o.id, userId: people.eli.id }, data: { role: "GUEST" } });
    await as(o.id, people.eli.id);
    for (const r of [me.GET(req("GET"), p(o.id)), me.PUT(req("PUT", { notifyTypes: [] }), p(o.id)), me.POST(req("POST"), p(o.id)), me.DELETE(req("DELETE"), p(o.id))]) {
      expect((await r).status).toBe(403);
    }
  });

  it("an admin can't allow their own link; another admin can", async () => {
    const shared = `own-${Math.random().toString(36).slice(2, 8)}@sr.test`;
    const { org: o, people } = await org([{ name: "admin", role: "ADMIN", email: shared }, { name: "boss", role: "ADMIN" }, { name: "twin", email: shared }]);
    await connect(o.id, people.boss.id);
    const team = fake.state.team.id;
    await prisma.slackUserLink.create({ data: { orgId: o.id, userId: people.twin.id, status: "LINKED", slackTeamId: team, slackUserId: "USHARED", linkedAt: new Date() } });
    const mine = await prisma.slackUserLink.create({ data: { orgId: o.id, userId: people.admin.id, status: "NEEDS_REVIEW", slackTeamId: team, slackUserId: "USHARED" } });

    await as(o.id, people.admin.id);
    expect((await link.PATCH(req("PATCH", { action: "approve" }), p(o.id, { linkId: mine.id }))).status).toBe(403);
    expect(await prisma.slackUserLink.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ status: "NEEDS_REVIEW", approvedById: null });
    await as(o.id, people.boss.id);
    expect((await link.PATCH(req("PATCH", { action: "approve" }), p(o.id, { linkId: mine.id }))).status).toBe(200);
    expect(await prisma.slackUserLink.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ status: "LINKED", approvedById: people.boss.id });
  });

  it("links only when the Slack profile's email is the member's own, not another address Slack resolved it to", async () => {
    const { org: o, people, stamp } = await org([{ name: "admin", role: "ADMIN" }, { name: "dana" }, { name: "eli" }]);
    fake.state.users.push(
      // Slack's lookup found dana's address, but on someone else's profile.
      { id: "UOTHER", email: people.dana.email, profileEmail: `someone-else-${stamp}@sr.test` },
      { id: "UELI", email: people.eli.email },
    );
    await connect(o.id, people.admin.id);
    expect(await (await links.POST(req("POST"), p(o.id))).json()).toMatchObject({ linked: 1 });
    const rows = await prisma.slackUserLink.findMany({ where: { orgId: o.id }, select: { userId: true, status: true, slackUserId: true } });
    expect(rows.find((r) => r.userId === people.dana.id)).toMatchObject({ status: "NO_MATCH", slackUserId: null });
    expect(rows.find((r) => r.userId === people.eli.id)).toMatchObject({ status: "LINKED", slackUserId: "UELI" });
  });
});
