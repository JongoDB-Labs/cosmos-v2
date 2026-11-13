// @vitest-environment node
//
// The spreadsheet import is the one writer that changes an existing interval's
// KIND, which is a second way to break one-level nesting: a sprint inside a
// Program Increment re-imported as a PI becomes a PI inside a PI, and a PI that
// still holds sprints re-imported as a sprint leaves them inside something that
// is not a PI. Both rows are refused with the reason, in the preview as well as
// at commit; the rest still import.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { runEntityImport } from "./entity-import";

const authFor = (userId: string, orgId: string) =>
  ({ userId, orgId, orgRole: "ADMIN", abacRules: [], permissions: -1n, basePermissions: -1n }) as unknown as import("@/lib/rbac/check").AuthContext;

let orgId = "";
let projectId = "";
let userId = "";
let piId = "";
let sprintId = "";

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  userId = (await prisma.user.create({ data: { email: `ivl-${stamp}@test.local`, displayName: "Interval Importer" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `ivl ${stamp}`, slug: `ivl-${stamp}` } })).id;
  projectId = (await prisma.project.create({ data: { orgId, name: "I", key: `IV${stamp.slice(-4).toUpperCase()}` } })).id;
  const dates = { startDate: new Date("2026-01-05"), endDate: new Date("2026-03-27") };
  piId = (await prisma.interval.create({ data: { orgId, projectId, number: 1, name: "PI 1", intervalKind: "PROGRAM_INCREMENT", ...dates } })).id;
  sprintId = (await prisma.interval.create({ data: { orgId, projectId, number: 2, name: "Sprint 1", parentId: piId, ...dates } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
});

const importKinds = (rows: { Name: string; Kind: string }[], mode: "validate" | "commit" = "commit") =>
  runEntityImport(
    { orgId, projectId, userId, auth: authFor(userId, orgId) },
    {
      entity: "interval",
      mode,
      mapping: { Name: "name", Start: "startDate", End: "endDate", Kind: "intervalKind" },
      rows: rows.map((r) => ({ ...r, Start: "2026-01-05", End: "2026-03-27" })),
    },
  );

const kindOf = async (id: string) => (await prisma.interval.findUniqueOrThrow({ where: { id } })).intervalKind;

describe("entity import — interval kind changes keep nesting one level deep", () => {
  it("refuses to turn a sprint inside a PI into a PI, and says why", async () => {
    const report = await importKinds([{ Name: "Sprint 1", Kind: "PROGRAM_INCREMENT" }]);
    expect(report.errors).toEqual([
      { row: expect.any(Number), message: "This interval is inside a Program Increment, so it can't become one. Take it out of its Program Increment first." },
    ]);
    expect(await kindOf(sprintId)).toBe("SPRINT");
  });

  it("refuses to turn a PI that still holds a sprint into a sprint", async () => {
    const report = await importKinds([{ Name: "PI 1", Kind: "SPRINT" }]);
    expect(report.errors.map((e) => e.message)).toEqual([
      "This Program Increment still has intervals inside it, so it can't change kind. Move them out first.",
    ]);
    expect(await kindOf(piId)).toBe("PROGRAM_INCREMENT");
  });

  it("the preview reports both refusals as row errors, not as updates", async () => {
    const report = await importKinds(
      [
        { Name: "Sprint 1", Kind: "PROGRAM_INCREMENT" },
        { Name: "PI 1", Kind: "SPRINT" },
      ],
      "validate",
    );
    expect(report.errors).toEqual([
      { row: expect.any(Number), message: "This interval is inside a Program Increment, so it can't become one. Take it out of its Program Increment first." },
      { row: expect.any(Number), message: "This Program Increment still has intervals inside it, so it can't change kind. Move them out first." },
    ]);
    expect(report.errors[0].row).toBeLessThan(report.errors[1].row);
    expect(report.willUpdate).toBe(0);
    expect(report.skipped).toBe(2);
    // The control: a kind change that keeps nesting one level still previews as an update.
    const allowed = await importKinds([{ Name: "Sprint 1", Kind: "PHASE" }], "validate");
    expect(allowed.errors).toEqual([]);
    expect(allowed.willUpdate).toBe(1);
  });

  it("still applies a kind change that keeps nesting one level (the positive control)", async () => {
    const report = await importKinds([{ Name: "Sprint 1", Kind: "PHASE" }]);
    expect(report.errors).toEqual([]);
    expect(report.updated).toBe(1);
    expect(await kindOf(sprintId)).toBe("PHASE");
  });
});
