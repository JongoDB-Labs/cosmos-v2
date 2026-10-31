// (e2e DB) `sprint` and `pi` are two CQL fields over ONE entity, and they mean
// different halves of it: `pi` is "items in this PI or any sprint inside it", so
// only a PROGRAM_INCREMENT is a legal value, while `sprint` means the contained
// timeboxes. The suggestion query scoped by org and readable projects only, so
// both pickers offered every interval in the org, and the detail line named the
// project and the status but never the KIND — leaving a PI, a sprint and a phase
// indistinguishable in a flat list. Reported as "why don't we just have an
// interval filter that I can choose, specific intervals, such as named PIs,
// sprints, or phases".
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { suggestValues } from "../suggest.server";
import { seedWorld, type World } from "./cql-fixture";

describe("interval suggestions are scoped to the asking field's kind (e2e DB)", () => {
  let w: World;
  // Numbers well clear of the fixture's 1–3, which are unique per project.
  const PI_NAME = "PI 2026.4";
  const PHASE_NAME = "Hardening phase";

  beforeAll(async () => {
    w = await seedWorld();
    await prisma.interval.create({
      data: {
        orgId: w.orgA, projectId: w.P1.id, number: 901, name: PI_NAME,
        intervalKind: "PROGRAM_INCREMENT", status: "ACTIVE",
        startDate: new Date("2026-10-01"), endDate: new Date("2026-12-24"),
      },
    });
    await prisma.interval.create({
      data: {
        orgId: w.orgA, projectId: w.P1.id, number: 902, name: PHASE_NAME,
        intervalKind: "PHASE", status: "PLANNED",
        startDate: new Date("2026-11-01"), endDate: new Date("2026-11-30"),
      },
    });
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
  });

  const labels = async (field: string, prefix = "") =>
    (await suggestValues(w.ctx(), { field, prefix, limit: 50 }))
      .filter((x) => x.kind === "sprint")
      .map((x) => x.label);

  it("`pi` offers program increments and nothing else", async () => {
    const got = await labels("pi");
    expect(got).toContain(PI_NAME);
    expect(got).not.toContain(PHASE_NAME);
    expect(got).not.toContain("Sprint 1");
    expect(got).toEqual([PI_NAME]);
  });

  it("`sprint` offers the contained timeboxes, never the PI that holds them", async () => {
    const got = await labels("sprint");
    expect(got).toContain("Sprint 1");
    // A phase IS a timebox a ticket is planned into, so it belongs here.
    expect(got).toContain(PHASE_NAME);
    expect(got).not.toContain(PI_NAME);
  });

  it("names the kind in the detail, so a phase reads apart from a sprint", async () => {
    const rows = await suggestValues(w.ctx(), { field: "sprint", prefix: "", limit: 50 });
    const phase = rows.find((r) => r.label === PHASE_NAME);
    const sprint = rows.find((r) => r.label === "Sprint 1");
    expect(phase?.detail).toBe(`${w.P1.key} · phase · planned`);
    expect(sprint?.detail).toContain("· sprint ·");
    // The project and status it already carried are still there.
    expect(sprint?.detail).toContain(w.P1.key);
  });

  it("still refuses an interval in a project the actor cannot read", async () => {
    const all = JSON.stringify([await labels("pi"), await labels("sprint")]);
    for (const secret of w.secrets.filter((x) => !x.startsWith("Ghost"))) {
      expect(all).not.toContain(secret);
    }
  });
});
