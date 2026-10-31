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
import { getEntityDef, guessFieldForHeader } from "./entity-fields";

let orgId = "";
let projectId = "";
let sprintId = "";
/** A sprint in ANOTHER project: a name in this project must never reach it. */
let foreignSprintId = "";

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  orgId = (await prisma.organization.create({ data: { name: `del ${stamp}`, slug: `del-${stamp}` } })).id;
  projectId = (await prisma.project.create({
    data: { orgId, name: "D", key: `DL${stamp.slice(-4).toUpperCase()}` },
  })).id;
  sprintId = (await prisma.interval.create({
    data: {
      orgId, projectId, number: 1, name: "Sprint 3",
      startDate: new Date("2026-01-05"), endDate: new Date("2026-01-19"),
    },
  })).id;
  const otherProjectId = (await prisma.project.create({
    data: { orgId, name: "Other", key: `OT${stamp.slice(-4).toUpperCase()}` },
  })).id;
  foreignSprintId = (await prisma.interval.create({
    data: {
      orgId, projectId: otherProjectId, number: 1, name: "Elsewhere",
      startDate: new Date("2026-01-05"), endDate: new Date("2026-01-19"),
    },
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

// ── CDRL columns: PI objective, due gate and the sprint ─────────────────────
//
// The planning workbook these come from has a "Sprint" column holding a sprint
// NAME, while `deliverables.interval_id` is a uuid. The resolution happens in
// the engine (resolveLookups), not in the pure coercer, so it needs a database
// to mean anything — hence a db test and not a unit test.
describe("entity import — deliverables: CDRL columns", () => {
  it("imports the PI objective and the due gate as free text", async () => {
    const report = await runEntityImport(
      { orgId, projectId },
      {
        entity: "deliverable",
        mode: "commit",
        mapping: {
          ID: "code",
          "CDRL opportunity": "title",
          "PI Objective": "piObjective",
          "Due gate": "dueGate",
        },
        rows: [{
          ID: "CDRL-B001",
          "CDRL opportunity": "Quarterly data pack",
          "PI Objective": "Reduce reporting turnaround",
          "Due gate": "SD-1",
        }],
      },
    );

    expect(report.errors).toEqual([]);
    expect(report.created).toBe(1);
    const row = await prisma.deliverable.findFirst({
      where: { orgId, projectId, code: "CDRL-B001" },
      select: { title: true, piObjective: true, dueGate: true },
    });
    expect(row).not.toBeNull();
    expect(row!.title).toBe("Quarterly data pack");
    expect(row!.piObjective).toBe("Reduce reporting turnaround");
    expect(row!.dueGate).toBe("SD-1");
  });

  it("resolves the Sprint column to an interval id by NAME, within the project", async () => {
    const report = await runEntityImport(
      { orgId, projectId },
      {
        entity: "deliverable",
        mode: "commit",
        // Mixed case + padding: name matching must be as forgiving as the rest
        // of the importer, and must not depend on the sheet's capitalisation.
        mapping: { ID: "code", Title: "title", Sprint: "intervalId" },
        rows: [{ ID: "CDRL-B002", Title: "Planned work", Sprint: "  SPRINT 3 " }],
      },
    );

    expect(report.errors).toEqual([]);
    const row = await prisma.deliverable.findFirst({
      where: { orgId, projectId, code: "CDRL-B002" },
      select: { intervalId: true },
    });
    expect(row!.intervalId).toBe(sprintId);
  });

  it("warns and leaves the sprint blank when the name is not in THIS project", async () => {
    // "Elsewhere" is a real interval, in another project of the same org. It
    // must not resolve — a CDRL cannot be planned into another project's sprint.
    const report = await runEntityImport(
      { orgId, projectId },
      {
        entity: "deliverable",
        mode: "commit",
        mapping: { ID: "code", Title: "title", Sprint: "intervalId" },
        rows: [
          { ID: "CDRL-B003", Title: "Unresolvable sprint", Sprint: "Elsewhere" },
          // POSITIVE CONTROL in the same import: the probe can see a sprint
          // when there IS one, so the null above is the lookup failing and not
          // the field never being written.
          { ID: "CDRL-B004", Title: "Resolvable sprint", Sprint: "Sprint 3" },
        ],
      },
    );

    expect(report.errors).toEqual([
      { row: 1, message: 'Sprint: "Elsewhere" is not a sprint in this project — left blank' },
    ]);
    // Non-blocking: both rows still imported.
    expect(report.created).toBe(2);

    const rows = await prisma.deliverable.findMany({
      where: { orgId, projectId, code: { in: ["CDRL-B003", "CDRL-B004"] } },
      select: { code: true, intervalId: true },
      orderBy: { code: "asc" },
    });
    expect(rows.map((r) => [r.code, r.intervalId])).toEqual([
      ["CDRL-B003", null],
      ["CDRL-B004", sprintId],
    ]);
    // And the foreign sprint was never written anywhere.
    expect(rows.some((r) => r.intervalId === foreignSprintId)).toBe(false);
  });

  it('maps the sheet word "Planned" to NOT_STARTED, but refuses to flatten a backlog marker', async () => {
    // Both rows start from a status the sheet cannot produce, so "unchanged"
    // and "set to NOT_STARTED" are distinguishable. Creating them instead would
    // make the two outcomes identical: the column defaults to NOT_STARTED.
    await prisma.deliverable.createMany({
      data: [
        { orgId, projectId, code: "CDRL-B005", title: "Planned row", status: "SUBMITTED" },
        { orgId, projectId, code: "CDRL-B006", title: "Proposed row", status: "SUBMITTED" },
      ],
    });

    const report = await runEntityImport(
      { orgId, projectId },
      {
        entity: "deliverable",
        mode: "commit",
        // Title is mapped because the registry marks it required — an import
        // that omits it skips every row before status is ever considered.
        mapping: { ID: "code", Title: "title", Status: "status" },
        rows: [
          // POSITIVE CONTROL: the synonym path works…
          { ID: "CDRL-B005", Title: "Planned row", Status: "Planned" },
          // …and this is the value that must NOT be mapped. "Proposed · PI-3"
          // says "not in this PI" — a scheduling decision, not a lifecycle
          // state. Flattening it to NOT_STARTED would assert something false.
          { ID: "CDRL-B006", Title: "Proposed row", Status: "Proposed · PI-3" },
        ],
      },
    );

    expect(report.updated).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].row).toBe(2);
    expect(report.errors[0].message).toContain('Status: "Proposed · PI-3" is not a recognized value');

    const rows = await prisma.deliverable.findMany({
      where: { orgId, projectId, code: { in: ["CDRL-B005", "CDRL-B006"] } },
      select: { code: true, status: true },
      orderBy: { code: "asc" },
    });
    expect(rows).toEqual([
      { code: "CDRL-B005", status: "NOT_STARTED" },
      // Untouched: the warning left the column alone rather than writing a
      // status the sheet never claimed.
      { code: "CDRL-B006", status: "SUBMITTED" },
    ]);
  });

  it("creates its own row rather than updating a CONTRACT's deliverable with the same code", async () => {
    // The import never assigns a contract, so its idempotency is scoped to the
    // unassigned rows — the same scope as the partial unique index that now
    // backs them. Without that scope, re-importing a register would silently
    // overwrite a contract-scoped CDRL that happens to share an item number.
    const contract = await prisma.contract.create({
      data: { orgId, projectId, title: "Agreement" },
    });
    await prisma.deliverable.create({
      data: { orgId, projectId, contractId: contract.id, code: "ITEM-SHARED", title: "Under contract" },
    });

    const report = await runEntityImport(
      { orgId, projectId },
      {
        entity: "deliverable",
        mode: "commit",
        mapping: { ID: "code", Title: "title" },
        rows: [{ ID: "ITEM-SHARED", Title: "From the sheet" }],
      },
    );

    expect(report.created).toBe(1);
    expect(report.updated).toBe(0);
    const rows = await prisma.deliverable.findMany({
      where: { orgId, projectId, code: "ITEM-SHARED" },
      select: { title: true, contractId: true },
      orderBy: { title: "asc" },
    });
    expect(rows).toEqual([
      { title: "From the sheet", contractId: null },
      // Untouched — the control for the assertion above.
      { title: "Under contract", contractId: contract.id },
    ]);
  });

  it("auto-maps the workbook's own column titles", async () => {
    // The mapping UI guesses from the header text on upload. If these synonyms
    // are wrong the columns land on IGNORE and the import silently drops them,
    // which no amount of engine testing would show.
    const def = getEntityDef("deliverable")!;
    const guessed = Object.fromEntries(
      [
        "ID", "CDRL opportunity", "What it contains", "Feature / story",
        "PI Objective", "Sprint", "Due gate", "Due date", "Status", "Owner", "Notes",
      ].map((h) => [h, guessFieldForHeader(def, h)]),
    );
    expect(guessed).toEqual({
      ID: "code",
      "CDRL opportunity": "title",
      "What it contains": "description",
      "Feature / story": "workItemRef",
      "PI Objective": "piObjective",
      Sprint: "intervalId",
      "Due gate": "dueGate",
      "Due date": "baselineDue",
      Status: "status",
      Owner: "owner",
      Notes: "notes",
    });
    // The two columns that must NOT be imported: "Days to due" is derived from
    // the due date and "Added" is a provenance marker, so storing either would
    // keep a second, rotting copy of something.
    expect(guessFieldForHeader(def, "Days to due")).toBe("");
    expect(guessFieldForHeader(def, "Added")).toBe("");
  });
});
