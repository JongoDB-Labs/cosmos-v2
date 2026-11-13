// @vitest-environment node
//
// The same rule as foreign-ids.db.test.ts, for the other writes that take a
// row's id from the request body: a bill's partner, an objective's parent, a
// goal's link, a meeting's sprint, a classification's project, an invoice's
// contract and products, an expense's or a time entry's CLIN and work item, a
// board template's project template, a chat reply's parent, and the rows of a
// JSON import. Each names another org's row and must be refused, with nothing
// stored; each has a positive control naming the caller's own row.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
vi.mock("@/lib/cache/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache/queries")>()),
  revalidateOrgProjects: vi.fn(),
}));

import { POST as createBill } from "@/app/api/v1/orgs/[orgId]/bills/route";
import { POST as createObjective } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/objectives/route";
import { POST as linkGoal } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/goals/[goalId]/links/route";
import { POST as createMeeting } from "@/app/api/v1/orgs/[orgId]/meetings/route";
import { POST as classify } from "@/app/api/v1/orgs/[orgId]/classifications/route";
import { POST as createInvoice } from "@/app/api/v1/orgs/[orgId]/invoices/route";
import { POST as createExpense } from "@/app/api/v1/orgs/[orgId]/finance/expenses/route";
import { POST as createTimeEntry } from "@/app/api/v1/orgs/[orgId]/time-entries/route";
import { POST as importJson } from "@/app/api/v1/orgs/[orgId]/import/json/route";
import { POST as createBoardTemplate } from "@/app/api/v1/orgs/[orgId]/board-templates/route";
import { POST as createProject } from "@/app/api/v1/orgs/[orgId]/projects/route";
import { POST as postMessage } from "@/app/api/v1/orgs/[orgId]/chat/channels/[channelId]/messages/route";
import { GET as listReplies } from "@/app/api/v1/orgs/[orgId]/chat/channels/[channelId]/messages/[messageId]/replies/route";
import { logTime } from "@/lib/ai/executors/time";

const stamp = Math.random().toString(36).slice(2, 8);
const K = stamp.slice(0, 3).toUpperCase();

// Org A is the caller's. Org B is somebody else's.
let orgA = "", orgB = "", owner = "", ownerB = "";
let p1 = "", p2 = "", pB = "";
let partnerA = "", partnerB = "", productA = "", productB = "", contractA = "", contractB = "";
let objectiveP1 = "", objectiveP2 = "", objectiveB = "", goalP1 = "";
let sprintP1 = "", sprintB = "", clinP1 = "", clinB = "", itemP1 = "", itemB = "";
let templateA = "", templateB = "", templateBuiltIn = "";
let channelA = "", channelB = "", messageA = "", messageB = "";

const session = (): AuthContext => ({
  userId: owner, orgId: orgA, orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [],
});
const json = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
const inOrg = () => ({ params: Promise.resolve({ orgId: orgA }) });
const inP1 = () => ({ params: Promise.resolve({ orgId: orgA, projectId: p1 }) });
const tag = () => `${stamp}-${Math.random().toString(36).slice(2, 7)}`;

beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: `sib-${stamp}@fk.test`, displayName: "Owner A" } })).id;
  ownerB = (await prisma.user.create({ data: { email: `sibb-${stamp}@fk.test`, displayName: "Owner B" } })).id;
  orgA = (await prisma.organization.create({ data: { name: `sib a ${stamp}`, slug: `sib-a-${stamp}` } })).id;
  orgB = (await prisma.organization.create({ data: { name: `sib b ${stamp}`, slug: `sib-b-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId: orgA, userId: owner, role: "OWNER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId: orgB, userId: ownerB, role: "OWNER", permissions: "0" } });
  p1 = (await prisma.project.create({ data: { orgId: orgA, name: "P1", key: `SA${K}` } })).id;
  p2 = (await prisma.project.create({ data: { orgId: orgA, name: "P2", key: `SB${K}` } })).id;
  pB = (await prisma.project.create({ data: { orgId: orgB, name: "PB", key: `SC${K}` } })).id;
  for (const p of [p1, p2, pB]) await ensureFixtureStatuses(p);
  const typeTask = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;

  partnerA = (await prisma.partner.create({ data: { orgId: orgA, name: "Partner A" } })).id;
  partnerB = (await prisma.partner.create({ data: { orgId: orgB, name: "Partner B secret" } })).id;
  productA = (await prisma.product.create({ data: { orgId: orgA, name: "Product A" } })).id;
  productB = (await prisma.product.create({ data: { orgId: orgB, name: "Product B" } })).id;
  contractA = (await prisma.contract.create({ data: { orgId: orgA, title: "Contract A" } })).id;
  contractB = (await prisma.contract.create({ data: { orgId: orgB, title: "Contract B", partnerId: partnerB } })).id;
  objectiveP1 = (await prisma.objective.create({ data: { orgId: orgA, projectId: p1, title: "O1" } })).id;
  objectiveP2 = (await prisma.objective.create({ data: { orgId: orgA, projectId: p2, title: "O2" } })).id;
  objectiveB = (await prisma.objective.create({ data: { orgId: orgB, projectId: pB, title: "OB" } })).id;
  goalP1 = (await prisma.goal.create({ data: { orgId: orgA, projectId: p1, title: "G1" } })).id;
  const sprint = (orgId: string, projectId: string) =>
    prisma.interval.create({ data: { orgId, projectId, number: 1, name: "S", startDate: new Date("2026-11-02"), endDate: new Date("2026-11-13") } });
  sprintP1 = (await sprint(orgA, p1)).id;
  sprintB = (await sprint(orgB, pB)).id;
  clinP1 = (await prisma.clin.create({ data: { orgId: orgA, projectId: p1, code: "0001", title: "C1" } })).id;
  clinB = (await prisma.clin.create({ data: { orgId: orgB, projectId: pB, code: "0001", title: "CB" } })).id;
  itemP1 = (await createFixtureWorkItem({ orgId: orgA, projectId: p1, workItemTypeId: typeTask, createdById: owner, title: "I1", columnKey: "todo" })).id;
  itemB = (await createFixtureWorkItem({ orgId: orgB, projectId: pB, workItemTypeId: typeTask, createdById: ownerB, title: "IB", columnKey: "todo" })).id;
  const template = (orgId: string | null, builtIn = false) =>
    prisma.projectTemplate.create({ data: { orgId, isBuiltIn: builtIn, slug: tag(), sector: "general", name: "PT" } });
  templateA = (await template(orgA)).id;
  templateB = (await template(orgB)).id;
  templateBuiltIn = (await template(null, true)).id;
  const channel = (orgId: string, by: string) =>
    prisma.chatChannel.create({ data: { orgId, kind: "CHANNEL", name: tag(), createdById: by } });
  channelA = (await channel(orgA, owner)).id;
  channelB = (await channel(orgB, ownerB)).id;
  await prisma.chatChannelMember.create({ data: { channelId: channelA, userId: owner } });
  await prisma.chatChannelMember.create({ data: { channelId: channelB, userId: ownerB } });
  messageA = (await prisma.chatMessage.create({ data: { channelId: channelA, authorId: owner, content: "hello A" } })).id;
  messageB = (await prisma.chatMessage.create({ data: { channelId: channelB, authorId: ownerB, content: "hello B" } })).id;
});

afterAll(async () => {
  await prisma.boardTemplate.deleteMany({ where: { projectTemplateId: templateBuiltIn } }).catch(() => undefined);
  await prisma.projectTemplate.deleteMany({ where: { id: templateBuiltIn } }).catch(() => undefined);
  await prisma.workItem.deleteMany({ where: { orgId: { in: [orgA, orgB] } } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [owner, ownerB] } } }).catch(() => undefined);
});

describe("a bill's partner", () => {
  const bill = (partnerId: string) => ({ reference: tag(), vendorName: "V", amount: 10, partnerId });

  it("refuses another org's partner, and stores nothing", async () => {
    h.ctx = session();
    const body = bill(partnerB);
    expect((await createBill(json("POST", body), inOrg())).status).toBe(400);
    expect(await prisma.bill.count({ where: { orgId: orgA, reference: body.reference } })).toBe(0);
  });

  it("accepts the org's own partner", async () => {
    h.ctx = session();
    const res = await createBill(json("POST", bill(partnerA)), inOrg());
    expect(res.status).toBe(201);
    expect((await res.json()).partner).toEqual({ name: "Partner A" });
  });

  it("a bill already linked to another org's partner doesn't read its name back", async () => {
    h.ctx = session();
    const res = await createBill(json("POST", bill(partnerA)), inOrg());
    const { id } = await res.json();
    await prisma.$executeRaw`UPDATE bills SET partner_id = ${partnerB}::uuid WHERE id = ${id}::uuid`;
    const { GET } = await import("@/app/api/v1/orgs/[orgId]/bills/route");
    const list = await (await GET(new NextRequest("http://localhost/x"), inOrg())).json();
    expect(JSON.stringify(list)).not.toContain("Partner B secret");
  });
});

describe("an objective's parent and a goal's links", () => {
  it.each([
    ["another org's", () => objectiveB],
    ["another project's", () => objectiveP2],
  ])("an objective refuses %s parent, and stores nothing", async (_l, parent) => {
    h.ctx = session();
    const title = tag();
    expect((await createObjective(json("POST", { title, parentId: parent() }), inP1())).status).toBe(400);
    expect(await prisma.objective.count({ where: { orgId: orgA, title } })).toBe(0);
  });

  it("an objective accepts a parent in its own project", async () => {
    h.ctx = session();
    expect((await createObjective(json("POST", { title: tag(), parentId: objectiveP1 }), inP1())).status).toBe(200);
  });

  const atGoal = () => ({ params: Promise.resolve({ orgId: orgA, projectId: p1, goalId: goalP1 }) });
  it.each([
    ["another org's work item", () => ({ kind: "WORK_ITEM", workItemId: itemB })],
    ["another org's objective", () => ({ kind: "OBJECTIVE", objectiveId: objectiveB })],
  ])("a goal refuses a link to %s, and stores nothing", async (_l, body) => {
    h.ctx = session();
    expect((await linkGoal(json("POST", body()), atGoal())).status).toBe(400);
    expect(await prisma.goalLink.count({ where: { goalId: goalP1, OR: [{ workItemId: itemB }, { objectiveId: objectiveB }] } })).toBe(0);
  });

  it("a goal accepts a link to its own project's item", async () => {
    h.ctx = session();
    expect((await linkGoal(json("POST", { kind: "WORK_ITEM", workItemId: itemP1 }), atGoal())).status).toBe(200);
  });
});

describe("a meeting's sprint and a classification's project", () => {
  it("a meeting refuses another org's sprint, and stores nothing", async () => {
    h.ctx = session();
    const title = tag();
    const res = await createMeeting(json("POST", { title, meetingDate: "2026-11-12T15:00:00.000Z", sprintId: sprintB }), inOrg());
    expect(res.status).toBe(400);
    expect(await prisma.syncMeeting.count({ where: { orgId: orgA, title } })).toBe(0);
  });

  it("a meeting accepts its project's sprint", async () => {
    h.ctx = session();
    const res = await createMeeting(json("POST", { title: tag(), meetingDate: "2026-11-12T15:00:00.000Z", projectId: p1, sprintId: sprintP1 }), inOrg());
    expect(res.status).toBe(201);
  });

  it("a classification refuses another org's project, and stores nothing", async () => {
    h.ctx = session();
    expect((await classify(json("POST", { projectId: pB, level: "CUI" }), inOrg())).status).toBe(400);
    expect(await prisma.dataClassification.count({ where: { projectId: pB } })).toBe(0);
  });

  it("a classification accepts the org's own project", async () => {
    h.ctx = session();
    expect((await classify(json("POST", { projectId: p1, level: "CUI" }), inOrg())).status).toBeLessThan(300);
  });
});

describe("an invoice's contract and products, an expense's and a time entry's CLIN and item", () => {
  const invoice = (extra: Record<string, unknown>, productId: string | null = null) => ({
    billToName: tag(), lines: [{ description: "L", quantity: 1, unitPrice: 5, productId }], ...extra,
  });

  it.each([
    ["another org's contract", () => invoice({ contractId: contractB })],
    ["another org's product on a line", () => invoice({}, productB)],
  ])("an invoice refuses %s, and stores nothing", async (_l, body) => {
    h.ctx = session();
    const b = body();
    expect((await createInvoice(json("POST", b), inOrg())).status).toBe(400);
    expect(await prisma.invoice.count({ where: { orgId: orgA, billToName: b.billToName } })).toBe(0);
  });

  it("an invoice accepts the org's own contract and product", async () => {
    h.ctx = session();
    expect((await createInvoice(json("POST", invoice({ contractId: contractA }, productA)), inOrg())).status).toBe(200);
  });

  it("an expense refuses another org's CLIN, and stores nothing", async () => {
    h.ctx = session();
    const description = tag();
    const res = await createExpense(json("POST", { amount: 5, date: "2026-11-12", category: "Travel", description, clinId: clinB }), inOrg());
    expect(res.status).toBe(400);
    expect(await prisma.expense.count({ where: { orgId: orgA, description } })).toBe(0);
  });

  it("an expense accepts its project's CLIN", async () => {
    h.ctx = session();
    const res = await createExpense(json("POST", { amount: 5, date: "2026-11-12", category: "Travel", description: tag(), projectId: p1, clinId: clinP1 }), inOrg());
    expect(res.status).toBeLessThan(300);
  });

  it.each([
    ["another org's work item", () => ({ workItemId: itemB })],
    ["another org's CLIN", () => ({ clinId: clinB })],
  ])("a time entry refuses %s, and stores nothing", async (_l, ref) => {
    h.ctx = session();
    const description = tag();
    expect((await createTimeEntry(json("POST", { date: "2026-11-12", hours: 1, description, ...ref() }), inOrg())).status).toBe(400);
    expect(await prisma.timeEntry.count({ where: { orgId: orgA, description } })).toBe(0);
  });

  it("a time entry accepts its project's item and CLIN", async () => {
    h.ctx = session();
    const res = await createTimeEntry(json("POST", { date: "2026-11-12", hours: 1, description: tag(), projectId: p1, workItemId: itemP1, clinId: clinP1 }), inOrg());
    expect(res.status).toBeLessThan(300);
  });

  it("the assistant's log_time refuses another org's work item, and its own passes", async () => {
    const tool = { orgId: orgA, userId: owner, auth: session() };
    const description = tag();
    const out = (await logTime({ date: "2026-11-12", hours: 1, description, workItemId: itemB }, tool)) as { error?: string };
    expect(out.error).toBeTruthy();
    expect(await prisma.timeEntry.count({ where: { orgId: orgA, description } })).toBe(0);
    const ok = (await logTime({ date: "2026-11-12", hours: 1, description: tag(), projectId: p1, workItemId: itemP1 }, tool)) as { error?: string };
    expect(ok.error).toBeUndefined();
  });
});

describe("a JSON import", () => {
  it("imports a partner's own columns, and none of its relations", async () => {
    h.ctx = session();
    const planted = tag();
    const res = await importJson(
      json("POST", {
        partners: [
          { name: `connect-${planted}`, contracts: { connect: [{ id: contractB }] } },
          { name: `create-${planted}`, contracts: { create: [{ orgId: orgB, title: planted }] } },
        ],
      }),
      inOrg(),
    );
    expect(res.status).toBe(200);
    // Another org's contract keeps its own partner, and nothing is written there.
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contractB } })).partnerId).toBe(partnerB);
    expect(await prisma.contract.count({ where: { title: planted } })).toBe(0);
    // Positive control: the rows themselves were imported, as plain partners.
    expect(await prisma.partner.count({ where: { orgId: orgA, name: { endsWith: planted } } })).toBe(2);
  });

  it("skips an expense row that names another org's CLIN or invoice", async () => {
    h.ctx = session();
    const invoiceB = (await prisma.invoice.create({ data: { orgId: orgB, number: tag(), billToName: "B", createdById: ownerB } })).id;
    const d = tag();
    // As the JSON export writes an expense: its own columns, creator included.
    const row = { amount: 1, date: "2026-11-12T00:00:00.000Z", category: "X", createdById: owner };
    const res = await importJson(
      json("POST", {
        expenses: [
          { ...row, description: `${d}-clin`, clinId: clinB },
          { ...row, description: `${d}-inv`, invoiceId: invoiceB },
          { ...row, description: `${d}-ok`, projectId: p1, clinId: clinP1 },
        ],
      }),
      inOrg(),
    );
    expect((await res.json()).imported.expenses).toBe(1);
    expect(await prisma.expense.count({ where: { orgId: orgA, description: { startsWith: d } } })).toBe(1);
  });
});

describe("a board template's project template", () => {
  const bt = (projectTemplateId: string) => ({ name: tag(), category: "General", boardType: "KANBAN", projectTemplateId });

  it.each([
    ["another org's", () => templateB],
    ["a built-in", () => templateBuiltIn],
  ])("refuses %s project template, and stores nothing", async (_l, tpl) => {
    h.ctx = session();
    const body = bt(tpl());
    expect((await createBoardTemplate(json("POST", body), inOrg())).status).toBe(400);
    expect(await prisma.boardTemplate.count({ where: { name: body.name } })).toBe(0);
  });

  it("accepts the org's own project template", async () => {
    h.ctx = session();
    expect((await createBoardTemplate(json("POST", bt(templateA)), inOrg())).status).toBe(201);
  });

  it("a project made from a built-in template gets no board another org attached to it", async () => {
    // Written straight to the table, as a row from before the check would be.
    await prisma.boardTemplate.create({
      data: { orgId: orgB, slug: tag(), name: "Planted board", category: "x", boardType: "KANBAN", projectTemplateId: templateBuiltIn },
    });
    h.ctx = session();
    const res = await createProject(json("POST", { name: "From built-in", key: `SD${K}`, templateId: templateBuiltIn }), inOrg());
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(await prisma.board.count({ where: { projectId: id, name: "Planted board" } })).toBe(0);
  });
});

describe("a chat reply's parent", () => {
  const inChannel = (channelId: string) => ({ params: Promise.resolve({ orgId: orgA, channelId }) });

  it("refuses a parent in another org's channel, and stores nothing", async () => {
    h.ctx = session();
    const id = randomUUID();
    const res = await postMessage(json("POST", { id, content: "reply", parentMessageId: messageB }), inChannel(channelA));
    expect(res.status).toBe(400);
    expect(await prisma.chatMessage.count({ where: { id } })).toBe(0);
  });

  it("accepts a parent in the same channel", async () => {
    h.ctx = session();
    const res = await postMessage(json("POST", { id: randomUUID(), content: "reply", parentMessageId: messageA }), inChannel(channelA));
    expect(res.status).toBe(201);
  });

  it("a thread shows only replies posted in its own channel", async () => {
    // A reply planted in org A's channel under org B's message, as a row from
    // before the check would be.
    await prisma.chatMessage.create({ data: { channelId: channelA, authorId: owner, content: "planted reply", parentMessageId: messageB } });
    h.ctx = { ...session(), userId: ownerB, orgId: orgB };
    const res = await listReplies(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ orgId: orgB, channelId: channelB, messageId: messageB }),
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain("planted reply");
  });
});
