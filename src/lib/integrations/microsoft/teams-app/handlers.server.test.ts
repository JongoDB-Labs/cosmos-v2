// COSMOS-202 T1 (e2e DB): the Cosmos for Teams invokes, as the Teams user's own
// Cosmos account. Link cards, search and "Create Cosmos item" see exactly what
// that person sees in Cosmos; a restricted item is only its key; anyone Cosmos
// can't match (never connected, left, other tenant) gets the connect card and
// nothing else.
import crypto from "node:crypto";
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { MS_CALENDAR } from "../calendar-connect";
import { MS_TEAMS_APP } from "./identity.server";
import { handleActivity, parseItemLink, type Activity } from "./handlers.server";

const ORIGIN = "https://cosmos.example";

type Att = { content: Record<string, unknown> };
const attachments = (r: { body?: unknown }) => ((r.body as { composeExtension?: { attachments?: Att[] } })?.composeExtension?.attachments ?? []);
const text = (v: unknown) => JSON.stringify(v);
const taskCard = (r: { body?: unknown }) => (r.body as { task: { value: { card: { content: Record<string, unknown> } } } }).task.value.card.content;

describe("Cosmos for Teams invokes (e2e DB)", () => {
  const orgIds: string[] = [];
  const createdTypes: string[] = [];
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
    await prisma.workItemType.deleteMany({ where: { id: { in: createdTypes } } }).catch(() => undefined);
  });

  async function builtInTask() {
    const t = await prisma.workItemType.findFirst({ where: { isBuiltIn: true, key: "software.task" } });
    if (t) return t;
    const made = await prisma.workItemType.create({ data: { key: "software.task", name: "Task", isBuiltIn: true } });
    createdTypes.push(made.id);
    return made;
  }

  /** alice (ADMIN) and bob (VIEWER) connected Outlook as oid-alice / oid-bob; carol never did. */
  async function setup() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Each org its own tenant, so the orgs other tests leave behind don't answer too.
    const TENANT = crypto.randomUUID();
    const [alice, bob, carol] = await Promise.all(
      ["alice", "bob", "carol"].map((n) => prisma.user.findFirstOrThrow({ where: { email: `${n}@test.local` } })),
    );
    const org = await prisma.organization.create({ data: { name: `teams ${stamp}`, slug: `teams-${stamp}` } });
    orgIds.push(org.id);
    await prisma.orgMember.createMany({
      data: [
        { orgId: org.id, userId: alice.id, role: "ADMIN" },
        { orgId: org.id, userId: bob.id, role: "VIEWER" },
        { orgId: org.id, userId: carol.id, role: "MEMBER" },
      ],
    });
    const cal = await prisma.integration.create({
      data: { orgId: org.id, provider: MS_CALENDAR, displayName: "Outlook Calendar", config: { tenantId: TENANT }, status: "ACTIVE", installedById: alice.id },
    });
    const app = await prisma.integration.create({
      data: { orgId: org.id, provider: MS_TEAMS_APP, displayName: "Cosmos for Teams", config: {}, status: "ACTIVE", installedById: alice.id },
    });
    const oid = (n: string) => `oid-${n}-${stamp}`;
    for (const [u, n] of [[alice, "alice"], [bob, "bob"]] as const) {
      await prisma.connectorCredential.create({
        data: { orgId: org.id, provider: MS_CALENDAR, userId: u.id, secretEnc: "sealed", meta: { tid: TENANT, oid: oid(n), upn: u.email, status: "connected" } },
      });
    }
    const type = await builtInTask();
    const key = `TM${stamp.slice(-4).replace(/[^a-z0-9]/gi, "").toUpperCase()}X`;
    const project = await prisma.project.create({ data: { orgId: org.id, name: "Teams project", key } });
    await ensureFixtureStatuses(project.id);
    await ensureFixtureStatuses(project.id, ["in_progress"], { in_progress: "IN_PROGRESS" });
    const item = await prisma.workItem.create({
      data: {
        orgId: org.id, projectId: project.id, ticketNumber: 1, title: "Fix the login page", description: "It loops.",
        columnKey: "in_progress", workItemTypeId: type.id, createdById: alice.id, assigneeId: alice.id,
        assignees: { create: [{ userId: alice.id, sortOrder: 0 }] },
      },
    });
    const ref = `${key}-1`;
    const invoke = (who: string, name: string, value: unknown, tenant = TENANT): Activity => ({
      type: "invoke", name, value, channelId: "msteams", serviceUrl: "https://smba.trafficmanager.net/amer/",
      from: { aadObjectId: who }, channelData: { tenant: { id: tenant } },
    });
    return { org, alice, bob, carol, cal, app, project, item, ref, oid, invoke, type };
  }

  it("parses only this instance's item links", () => {
    expect(parseItemLink(`${ORIGIN}/acme/issues?item=ACME-12`, ORIGIN)).toEqual({ slug: "acme", ref: "ACME-12" });
    expect(parseItemLink(`https://evil.example/acme/issues?item=ACME-12`, ORIGIN)).toBeNull();
    expect(parseItemLink(`${ORIGIN}/acme/issues`, ORIGIN)).toBeNull();
    expect(parseItemLink("not a url", ORIGIN)).toBeNull();
  });

  it("(a) a pasted item link becomes a card with its title, status, assignee and a link back", async () => {
    const s = await setup();
    const r = await handleActivity(s.invoke(s.oid("alice"), "composeExtension/queryLink", { url: `${ORIGIN}/${s.org.slug}/issues?item=${s.ref}` }), ORIGIN);
    expect(r.status).toBe(200);
    const [card] = attachments(r);
    const t = text(card);
    for (const want of [s.ref, "Fix the login page", "In progress", "Alice", "Teams project", `${ORIGIN}/${s.org.slug}/issues?item=${s.ref}`]) expect(t).toContain(want);
  });

  it("(a) a restricted item's card is its key and 'Restricted', nothing from inside it", async () => {
    const s = await setup();
    await prisma.dataClassification.create({ data: { orgId: s.org.id, projectId: s.project.id, level: "FOUO", appliedById: s.alice.id } });
    const r = await handleActivity(s.invoke(s.oid("alice"), "composeExtension/queryLink", { url: `${ORIGIN}/${s.org.slug}/issues?item=${s.ref}` }), ORIGIN);
    const t = text(r.body);
    expect(t).toContain(s.ref);
    expect(t).toContain("Restricted");
    for (const leak of ["Fix the login page", "In progress", "Alice", "Teams project", "loops"]) expect(t).not.toContain(leak);
  });

  it("(a) a marking in the title alone is enough to restrict the card", async () => {
    const s = await setup();
    await prisma.workItem.update({ where: { id: s.item.id }, data: { title: "CUI//SP-PRVCY payroll export" } });
    const r = await handleActivity(s.invoke(s.oid("alice"), "composeExtension/queryLink", { url: `${ORIGIN}/${s.org.slug}/issues?item=${s.ref}` }), ORIGIN);
    expect(text(r.body)).not.toContain("payroll");
  });

  it("(a) an item the person can't read, or doesn't exist, or in another org, gives no card at all", async () => {
    const s = await setup();
    // A team-scoped project bob isn't a member of.
    await prisma.project.update({ where: { id: s.project.id }, data: { teamScopedAccess: true } });
    const asBob = await handleActivity(s.invoke(s.oid("bob"), "composeExtension/queryLink", { url: `${ORIGIN}/${s.org.slug}/issues?item=${s.ref}` }), ORIGIN);
    expect(attachments(asBob)).toEqual([]);
    const missing = await handleActivity(s.invoke(s.oid("alice"), "composeExtension/queryLink", { url: `${ORIGIN}/${s.org.slug}/issues?item=${s.project.key}-999` }), ORIGIN);
    expect(attachments(missing)).toEqual([]);
    const other = await handleActivity(s.invoke(s.oid("alice"), "composeExtension/queryLink", { url: `${ORIGIN}/some-other-org/issues?item=${s.ref}` }), ORIGIN);
    expect(attachments(other)).toEqual([]);
  });

  it("someone Cosmos can't match gets the connect card, and nothing about the item", async () => {
    const s = await setup();
    for (const who of ["oid-stranger", ""]) {
      const r = await handleActivity(s.invoke(who, "composeExtension/queryLink", { url: `${ORIGIN}/${s.org.slug}/issues?item=${s.ref}` }), ORIGIN);
      const t = text(r.body);
      expect(t).toContain("Connect your Cosmos account");
      expect(t).toContain(`${ORIGIN}/${s.org.slug}/settings/preferences`);
      expect(t).not.toContain("Fix the login page");
    }
    const search = await handleActivity(s.invoke("oid-stranger", "composeExtension/query", { parameters: [{ name: "query", value: "login" }] }), ORIGIN);
    expect(text(search.body)).not.toContain("Fix the login page");
    const form = await handleActivity(s.invoke("oid-stranger", "composeExtension/fetchTask", {}), ORIGIN);
    expect(text(taskCard(form))).toContain("Connect your Cosmos account");
  });

  it("a person who left the org, or was deactivated, is no longer matched", async () => {
    const s = await setup();
    const url = `${ORIGIN}/${s.org.slug}/issues?item=${s.ref}`;
    await prisma.orgMember.deleteMany({ where: { orgId: s.org.id, userId: s.alice.id } });
    expect(text((await handleActivity(s.invoke(s.oid("alice"), "composeExtension/queryLink", { url }), ORIGIN)).body)).toContain("Connect your Cosmos account");
    const t = await setup();
    await prisma.user.update({ where: { id: t.bob.id }, data: { deactivatedAt: new Date() } });
    try {
      const r = await handleActivity(t.invoke(t.oid("bob"), "composeExtension/queryLink", { url: `${ORIGIN}/${t.org.slug}/issues?item=${t.ref}` }), ORIGIN);
      expect(text(r.body)).toContain("Connect your Cosmos account");
    } finally {
      await prisma.user.update({ where: { id: t.bob.id }, data: { deactivatedAt: null } });
    }
  });

  it("answers only for the org's own tenant, and only while the Teams app is installed", async () => {
    const s = await setup();
    const url = `${ORIGIN}/${s.org.slug}/issues?item=${s.ref}`;
    const other = await handleActivity(s.invoke(s.oid("alice"), "composeExtension/queryLink", { url }, "99999999-0000-0000-0000-000000000000"), ORIGIN);
    expect(other.status).toBe(403);
    expect(other.body).toBeUndefined();
    // The same oid under another tenant's credential doesn't match either.
    await prisma.connectorCredential.updateMany({ where: { orgId: s.org.id, userId: s.alice.id }, data: { meta: { tid: "99999999-0000-0000-0000-000000000000", oid: s.oid("alice"), status: "connected" } } });
    expect(text((await handleActivity(s.invoke(s.oid("alice"), "composeExtension/queryLink", { url }), ORIGIN)).body)).toContain("Connect your Cosmos account");
    await prisma.integration.update({ where: { id: s.app.id }, data: { status: "INACTIVE" } });
    expect((await handleActivity(s.invoke(s.oid("bob"), "composeExtension/queryLink", { url }), ORIGIN)).status).toBe(403);
  });

  it("(c) search finds items by text, never restricted ones, and with nothing typed shows your own", async () => {
    const s = await setup();
    const search = (q: string) => handleActivity(s.invoke(s.oid("alice"), "composeExtension/query", { commandId: "searchItems", parameters: [{ name: "query", value: q }] }), ORIGIN);
    expect(text((await search("login")).body)).toContain("Fix the login page");
    expect(attachments(await search("nothing matches this"))).toEqual([]);
    expect(text((await search("")).body)).toContain("Fix the login page"); // assigned to alice
    const bobs = await handleActivity(s.invoke(s.oid("bob"), "composeExtension/query", { parameters: [{ name: "query", value: "" }] }), ORIGIN);
    expect(attachments(bobs)).toEqual([]); // nothing assigned to bob
    await prisma.dataClassification.create({ data: { orgId: s.org.id, projectId: s.project.id, level: "FOUO", appliedById: s.alice.id } });
    const r = await search("login");
    expect(attachments(r)).toEqual([]);
    expect(text(r.body)).not.toContain(s.ref);
  });

  it("(b) Create Cosmos item: the form is prefilled from the message, and submitting creates it as that person", async () => {
    const s = await setup();
    const messagePayload = {
      body: { contentType: "html", content: "<p>Login page loops on Safari</p><p>Seen by 3 customers &amp; me</p>" },
      linkToMessage: "https://teams.microsoft.com/l/message/19:abc/123",
      from: { user: { displayName: "Dana" } },
    };
    const form = await handleActivity(s.invoke(s.oid("alice"), "composeExtension/fetchTask", { commandId: "createItem", messagePayload }), ORIGIN);
    const card = text(taskCard(form));
    expect(card).toContain("Login page loops on Safari");
    expect(card).toContain("Seen by 3 customers & me");
    expect(card).toContain("From a Teams message by Dana. https://teams.microsoft.com/l/message/19:abc/123");
    expect(card).toContain(`${s.org.id}:${s.project.id}`);

    const r = await handleActivity(s.invoke(s.oid("alice"), "composeExtension/submitAction", {
      commandId: "createItem", messagePayload,
      data: { projectId: `${s.org.id}:${s.project.id}`, type: "task", title: "Login page loops on Safari", description: "Seen by 3 customers" },
    }), ORIGIN);
    const created = await prisma.workItem.findFirstOrThrow({ where: { projectId: s.project.id, title: "Login page loops on Safari" } });
    expect(created.createdById).toBe(s.alice.id);
    expect(created.ticketNumber).toBe(2);
    expect(await prisma.activity.count({ where: { workItemId: created.id, action: "created", userId: s.alice.id } })).toBe(1);
    expect(text(r.body)).toContain(`${s.project.key}-2`);
  });

  it("(b) a missing title or project sends the form back with the reason; a viewer has nowhere to create", async () => {
    const s = await setup();
    const submit = (data: object) => handleActivity(s.invoke(s.oid("alice"), "composeExtension/submitAction", { data }), ORIGIN);
    expect(text(taskCard(await submit({ projectId: `${s.org.id}:${s.project.id}`, title: "  " })))).toContain("A title is needed.");
    expect(text(taskCard(await submit({ projectId: "", title: "x" })))).toContain("Pick a project.");
    // A project in an org this person isn't matched in.
    expect(text(taskCard(await submit({ projectId: `00000000-0000-0000-0000-000000000000:${s.project.id}`, title: "x" })))).toContain("Pick a project.");
    expect(await prisma.workItem.count({ where: { projectId: s.project.id } })).toBe(1);

    const viewer = await handleActivity(s.invoke(s.oid("bob"), "composeExtension/fetchTask", {}), ORIGIN);
    expect(text(taskCard(viewer))).toContain("You can't create items in any Cosmos project.");
    const forged = await handleActivity(s.invoke(s.oid("bob"), "composeExtension/submitAction", { data: { projectId: `${s.org.id}:${s.project.id}`, title: "sneaky" } }), ORIGIN);
    expect(text(forged.body)).not.toContain(`${s.project.key}-2`);
    expect(await prisma.workItem.count({ where: { projectId: s.project.id, title: "sneaky" } })).toBe(0);
  });

  it("acknowledges non-invoke activities without answering them", async () => {
    const s = await setup();
    const r = await handleActivity({ ...s.invoke(s.oid("alice"), "", undefined), type: "message", name: undefined }, ORIGIN);
    expect(r).toEqual({ status: 200 });
  });
});
