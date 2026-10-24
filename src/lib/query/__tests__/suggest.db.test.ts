// (e2e DB) Suggestions are scoped like the resolver: nothing restricted is ever
// offered, and every `insert` reads back as the value it names.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { suggestValues } from "../suggest.server";
import { seedWorld, type World } from "./cql-fixture";

describe("suggestValues (e2e DB)", () => {
  let w: World;
  beforeAll(async () => {
    w = await seedWorld();
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
  });
  const s = (field: string, prefix = "", limit = 20) => suggestValues(w.ctx(), { field, prefix, limit });
  const labels = async (field: string, prefix = "", kind?: string) =>
    (await s(field, prefix)).filter((x) => !kind || x.kind === kind).map((x) => x.label);

  it("never offers anything from a restricted project", async () => {
    const all = JSON.stringify([
      await s("sprint", "S"),
      await s("team"),
      await s("project"),
      await s("status", "S"),
      await s("key", "Secret"),
      await s("parent", w.P2.key + "-"),
      await s("assignee", "Ghost"),
    ]);
    for (const secret of w.secrets.filter((x) => !x.startsWith("Ghost"))) expect(all).not.toContain(secret);
  });

  it("sprints, teams and projects from readable projects, with context", async () => {
    expect(await labels("sprint", "Sprint")).toEqual(expect.arrayContaining(["Sprint 1", "Sprint 0", "Sprint 2"]));
    expect(await labels("team", "", "team")).toEqual(["Platform"]);
    expect((await labels("project", "", "project")).sort()).toEqual([w.P1.key, w.P3.key].sort());
    const sprint = (await s("sprint", "Sprint 1"))[0];
    expect(sprint.detail).toContain(w.P1.key);
  });

  it("statuses come from the project: one no board shows is offered, a ceremony prompt and an archived status are not", async () => {
    const { prisma } = await import("@/lib/db/client");
    await prisma.workflowStatus.createMany({
      data: [
        { orgId: w.orgA, projectId: w.P1.id, key: "blocked", name: "Blocked", category: "IN_PROGRESS", sortOrder: 50 },
        { orgId: w.orgA, projectId: w.P1.id, key: "old", name: "Old lane", category: "TODO", sortOrder: 51, archivedAt: new Date() },
      ],
    });
    const board = await prisma.board.create({ data: { orgId: w.orgA, projectId: w.P1.id, name: "Retro", type: "SPRINT_REVIEW" } });
    await prisma.boardColumn.create({ data: { boardId: board.id, key: "went-well", name: "Went well", category: "TODO", sortOrder: 0 } });
    try {
      const got = await labels("status", "", "status");
      expect(got).toContain("Blocked");
      expect(got).not.toContain("Went well");
      expect(got).not.toContain("Old lane");
    } finally {
      await prisma.board.delete({ where: { id: board.id } });
      await prisma.workflowStatus.deleteMany({ where: { projectId: w.P1.id, key: { in: ["blocked", "old"] } } });
    }
  });

  it("people: two with one name are inserted by email; me comes first", async () => {
    const alex = await s("assignee", "Alex");
    expect(alex).toHaveLength(2);
    expect(alex.every((a) => a.insert.includes("@"))).toBe(true);
    expect((await s("assignee", "Bob"))[0].insert).toBe('"Bob Builder"');
    expect((await s("assignee", "m"))[0]).toMatchObject({ label: "me", insert: "me", kind: "function" });
  });

  it("enums, functions and EMPTY by field", async () => {
    expect(await labels("priority", "h")).toEqual(["HIGH"]);
    expect(await labels("sprint", "open")).toEqual(["openSprints()"]);
    expect(await labels("due", "start")).toEqual(expect.arrayContaining(["startOfDay()", "startOfWeek()"]));
    expect(await labels("assignee", "EMP")).toEqual(["EMPTY"]);
    expect(await labels("reporter", "EMP")).toEqual([]);
    expect(await labels("Severity")).toEqual(["S1", "S2", "S3"]);
  });

  it("items by key or by title", async () => {
    expect(await labels("parent", `${w.P1.key}-1`)).toEqual([`${w.P1.key}-1`]);
    expect((await s("parent", "login"))[0].detail).toBe("p1-login-bug");
  });

  it("quotes what would not read back bare", async () => {
    expect((await s("sprint", "Sprint 1"))[0].insert).toBe('"Sprint 1"');
    expect((await s("label", "auth"))[0].insert).toBe("auth");
  });
});
