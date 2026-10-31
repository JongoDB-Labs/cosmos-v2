// @vitest-environment node
//
// The generic entity importer can actually create a deliverable.
//
// It could not. `entity-import.ts`'s create literal carried
// `branchOwner: s(fields, "branchOwner")`, and `Deliverable.branch_owner` was
// dropped by migration 20260812093000. Three things hid it:
//
//   1. `s()` returns NULL when a column is unmapped, not undefined. Prisma
//      strips `undefined` but validates `null`, so the dead key was present in
//      EVERY create — this was not "breaks if you map Branch owner", it was
//      "breaks on every row".
//   2. tsc cannot see it. Prisma's generated `XOR` input types defeat excess
//      property checking, so a key that no longer exists type-checks clean.
//   3. `dead-fields.arch.test.ts` exists to catch exactly this and does not:
//      it checks hints, a userId absence and three comment wordings, but never
//      cross-checks an ImportField key against the Prisma model.
//
// So the whole suite was green over a register import that threw at runtime.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { runEntityImport } from "./entity-import";

let orgId = "";
let projectId = "";

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  orgId = (await prisma.organization.create({ data: { name: `del ${stamp}`, slug: `del-${stamp}` } })).id;
  projectId = (await prisma.project.create({
    data: { orgId, name: "D", key: `DL${stamp.slice(-4).toUpperCase()}` },
  })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
});

describe("entity import — deliverables", () => {
  it("creates a deliverable from a mapped row", async () => {
    const report = await runEntityImport(
      { orgId, projectId },
      {
        entity: "deliverable",
        mode: "commit",
        mapping: { Code: "code", Title: "title", Owner: "owner" },
        rows: [{ Code: "CDRL-A001", Title: "Monthly status report", Owner: "A. Person" }],
      },
    );

    expect(report.errors).toEqual([]);
    expect(report.willCreate).toBe(1);

    // The report is the engine's own account of itself; the row is the fact.
    const row = await prisma.deliverable.findFirst({
      where: { orgId, projectId, code: "CDRL-A001" },
      select: { title: true, owner: true },
    });
    expect(row).not.toBeNull();
    expect(row!.title).toBe("Monthly status report");
    expect(row!.owner).toBe("A. Person");
  });

  it("updates an existing deliverable by its natural key instead of duplicating", async () => {
    // Positive control for the create above AND cover for the patch() path,
    // which carried the same dead key — conditionally, since patch() only
    // applies a pair when the caller actually mapped that column.
    await runEntityImport(
      { orgId, projectId },
      {
        entity: "deliverable",
        mode: "commit",
        mapping: { Code: "code", Title: "title" },
        rows: [{ Code: "CDRL-A002", Title: "first" }],
      },
    );
    const report = await runEntityImport(
      { orgId, projectId },
      {
        entity: "deliverable",
        mode: "commit",
        mapping: { Code: "code", Title: "title" },
        rows: [{ Code: "CDRL-A002", Title: "second" }],
      },
    );

    expect(report.errors).toEqual([]);
    expect(report.willUpdate).toBe(1);
    const rows = await prisma.deliverable.findMany({ where: { orgId, code: "CDRL-A002" }, select: { title: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("second");
  });
});
