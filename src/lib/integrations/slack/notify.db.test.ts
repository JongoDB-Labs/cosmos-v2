// @vitest-environment node
//
// Slack notifications, end to end against a real database and a stand-in
// Slack (src/lib/testing/fake-slack.ts): the real assignment and comment
// routes queue, the real sender delivers. Each case has its positive control
// in the same org: the person who should get a message gets exactly one.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { fakeSlack } from "@/lib/testing/fake-slack";

process.env.SSO_VAULT_KEY = Buffer.alloc(32, 9).toString("base64");
delete process.env.SSO_VAULT_KEYS;
delete process.env.SSO_VAULT_ACTIVE_KID;
delete process.env.COSMOS_PUBLIC_URL;
delete process.env.SLACK_API_ORIGIN;

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

const { PATCH: patchItem } = await import("@/app/api/v1/orgs/[orgId]/work-items/[itemId]/route");
const { POST: comment } = await import("@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/comments/route");
const { completeSlackInstall } = await import("./install.server");
const { drainSlackOutbox } = await import("./notify.server");
const { setNotifyTypes, unlinkMember } = await import("./links.server");

const ORIGIN = "https://cosmos.example.com";
const APP = { clientId: "fake-client-id", clientSecret: "fake-client-secret" };
const orgIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

const json = (method: string, body: unknown) =>
  new NextRequest("http://localhost/x", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

/**
 * An org with Slack connected through the real install path, an owner who
 * acts, and members `names`; each member's Slack user is `U<NAME>` with a
 * confirmed email unless `slack` says otherwise.
 */
async function setup(
  names: string[],
  slack: Record<string, { confirmed?: boolean; absent?: boolean }> = {},
  opts: { fake?: ReturnType<typeof fakeSlack> } = {},
) {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const fake = opts.fake ?? fakeSlack();
  // Orgs sharing one fake each get their own workspace, and their people live in it.
  if (opts.fake) fake.state.team = { id: `T${stamp.toUpperCase()}`, name: `Workspace ${stamp}` };
  const teamId = fake.state.team.id;
  const mk = async (n: string) => {
    const u = await prisma.user.create({ data: { email: `${n}-${stamp}@slk.test`, displayName: n } });
    userIds.push(u.id);
    return u;
  };
  const owner = await mk("owner");
  const org = await prisma.organization.create({ data: { name: `slk ${stamp}`, slug: `slk-${stamp}` } });
  orgIds.push(org.id);
  await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: "OWNER", permissions: "0" } });
  const people: Record<string, { id: string; email: string; slackId: string }> = {};
  for (const n of names) {
    const u = await mk(n);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: u.id, role: "MEMBER", permissions: "0" } });
    people[n] = { id: u.id, email: u.email, slackId: `U${n.toUpperCase()}` };
    if (!slack[n]?.absent) fake.state.users.push({ id: `U${n.toUpperCase()}`, email: u.email, confirmed: slack[n]?.confirmed ?? true, teamId });
  }
  const newProject = async (prefix: string) => {
    const p = await prisma.project.create({ data: { orgId: org.id, name: prefix, key: `${prefix}${stamp.slice(-4).replace(/[^a-z]/gi, "Q").toUpperCase()}` } });
    await ensureFixtureStatuses(p.id);
    return p;
  };
  const project = await newProject("SK");
  const typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;

  await completeSlackInstall(APP, {
    orgId: org.id, userId: owner.id, code: fake.issueCode(), redirectUri: `${ORIGIN}/api/v1/slack/oauth/callback`, publicOrigin: ORIGIN,
  }, { fetch: fake.fetch });

  const asOwner = () => {
    h.ctx = { userId: owner.id, orgId: org.id, orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [] } satisfies AuthContext;
  };
  asOwner();
  const deps = { fetch: fake.fetch };
  return {
    org, project, people, fake, owner, newProject,
    item: (title = "Fix the login loop", projectId = project.id) =>
      createFixtureWorkItem({ orgId: org.id, projectId, workItemTypeId: typeId, createdById: owner.id, title, columnKey: "todo" }),
    assign: async (itemId: string, userId: string) => {
      asOwner();
      const res = await patchItem(json("PATCH", { assigneeId: userId }), { params: Promise.resolve({ orgId: org.id, itemId }) });
      expect(res.status).toBe(200);
      return res;
    },
    mention: async (itemId: string, ids: string[]) => {
      asOwner();
      const res = await comment(json("POST", { content: `${ids.map((i) => `<@${i}>`).join(" ")} please look` }), {
        params: Promise.resolve({ orgId: org.id, projectId: project.id, itemId }),
      });
      expect(res.status).toBe(201);
    },
    drain: (now?: Date) => drainSlackOutbox({ deps, orgId: org.id, ...(now ? { now: () => now } : {}) }),
    queued: () => prisma.slackOutbox.findMany({ where: { orgId: org.id } }),
  };
}

beforeEach(() => vi.restoreAllMocks());

describe("Slack notifications (e2e DB)", () => {
  it("an assignment sends exactly one direct message, to the assignee's Slack user, found by email the first time", async () => {
    const s = await setup(["dana", "eli"]);
    const item = await s.item();
    await s.assign(item.id, s.people.dana.id);
    expect(await s.drain()).toEqual({ sent: 1, skipped: 0, retried: 0, failed: 0 });

    expect(s.fake.state.posts).toHaveLength(1);
    const [post] = s.fake.postsTo("UDANA");
    expect(post.channel).toBe("DUDANA");
    const key = `${s.project.key}-${item.ticketNumber}`;
    const link = `${ORIGIN}/${s.org.slug}/work-items?item=${item.id}`;
    expect(post.text).toBe(`Assigned to you: ${key} Restricted`);
    expect(JSON.stringify(post.blocks)).toContain(`<${link}|${key}>`);
    // Never the description, never the actor's words.
    expect(JSON.stringify(post)).not.toContain("assigned you a work item");
    // The match was recorded, from Slack's confirmed email.
    expect(await prisma.slackUserLink.findUniqueOrThrow({ where: { orgId_userId: { orgId: s.org.id, userId: s.people.dana.id } } }))
      .toMatchObject({ status: "LINKED", slackUserId: "UDANA" });
    expect(await s.queued()).toEqual([]);
    // Sending is idempotent: nothing left to send.
    expect(await s.drain()).toEqual({ sent: 0, skipped: 0, retried: 0, failed: 0 });
  });

  it("an @mention sends exactly one direct message, to the member mentioned (the assignee's comment notice isn't a Slack kind)", async () => {
    const s = await setup(["dana", "eli"]);
    const item = await s.item();
    await prisma.workItem.update({ where: { id: item.id }, data: { assigneeId: s.people.dana.id } });
    await s.mention(item.id, [s.people.eli.id]);
    expect((await s.drain()).sent).toBe(1);
    expect(s.fake.state.posts).toHaveLength(1);
    expect(s.fake.postsTo("UELI")[0].text).toMatch(/^You were mentioned: /);
    // dana did get her in-app notice about the comment; it just isn't sent to Slack.
    expect(await prisma.notification.count({ where: { orgId: s.org.id, userId: s.people.dana.id, type: "comment.added" } })).toBe(1);
  });

  it("nothing of a kind a member switched off; the kind still on still comes", async () => {
    const s = await setup(["dana"]);
    await setNotifyTypes(s.org.id, s.people.dana.id, ["mentioned"]);
    const item = await s.item();
    await s.assign(item.id, s.people.dana.id);
    expect(await s.queued()).toEqual([]);
    await s.mention(item.id, [s.people.dana.id]);
    expect((await s.drain()).sent).toBe(1);
    expect(s.fake.state.posts.map((p) => p.text.split(":")[0])).toEqual(["You were mentioned"]);
  });

  it("nothing for a member who switched both off (opted out), even when a message was already waiting", async () => {
    const s = await setup(["dana", "eli"]);
    const item = await s.item();
    await s.mention(item.id, [s.people.dana.id, s.people.eli.id]);
    expect(await s.queued()).toHaveLength(2);
    await setNotifyTypes(s.org.id, s.people.dana.id, []);
    expect(await s.drain()).toEqual({ sent: 1, skipped: 1, retried: 0, failed: 0 });
    expect(s.fake.postsTo("UDANA")).toHaveLength(0);
    expect(s.fake.postsTo("UELI")).toHaveLength(1);
  });

  it("nothing for a member who unlinked; someone linked in the same comment gets theirs", async () => {
    const s = await setup(["dana", "eli"]);
    await unlinkMember(s.org.id, s.people.dana.id);
    const item = await s.item();
    await s.mention(item.id, [s.people.dana.id, s.people.eli.id]);
    await s.drain();
    expect(s.fake.postsTo("UDANA")).toHaveLength(0);
    expect(s.fake.postsTo("UELI")).toHaveLength(1);
    // And an unlink isn't undone by the sender's automatic matching.
    expect(s.fake.callsOf("users.lookupByEmail").map((c) => c.params.email)).toEqual([s.people.eli.email]);
  });

  it("nothing for a member Slack has no CONFIRMED email for; a confirmed one in the same comment gets theirs", async () => {
    const s = await setup(["dana", "eli", "finn"], { dana: { confirmed: false }, finn: { absent: true } });
    const item = await s.item();
    await s.mention(item.id, [s.people.dana.id, s.people.eli.id, s.people.finn.id]);
    expect(await s.drain()).toEqual({ sent: 1, skipped: 2, retried: 0, failed: 0 });
    expect(s.fake.state.posts.map((p) => p.user)).toEqual(["UELI"]);
    const links = await prisma.slackUserLink.findMany({ where: { orgId: s.org.id }, select: { userId: true, status: true, slackUserId: true } });
    expect(links.find((l) => l.userId === s.people.dana.id)).toMatchObject({ status: "NO_MATCH", slackUserId: null });
    expect(links.find((l) => l.userId === s.people.finn.id)).toMatchObject({ status: "NO_MATCH", slackUserId: null });
    // Not looked up again for a day: the next mention isn't even queued for them.
    await s.mention(item.id, [s.people.dana.id, s.people.finn.id]);
    expect(await s.queued()).toEqual([]);
  });

  it("re-checked when sent: nothing about an item the recipient can no longer see", async () => {
    const s = await setup(["dana"]);
    const seen = await s.item();
    const hidden = await s.item();
    await s.assign(seen.id, s.people.dana.id);
    await s.drain();
    expect(s.fake.postsTo("UDANA")).toHaveLength(1);

    await s.assign(hidden.id, s.people.dana.id);
    expect(await s.queued()).toHaveLength(1);
    // The project is restricted to its team (dana isn't on it) before the message goes.
    await prisma.project.update({ where: { id: s.project.id }, data: { teamScopedAccess: true } });
    expect(await s.drain()).toEqual({ sent: 0, skipped: 1, retried: 0, failed: 0 });
    expect(s.fake.postsTo("UDANA")).toHaveLength(1);
    expect(s.fake.callsOf("conversations.open")).toHaveLength(1);
  });

  it("nothing for someone whose role doesn't read notifications (a guest); a member in the same comment gets theirs", async () => {
    const s = await setup(["dana", "eli"]);
    await prisma.orgMember.updateMany({ where: { orgId: s.org.id, userId: s.people.dana.id }, data: { role: "GUEST" } });
    const item = await s.item();
    await s.mention(item.id, [s.people.dana.id, s.people.eli.id]);
    await s.drain();
    expect(s.fake.state.posts.map((p) => p.user)).toEqual(["UELI"]);
  });

  it("nothing after the recipient left the org", async () => {
    const s = await setup(["dana", "eli"]);
    const item = await s.item();
    await s.mention(item.id, [s.people.dana.id, s.people.eli.id]);
    await prisma.orgMember.deleteMany({ where: { orgId: s.org.id, userId: s.people.dana.id } });
    await s.drain();
    expect(s.fake.state.posts.map((p) => p.user)).toEqual(["UELI"]);
  });

  it("the title only where the org lets titles leave Cosmos by email: withheld by default for government orgs, shown for commercial", async () => {
    const s = await setup(["dana"]);
    const item = await s.item("Quarterly <budget> & plan");
    await s.assign(item.id, s.people.dana.id);
    await s.drain();
    expect(s.fake.state.posts[0].text).toMatch(/ Restricted$/);
    expect(JSON.stringify(s.fake.state.posts[0])).not.toContain("budget");

    await prisma.organization.update({ where: { id: s.org.id }, data: { tenantClass: "COMMERCIAL" } });
    await prisma.workItem.update({ where: { id: item.id }, data: { assigneeId: null } });
    await s.assign(item.id, s.people.dana.id);
    await s.drain();
    // Escaped for Slack, so the title can't become a link or a mention.
    expect(s.fake.state.posts[1].text).toMatch(/ Quarterly &lt;budget&gt; &amp; plan$/);
  });

  it("a Slack outage never fails the change: the item saves, the message waits and retries, and the admin sees why", async () => {
    const s = await setup(["dana"]);
    s.fake.state.fail["conversations.open"] = [{ status: 503 }, { status: 503 }];
    const item = await s.item();
    await s.assign(item.id, s.people.dana.id);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } })).assigneeId).toBe(s.people.dana.id);

    const t0 = new Date();
    expect(await s.drain(t0)).toEqual({ sent: 0, skipped: 0, retried: 1, failed: 0 });
    const [row] = await s.queued();
    expect(row).toMatchObject({ attempts: 1, lastError: "http_503" });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(t0.getTime() + 30_000);
    expect(await prisma.slackInstallation.findUniqueOrThrow({ where: { orgId: s.org.id } })).toMatchObject({ status: "ACTIVE", lastErrorCode: "http_503" });

    // Not before it's due.
    expect(await s.drain(new Date(t0.getTime() + 1_000))).toEqual({ sent: 0, skipped: 0, retried: 0, failed: 0 });
    expect(await s.drain(new Date(t0.getTime() + 31_000))).toMatchObject({ retried: 1 });
    expect((await s.queued())[0]).toMatchObject({ attempts: 2 });
    // Slack is back: it goes, once.
    expect(await s.drain(new Date(t0.getTime() + 200_000))).toEqual({ sent: 1, skipped: 0, retried: 0, failed: 0 });
    expect(s.fake.postsTo("UDANA")).toHaveLength(1);
    expect((await prisma.slackInstallation.findUniqueOrThrow({ where: { orgId: s.org.id } })).lastDeliveredAt).not.toBeNull();
  });

  it("Slack's Retry-After is honoured", async () => {
    const s = await setup(["dana"]);
    s.fake.state.fail["chat.postMessage"] = [{ status: 429, retryAfter: "300" }];
    const item = await s.item();
    await s.assign(item.id, s.people.dana.id);
    const t0 = new Date();
    expect((await s.drain(t0)).retried).toBe(1);
    const [row] = await s.queued();
    expect(row.lastError).toBe("ratelimited");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(t0.getTime() + 300_000);
  });

  it("a revoked token stops the org's sends and marks the connection broken; nothing more is queued until an admin reconnects", async () => {
    const s = await setup(["dana", "eli"]);
    const item = await s.item();
    await s.mention(item.id, [s.people.dana.id, s.people.eli.id]);
    s.fake.state.revoked.add(s.fake.state.issued[0]);
    // Both waiting messages fail, from the one refusal: no second call with a dead token.
    expect(await s.drain()).toEqual({ sent: 0, skipped: 0, retried: 0, failed: 2 });
    expect(s.fake.state.calls.filter((c) => c.method !== "oauth.v2.access")).toHaveLength(1);
    expect(await s.queued()).toEqual([]);
    expect(await prisma.slackInstallation.findUniqueOrThrow({ where: { orgId: s.org.id } })).toMatchObject({ status: "ERROR", lastErrorCode: "invalid_auth" });
    await s.mention(item.id, [s.people.eli.id]);
    expect(await s.queued()).toEqual([]);
    // The in-app notification still happened.
    expect(await prisma.notification.count({ where: { orgId: s.org.id, userId: s.people.eli.id } })).toBe(2);
  });

  it("a Slack user that's gone is dropped to unmatched, not retried", async () => {
    const s = await setup(["dana"]);
    const item = await s.item();
    await s.assign(item.id, s.people.dana.id);
    await s.drain();
    s.fake.state.users = [];
    const other = await s.item();
    await s.assign(other.id, s.people.dana.id);
    expect(await s.drain()).toEqual({ sent: 0, skipped: 0, retried: 0, failed: 1 });
    expect(await s.queued()).toEqual([]);
    expect(await prisma.slackUserLink.findUniqueOrThrow({ where: { orgId_userId: { orgId: s.org.id, userId: s.people.dana.id } } }))
      .toMatchObject({ status: "NO_MATCH", slackUserId: null });
  });

  it("never the title of an item restricted by classification: a classified project's, or a title carrying a marking", async () => {
    const s = await setup(["dana"]);
    await prisma.organization.update({ where: { id: s.org.id }, data: { tenantClass: "COMMERCIAL" } });
    const classified = await s.newProject("CU");
    await prisma.dataClassification.create({ data: { orgId: s.org.id, projectId: classified.id, level: "CUI", appliedById: s.owner.id } });
    const items = [
      await s.item("Classified roadmap", classified.id),
      await s.item("Open roadmap"),
      await s.item("CUI//SP-PRVCY payroll list"),
    ];
    for (const it of items) await s.assign(it.id, s.people.dana.id);
    expect(await s.drain()).toEqual({ sent: 3, skipped: 0, retried: 0, failed: 0 });
    const texts = s.fake.postsTo("UDANA").map((p) => p.text);
    // Positive control: titles are allowed here, and the open one shows.
    expect(texts.filter((t) => t.endsWith(" Open roadmap"))).toHaveLength(1);
    expect(texts.filter((t) => t.endsWith(" Restricted"))).toHaveLength(2);
    expect(JSON.stringify(s.fake.state.posts)).not.toMatch(/Classified roadmap|payroll/);
  });

  it("one org whose stored token can't be read holds up nobody else: its messages wait, another org's go, and its admin sees why", async () => {
    const fake = fakeSlack();
    const a = await setup(["alpha"], {}, { fake });
    const b = await setup(["bravo"], {}, { fake });
    const ia = await a.item();
    await a.mention(ia.id, [a.people.alpha.id]);
    const ib = await b.item();
    await b.mention(ib.id, [b.people.bravo.id]);
    // A's token was sealed under a key since retired from the keyring.
    await prisma.connectorCredential.updateMany({
      where: { orgId: a.org.id, provider: "slack-notifications" },
      data: { secretEnc: "v2.retired.AAAA.AAAA.AAAA" },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await drainSlackOutbox({ deps: { fetch: fake.fetch }, orgId: [a.org.id, b.org.id] })).toEqual({ sent: 1, skipped: 0, retried: 0, failed: 0 });
    expect(fake.postsTo("UBRAVO")).toHaveLength(1);
    expect(fake.postsTo("UALPHA")).toHaveLength(0);
    // A's message is still there, untouched, for when an admin reconnects.
    expect((await a.queued()).map((r) => r.attempts)).toEqual([0]);
    expect(await prisma.slackInstallation.findUniqueOrThrow({ where: { orgId: a.org.id } })).toMatchObject({ lastErrorCode: "credential_unreadable" });
    const lines = logged.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(lines).toContain(a.org.id);
    expect(lines).toContain("credential_unreadable");
    expect(lines).not.toContain("xoxb-");
  });

  it("a rate limit stops calls to Slack for that org for the rest of the run; its other messages wait as long as Slack asked", async () => {
    const s = await setup(["rae", "rex", "roy"]);
    const item = await s.item();
    await s.mention(item.id, [s.people.rae.id, s.people.rex.id, s.people.roy.id]);
    s.fake.state.fail["users.lookupByEmail"] = [1, 2, 3].map(() => ({ status: 429, retryAfter: "60" }));
    const before = s.fake.state.calls.length;
    const t0 = new Date();
    expect(await s.drain(t0)).toEqual({ sent: 0, skipped: 0, retried: 1, failed: 0 });
    // One call, refused; no more for this org until Slack's wait is over.
    expect(s.fake.state.calls.length - before).toBe(1);
    const rows = await s.queued();
    expect(rows.map((r) => r.attempts).sort()).toEqual([0, 0, 1]);
    for (const r of rows) expect(r.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(t0.getTime() + 60_000);
    expect(await s.drain(new Date(t0.getTime() + 30_000))).toEqual({ sent: 0, skipped: 0, retried: 0, failed: 0 });
    // After the wait, with Slack answering again: all three go, once each.
    s.fake.state.fail["users.lookupByEmail"] = [];
    expect(await s.drain(new Date(t0.getTime() + 61_000))).toEqual({ sent: 3, skipped: 0, retried: 0, failed: 0 });
    expect(s.fake.state.posts.map((p) => p.user).sort()).toEqual(["URAE", "UREX", "UROY"]);
  });
});
