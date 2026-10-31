// @vitest-environment node
//
// A deliverable's code is unique within its CONTRACT, and the rows with no
// contract keep exactly the uniqueness they had before contract scoping.
//
// Those are two separate promises enforced by two different indexes, and the
// second one is easy to lose. `@@unique([orgId, contractId, code])` is the only
// half Prisma can express, and in Postgres NULLs are distinct — so it says
// nothing at all about the rows where contract_id IS NULL, which is every row
// that predates this change. The partial index
// `deliverables_org_code_unassigned_key` (migration 20261031120000, SQL only)
// is what covers them. Dropping it would make this file fail and nothing else.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { assertDeliverableLinks } from "./deliverable-scope";

let orgId = "";
let projectId = "";
let otherProjectId = "";
let contractA = "";
let contractB = "";
let unlinkedContract = "";
let otherProjectContract = "";
let sprintId = "";
let foreignSprintId = "";

/**
 * The unique-violation code and the index Postgres named, or a rethrow.
 *
 * The index name comes out of `message`, not `meta.target` — this Prisma
 * version leaves `meta.target` undefined for a violation raised by a plain
 * index (as both of these are), and asserting on the code ALONE would not
 * distinguish the two halves this file exists to tell apart.
 */
function uniqueViolation(e: unknown): { code: string; message: string } {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    return { code: e.code, message: e.message };
  }
  throw e;
}

const deliverable = (code: string, contractId: string | null) =>
  prisma.deliverable.create({
    data: { orgId, projectId, contractId, code, title: `Item ${code}` },
    select: { id: true },
  });

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  orgId = (await prisma.organization.create({
    data: { name: `cdrl ${stamp}`, slug: `cdrl-${stamp}` },
  })).id;
  projectId = (await prisma.project.create({
    data: { orgId, name: "One", key: `C1${stamp.slice(-4).toUpperCase()}` },
  })).id;
  otherProjectId = (await prisma.project.create({
    data: { orgId, name: "Two", key: `C2${stamp.slice(-4).toUpperCase()}` },
  })).id;
  [contractA, contractB] = await Promise.all([
    prisma.contract.create({ data: { orgId, projectId, title: "Contract A" } }).then((c) => c.id),
    prisma.contract.create({ data: { orgId, projectId, title: "Contract B" } }).then((c) => c.id),
  ]);
  unlinkedContract = (await prisma.contract.create({
    data: { orgId, title: "Not yet tied to a project" },
  })).id;
  otherProjectContract = (await prisma.contract.create({
    data: { orgId, projectId: otherProjectId, title: "Contract for the other project" },
  })).id;
  sprintId = (await prisma.interval.create({
    data: {
      orgId, projectId, number: 1, name: "S1",
      startDate: new Date("2026-02-02"), endDate: new Date("2026-02-16"),
    },
  })).id;
  foreignSprintId = (await prisma.interval.create({
    data: {
      orgId, projectId: otherProjectId, number: 1, name: "S1",
      startDate: new Date("2026-02-02"), endDate: new Date("2026-02-16"),
    },
  })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
});

describe("deliverable code uniqueness", () => {
  it("lets two contracts each carry the same item number", async () => {
    const a = await deliverable("ITEM-01", contractA);
    const b = await deliverable("ITEM-01", contractB);
    expect(a.id).not.toBe(b.id);

    const rows = await prisma.deliverable.findMany({
      where: { orgId, code: "ITEM-01" },
      select: { contractId: true },
    });
    expect(rows.map((r) => r.contractId).sort()).toEqual([contractA, contractB].sort());
  });

  it("still refuses the same item number TWICE under one contract", async () => {
    // The positive control for the test above: the new constraint is not inert,
    // it moved. Without this, "two contracts may reuse a code" is satisfied by
    // having no constraint at all.
    await deliverable("ITEM-02", contractA);
    const violation = await deliverable("ITEM-02", contractA).then(
      () => null,
      (e: unknown) => uniqueViolation(e),
    );
    expect(violation?.code).toBe("P2002");
    expect(violation?.message).toContain("deliverables_org_id_contract_id_code_key");
  });

  it("refuses a second deliverable with the same code and NO contract", async () => {
    // The half Prisma cannot express. Every deliverable that existed before
    // contract scoping is one of these rows.
    const first = await deliverable("ITEM-03", null);
    expect(first.id).toBeTruthy(); // positive control: the probe can insert one

    const violation = await deliverable("ITEM-03", null).then(
      () => null,
      (e: unknown) => uniqueViolation(e),
    );
    expect(violation?.code).toBe("P2002");
    expect(violation?.message).toContain("deliverables_org_code_unassigned_key");

    // And exactly one row exists — the rejection was a rejection, not a
    // silently-swallowed second insert.
    const rows = await prisma.deliverable.findMany({ where: { orgId, code: "ITEM-03" } });
    expect(rows).toHaveLength(1);
  });

  it("scopes both halves to the ORG, so another tenant may reuse the code", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const otherOrg = await prisma.organization.create({
      data: { name: `cdrl other ${stamp}`, slug: `cdrl-other-${stamp}` },
    });
    try {
      const otherProject = await prisma.project.create({
        data: { orgId: otherOrg.id, name: "Theirs", key: `OX${stamp.slice(-4).toUpperCase()}` },
      });
      const row = await prisma.deliverable.create({
        data: { orgId: otherOrg.id, projectId: otherProject.id, code: "ITEM-03", title: "Theirs" },
        select: { id: true },
      });
      expect(row.id).toBeTruthy();
    } finally {
      await prisma.organization.deleteMany({ where: { id: otherOrg.id } }).catch(() => undefined);
    }
  });
});

describe("deliverable links survive what they point at", () => {
  it("keeps the deliverable when its contract is deleted (SetNull)", async () => {
    const contract = await prisma.contract.create({
      data: { orgId, projectId, title: "Short-lived" },
    });
    await prisma.deliverable.create({
      data: { orgId, projectId, contractId: contract.id, code: "ITEM-04", title: "Under a doomed contract" },
    });

    await prisma.contract.delete({ where: { id: contract.id } });

    const row = await prisma.deliverable.findFirst({
      where: { orgId, code: "ITEM-04" },
      select: { contractId: true },
    });
    expect(row).not.toBeNull();
    expect(row!.contractId).toBeNull();
  });

  it("keeps the deliverable when its sprint is deleted (SetNull)", async () => {
    const sprint = await prisma.interval.create({
      data: {
        orgId, projectId, number: 99, name: "Doomed",
        startDate: new Date("2026-03-02"), endDate: new Date("2026-03-16"),
      },
    });
    await prisma.deliverable.create({
      data: { orgId, projectId, intervalId: sprint.id, code: "ITEM-05", title: "Planned into a doomed sprint" },
    });

    await prisma.interval.delete({ where: { id: sprint.id } });

    const row = await prisma.deliverable.findFirst({
      where: { orgId, code: "ITEM-05" },
      select: { intervalId: true },
    });
    expect(row).not.toBeNull();
    expect(row!.intervalId).toBeNull();
  });

  it("keeps the contract when its project is deleted (SetNull)", async () => {
    const project = await prisma.project.create({
      data: { orgId, name: "Doomed", key: `DM${Date.now().toString().slice(-6)}` },
    });
    const contract = await prisma.contract.create({
      data: { orgId, projectId: project.id, title: "Outlives its project" },
    });

    await prisma.project.delete({ where: { id: project.id } });

    const row = await prisma.contract.findUnique({
      where: { id: contract.id },
      select: { projectId: true },
    });
    expect(row).not.toBeNull();
    expect(row!.projectId).toBeNull();
  });
});

describe("assertDeliverableLinks", () => {
  it("accepts a contract and a sprint belonging to this project", async () => {
    await expect(
      assertDeliverableLinks({ contractId: contractA, intervalId: sprintId }, orgId, projectId),
    ).resolves.toBeUndefined();
  });

  it("accepts a contract that is not tied to any project yet", async () => {
    // Contract.projectId is nullable: a commercial record routinely exists
    // before it is tied to delivery, and refusing it would make the field
    // unusable for exactly the contracts a CDRL is being set up under.
    await expect(
      assertDeliverableLinks({ contractId: unlinkedContract }, orgId, projectId),
    ).resolves.toBeUndefined();
  });

  it("refuses a contract belonging to a DIFFERENT project", async () => {
    await expect(
      assertDeliverableLinks({ contractId: otherProjectContract }, orgId, projectId),
    ).rejects.toThrow(/different project/i);
  });

  it("refuses a sprint belonging to a DIFFERENT project", async () => {
    await expect(
      assertDeliverableLinks({ intervalId: foreignSprintId }, orgId, projectId),
    ).rejects.toThrow(/different project/i);
  });

  it("refuses ids from another org, and says only that they were not found", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const otherOrg = await prisma.organization.create({
      data: { name: `cdrl far ${stamp}`, slug: `cdrl-far-${stamp}` },
    });
    try {
      const theirContract = await prisma.contract.create({
        data: { orgId: otherOrg.id, title: "Theirs" },
      });
      await expect(
        assertDeliverableLinks({ contractId: theirContract.id }, orgId, projectId),
      ).rejects.toThrow(/not found/i);
    } finally {
      await prisma.organization.deleteMany({ where: { id: otherOrg.id } }).catch(() => undefined);
    }
  });

  it("allows clearing either link", async () => {
    await expect(
      assertDeliverableLinks({ contractId: null, intervalId: null }, orgId, projectId),
    ).resolves.toBeUndefined();
    await expect(assertDeliverableLinks({}, orgId, projectId)).resolves.toBeUndefined();
  });
});
