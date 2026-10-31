// @vitest-environment node
//
// Scoping CDRL item numbers to contracts, while keeping today's guarantee for
// unassigned deliverables, creates one new way to fail: deleting a contract
// detaches its deliverables, and a detached row can collide with the partial
// unique index on `(org_id, code) WHERE contract_id IS NULL`.
//
// Postgres raises that from inside the FK's own cascade UPDATE, so the caller
// sees a duplicate-key error about a constraint on a table they never named.
// It fails SAFE — nothing is lost — but the message is useless. These pin the
// detection, both ways.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { clashingCodesOnContractDetach } from "./deliverable-scope";

let orgId = "";
let projectId = "";
let contractId = "";

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  orgId = (await prisma.organization.create({ data: { name: `dt ${stamp}`, slug: `dt-${stamp}` } })).id;
  projectId = (await prisma.project.create({
    data: { orgId, name: "D", key: `DT${stamp.slice(-4).toUpperCase()}` },
  })).id;
  contractId = (await prisma.contract.create({
    data: { orgId, projectId, title: "Base year" },
  })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
});

describe("detaching a contract's deliverables", () => {
  it("reports nothing when no unassigned deliverable holds the same code", async () => {
    await prisma.deliverable.create({ data: { orgId, projectId, contractId, code: "A-100", title: "safe" } });
    expect(await clashingCodesOnContractDetach(orgId, contractId)).toEqual([]);
  });

  it("names the code that would collide", async () => {
    await prisma.deliverable.create({ data: { orgId, projectId, contractId, code: "A-200", title: "on contract" } });
    await prisma.deliverable.create({ data: { orgId, projectId, code: "A-200", title: "unassigned" } });

    expect(await clashingCodesOnContractDetach(orgId, contractId)).toEqual(["A-200"]);
    // Control: A-100 is still attached and still has no unassigned twin, so
    // this is detecting the collision rather than every attached row.
    expect(await clashingCodesOnContractDetach(orgId, contractId)).not.toContain("A-100");
  });

  it("the collision it predicts is real: the delete is refused and nothing is lost", async () => {
    await expect(prisma.contract.delete({ where: { id: contractId } })).rejects.toThrow();

    // Fails safe — both rows survive and the contract is still there.
    const rows = await prisma.deliverable.findMany({ where: { orgId, code: "A-200" }, select: { contractId: true } });
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.contractId === contractId)).toHaveLength(1);
    expect(await prisma.contract.findUnique({ where: { id: contractId } })).not.toBeNull();
  });

  it("and once the clash is cleared, the delete goes through", async () => {
    // The positive control for the whole file: without this, "delete is
    // refused" could be true for some unrelated reason.
    await prisma.deliverable.deleteMany({ where: { orgId, code: "A-200", contractId: null } });
    expect(await clashingCodesOnContractDetach(orgId, contractId)).toEqual([]);

    await prisma.contract.delete({ where: { id: contractId } });
    const survivors = await prisma.deliverable.findMany({ where: { orgId }, select: { contractId: true } });
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.every((r) => r.contractId === null)).toBe(true); // detached, not deleted
  });
});
