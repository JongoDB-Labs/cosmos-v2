// @vitest-environment node
//
// A write that names another row by id (a partner, a parent item, a sprint, a
// type) must name one of the caller's own: in their org, and for a row that
// lives in a project, in the same project. The foreign keys are single-column,
// so the database itself accepts another tenant's id. These specs send exactly
// that, through the real routes and the real assistant tools, against a real
// database, and check both the answer and what was stored.
//
// Every refusal has a positive control beside it: the same request with the
// caller's own id succeeds, so a refusal can't be passing because the route is
// simply broken for everyone.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { PATCH as patchVendor } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/vendors/[vendorId]/route";
import { GET as listContracts, POST as createContract } from "@/app/api/v1/orgs/[orgId]/contracts/route";
import { GET as getContract, PUT as putContract } from "@/app/api/v1/orgs/[orgId]/contracts/[contractId]/route";
import { GET as getPartner } from "@/app/api/v1/orgs/[orgId]/partners/[partnerId]/route";
import { GET as getProduct } from "@/app/api/v1/orgs/[orgId]/products/[productId]/route";
import { GET as listItems, POST as createItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/route";
import { GET as getItem, PUT as putItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/route";
import { PUT as bulkPut } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/bulk/route";
import { createWorkItem as aiCreate, updateWorkItem as aiUpdate } from "@/lib/ai/executors/work-items";

const stamp = Math.random().toString(36).slice(2, 8);
const K = stamp.slice(0, 3).toUpperCase();

// Org A is the caller's. Org B is somebody else's.
let orgA = "", orgB = "", owner = "", ownerB = "";
let p1 = "", p2 = "", pB = "";
let partnerA = "", partnerB = "", productA = "", productB = "";
let sprintP1 = "", sprintP2 = "", sprintB = "";
let typeTask = "", typeB = "";
let itemP2 = "", itemB = "";

const session = (): AuthContext => ({
  userId: owner, orgId: orgA, orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [],
});
const json = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
const sprint = (orgId: string, projectId: string, n: number) =>
  prisma.interval.create({
    data: { orgId, projectId, number: n, name: `S${n}`, startDate: new Date("2026-11-02"), endDate: new Date("2026-11-13") },
  });

beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: `own-${stamp}@fk.test`, displayName: "Owner A" } })).id;
  ownerB = (await prisma.user.create({ data: { email: `ownb-${stamp}@fk.test`, displayName: "Owner B" } })).id;
  orgA = (await prisma.organization.create({ data: { name: `fk a ${stamp}`, slug: `fk-a-${stamp}` } })).id;
  orgB = (await prisma.organization.create({ data: { name: `fk b ${stamp}`, slug: `fk-b-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId: orgA, userId: owner, role: "OWNER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId: orgB, userId: ownerB, role: "OWNER", permissions: "0" } });

  p1 = (await prisma.project.create({ data: { orgId: orgA, name: "One", key: `FA${K}` } })).id;
  p2 = (await prisma.project.create({ data: { orgId: orgA, name: "Two", key: `FB${K}` } })).id;
  pB = (await prisma.project.create({ data: { orgId: orgB, name: "Theirs", key: `FC${K}` } })).id;
  for (const p of [p1, p2, pB]) await ensureFixtureStatuses(p);

  partnerA = (await prisma.partner.create({ data: { orgId: orgA, name: "Our sub" } })).id;
  partnerB = (await prisma.partner.create({
    data: { orgId: orgB, name: "Their sub", contactEmail: "secret@b.example.com", pocName: "B person", notes: "B internal note" },
  })).id;
  productA = (await prisma.product.create({ data: { orgId: orgA, name: "Our product" } })).id;
  productB = (await prisma.product.create({ data: { orgId: orgB, name: "Their product" } })).id;

  sprintP1 = (await sprint(orgA, p1, 1)).id;
  sprintP2 = (await sprint(orgA, p2, 1)).id;
  sprintB = (await sprint(orgB, pB, 1)).id;

  typeTask = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;
  typeB = (await prisma.workItemType.create({ data: { orgId: orgB, key: `b.custom.${stamp}`, name: "B only" } })).id;

  itemP2 = (await createFixtureWorkItem({ orgId: orgA, projectId: p2, workItemTypeId: typeTask, createdById: owner, title: "In P2", columnKey: "todo" })).id;
  itemB = (await createFixtureWorkItem({ orgId: orgB, projectId: pB, workItemTypeId: typeTask, createdById: ownerB, title: "B secret title", columnKey: "todo" })).id;
});

afterAll(async () => {
  await prisma.workItem.deleteMany({ where: { orgId: { in: [orgA, orgB] } } }).catch(() => undefined);
  await prisma.contract.deleteMany({ where: { orgId: { in: [orgA, orgB] } } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } }).catch(() => undefined);
  await prisma.workItemType.deleteMany({ where: { id: typeB } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [owner, ownerB] } } }).catch(() => undefined);
});

// ─── Partners and products ────────────────────────────────────────────────

describe("a vendor contract's partner", () => {
  const vendorAt = (vendorId: string) => ({ params: Promise.resolve({ orgId: orgA, projectId: p1, vendorId }) });
  const newVendor = () => prisma.contract.create({ data: { orgId: orgA, projectId: p1, partnerId: partnerA, title: "Sub" } });

  it("refuses another org's partner, and neither the contract nor their partner changes", async () => {
    h.ctx = session();
    const v = await newVendor();
    const res = await patchVendor(json("PATCH", { partnerId: partnerB, pocName: "overwritten" }), vendorAt(v.id));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("secret@b.example.com");
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: v.id } })).partnerId).toBe(partnerA);
    expect((await prisma.partner.findUniqueOrThrow({ where: { id: partnerB } })).pocName).toBe("B person");
  });

  it("still moves to, and edits, one of the org's own partners", async () => {
    h.ctx = session();
    const v = await newVendor();
    const other = (await prisma.partner.create({ data: { orgId: orgA, name: "Other sub" } })).id;
    const res = await patchVendor(json("PATCH", { partnerId: other, pocName: "Pat" }), vendorAt(v.id));
    expect(res.status).toBe(200);
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: v.id } })).partnerId).toBe(other);
    expect((await prisma.partner.findUniqueOrThrow({ where: { id: other } })).pocName).toBe("Pat");
  });

  it("never edits a foreign partner a contract was already linked to", async () => {
    h.ctx = session();
    // As a row written before the check existed would be.
    const v = await prisma.contract.create({ data: { orgId: orgA, projectId: p1, partnerId: partnerB, title: "Old link" } });
    const res = await patchVendor(json("PATCH", { pocName: "overwritten" }), vendorAt(v.id));
    expect((await prisma.partner.findUniqueOrThrow({ where: { id: partnerB } })).pocName).toBe("B person");
    expect(await res.text()).not.toContain("secret@b.example.com");
  });
});

describe("an org contract's partner and product", () => {
  // Functions, not values: a describe body runs before beforeAll fills the ids.
  const at = () => ({ params: Promise.resolve({ orgId: orgA }) });
  const byId = (contractId: string) => ({ params: Promise.resolve({ orgId: orgA, contractId }) });

  it("create refuses another org's partner or product, and creates nothing", async () => {
    h.ctx = session();
    for (const body of [{ title: "X1", partnerId: partnerB }, { title: "X2", productId: productB }]) {
      const res = await createContract(json("POST", body), at());
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain("secret@b.example.com");
    }
    expect(await prisma.contract.count({ where: { orgId: orgA, title: { in: ["X1", "X2"] } } })).toBe(0);
  });

  it("create links the org's own partner and product", async () => {
    h.ctx = session();
    const res = await createContract(json("POST", { title: "Ours", partnerId: partnerA, productId: productA }), at());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.partner.id).toBe(partnerA);
    expect(body.product.id).toBe(productA);
  });

  it("update refuses another org's partner or product, and keeps the old link", async () => {
    h.ctx = session();
    const c = await prisma.contract.create({ data: { orgId: orgA, title: "U", partnerId: partnerA, productId: productA } });
    expect((await putContract(json("PUT", { partnerId: partnerB }), byId(c.id))).status).toBe(400);
    expect((await putContract(json("PUT", { productId: productB }), byId(c.id))).status).toBe(400);
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect([after.partnerId, after.productId]).toEqual([partnerA, productA]);
    // Positive control: clearing, and re-pointing at our own, still work.
    expect((await putContract(json("PUT", { partnerId: null, title: "U2" }), byId(c.id))).status).toBe(200);
  });

  it("a contract already linked to a foreign partner reads it back as no partner", async () => {
    h.ctx = session();
    const c = await prisma.contract.create({ data: { orgId: orgA, title: "Legacy", partnerId: partnerB, productId: productB } });
    const one = await (await getContract(json("GET"), byId(c.id))).json();
    expect(one.partner).toBeNull();
    expect(one.product).toBeNull();
    const list = await (await listContracts(new NextRequest("http://localhost/x"), at())).json();
    const row = (list as Array<{ id: string; partner: unknown }>).find((r) => r.id === c.id);
    expect(row).toBeDefined();
    expect(row!.partner).toBeNull();
    expect(JSON.stringify(list)).not.toContain("secret@b.example.com");
  });

  it("the other org's partner and product pages don't list our contract", async () => {
    await prisma.contract.create({ data: { orgId: orgA, title: "Planted on B", partnerId: partnerB, productId: productB } });
    h.ctx = { ...session(), userId: ownerB, orgId: orgB };
    const partner = await (await getPartner(json("GET"), { params: Promise.resolve({ orgId: orgB, partnerId: partnerB }) })).json();
    const product = await (await getProduct(json("GET"), { params: Promise.resolve({ orgId: orgB, productId: productB }) })).json();
    expect(partner.id).toBe(partnerB);
    expect(product.id).toBe(productB);
    expect(JSON.stringify(partner.contracts)).not.toContain("Planted on B");
    expect(JSON.stringify(product.contracts)).not.toContain("Planted on B");
    // Positive control: their own contract on the same partner still lists.
    await prisma.contract.create({ data: { orgId: orgB, title: "B's own", partnerId: partnerB, productId: productB } });
    const again = await (await getPartner(json("GET"), { params: Promise.resolve({ orgId: orgB, partnerId: partnerB }) })).json();
    expect(JSON.stringify(again.contracts)).toContain("B's own");
  });
});

// ─── Work items ───────────────────────────────────────────────────────────

describe("a work item's parent, interval and type", () => {
  const inP1 = () => ({ params: Promise.resolve({ orgId: orgA, projectId: p1 }) });
  const itemAt = (itemId: string) => ({ params: Promise.resolve({ orgId: orgA, projectId: p1, itemId }) });
  const base = () => ({ title: `t-${Math.random().toString(36).slice(2, 7)}`, columnKey: "todo", workItemTypeId: typeTask });
  const p1Item = () => createFixtureWorkItem({ orgId: orgA, projectId: p1, workItemTypeId: typeTask, createdById: owner, title: "mine", columnKey: "todo" });

  // The last column is the update's refusal: the workflow gate has long
  // answered 404 for another org's type, and that contract is kept.
  const FOREIGN: Array<[string, () => Record<string, string>, number]> = [
    ["a parent in another org", () => ({ parentId: itemB }), 400],
    ["a parent in another project", () => ({ parentId: itemP2 }), 400],
    ["an interval in another org", () => ({ intervalId: sprintB }), 400],
    ["an interval in another project", () => ({ intervalId: sprintP2 }), 400],
    ["another org's work item type", () => ({ workItemTypeId: typeB }), 404],
  ];

  it.each(FOREIGN)("create refuses %s, and creates nothing", async (_label, ref) => {
    h.ctx = session();
    const body = { ...base(), ...ref() };
    const res = await createItem(json("POST", body), inP1());
    expect(res.status).toBe(400);
    expect(await prisma.workItem.count({ where: { orgId: orgA, title: body.title } })).toBe(0);
  });

  it("create accepts a parent and an interval of the same project", async () => {
    h.ctx = session();
    const parent = await p1Item();
    const res = await createItem(json("POST", { ...base(), parentId: parent.id, intervalId: sprintP1 }), inP1());
    expect(res.status).toBe(201);
    const created = await res.json();
    expect([created.parentId, created.intervalId]).toEqual([parent.id, sprintP1]);
  });

  it.each(FOREIGN)("update refuses %s, and the item keeps its values", async (_label, ref, status) => {
    h.ctx = session();
    const item = await p1Item();
    const res = await putItem(json("PUT", ref()), itemAt(item.id));
    expect(res.status).toBe(status);
    const after = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect([after.parentId, after.intervalId, after.workItemTypeId]).toEqual([null, null, typeTask]);
  });

  it("update accepts a parent and an interval of the same project", async () => {
    h.ctx = session();
    const [item, parent] = [await p1Item(), await p1Item()];
    const res = await putItem(json("PUT", { parentId: parent.id, intervalId: sprintP1 }), itemAt(item.id));
    expect(res.status).toBe(200);
    const after = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect([after.parentId, after.intervalId]).toEqual([parent.id, sprintP1]);
  });

  it("bulk update refuses a sprint of another project, and moves nothing", async () => {
    h.ctx = session();
    const [a, b] = [await p1Item(), await p1Item()];
    const res = await bulkPut(json("PUT", { ids: [a.id, b.id], update: { intervalId: sprintP2 } }), inP1());
    expect(res.status).toBe(400);
    expect(await prisma.workItem.count({ where: { id: { in: [a.id, b.id] }, intervalId: { not: null } } })).toBe(0);
    // Positive control: this project's sprint moves both.
    expect((await bulkPut(json("PUT", { ids: [a.id, b.id], update: { intervalId: sprintP1 } }), inP1())).status).toBe(200);
    expect(await prisma.workItem.count({ where: { id: { in: [a.id, b.id] }, intervalId: sprintP1 } })).toBe(2);
  });

  it("an item already parented under a foreign item shows no parent, and the foreign item no children", async () => {
    h.ctx = session();
    const planted = await createFixtureWorkItem({ orgId: orgA, projectId: p1, workItemTypeId: typeTask, createdById: owner, title: "planted", columnKey: "todo" });
    // Written straight to the table, as a row from before the check would be.
    await prisma.$executeRaw`UPDATE work_items SET parent_id = ${itemB}::uuid WHERE id = ${planted.id}::uuid`;
    const list = await (await listItems(new NextRequest(`http://localhost/x`), inP1())).json();
    const row = (list as Array<{ id: string; parent: unknown }>).find((r) => r.id === planted.id);
    expect(row).toBeDefined();
    expect(row!.parent).toBeNull();
    expect(JSON.stringify(list)).not.toContain("B secret title");
    const detail = await (await getItem(new NextRequest("http://localhost/x"), itemAt(planted.id))).json();
    expect(JSON.stringify(detail)).not.toContain("B secret title");

    h.ctx = { ...session(), userId: ownerB, orgId: orgB };
    const theirs = await (await listItems(new NextRequest(`http://localhost/x`), { params: Promise.resolve({ orgId: orgB, projectId: pB }) })).json();
    const parent = (theirs as Array<{ id: string; children: Array<{ id: string }> }>).find((r) => r.id === itemB);
    expect(parent).toBeDefined();
    expect(parent!.children.map((c) => c.id)).not.toContain(planted.id);
  });
});

describe("the assistant's work-item tools", () => {
  const tool = () => ({ orgId: orgA, userId: owner, auth: session() });

  it("create refuses a parent or an interval outside the project, and creates nothing", async () => {
    for (const ref of [{ parentId: itemB }, { parentId: itemP2 }, { intervalId: sprintP2 }, { workItemTypeId: typeB }]) {
      const title = `ai-${Math.random().toString(36).slice(2, 7)}`;
      const out = (await aiCreate({ projectId: p1, title, ...ref }, tool())) as { error?: string };
      expect(out.error).toBeTruthy();
      expect(await prisma.workItem.count({ where: { orgId: orgA, title } })).toBe(0);
    }
    const ok = (await aiCreate({ projectId: p1, title: "ai ok", intervalId: sprintP1 }, tool())) as { created?: boolean };
    expect(ok.created).toBe(true);
  });

  it("update refuses a parent or an interval outside the project, and changes nothing", async () => {
    const item = await createFixtureWorkItem({ orgId: orgA, projectId: p1, workItemTypeId: typeTask, createdById: owner, title: "ai upd", columnKey: "todo" });
    for (const ref of [{ parentId: itemB }, { parentId: itemP2 }, { intervalId: sprintB }]) {
      const out = (await aiUpdate({ itemId: item.id, ...ref }, tool())) as { error?: string };
      expect(out.error).toBeTruthy();
    }
    const after = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect([after.parentId, after.intervalId]).toEqual([null, null]);
    const ok = (await aiUpdate({ itemId: item.id, intervalId: sprintP1 }, tool())) as { error?: string };
    expect(ok.error).toBeUndefined();
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } })).intervalId).toBe(sprintP1);
  });
});
