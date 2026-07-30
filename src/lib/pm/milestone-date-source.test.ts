import { describe, it, expect } from "vitest";
import { milestoneDateSource } from "./schedule";

/**
 * A milestone marks the delivery of ONE ticket, so its date is that ticket's
 * planned end — not a second number someone has to keep in step.
 *
 * They had already drifted on production: two milestones read 2026-08-10 and
 * 2026-08-23 while the tickets they mark were planned for 2026-09-25. Nothing
 * was wrong with either number; there were simply two of them.
 *
 * The rule is deliberately narrow, because widening it means GUESSING which
 * ticket owns a date — and a wrong guess silently moves a schedule date on a
 * customer schedule.
 */
const d = (iso: string) => new Date(iso);

describe("milestoneDateSource", () => {
  it("follows the ticket when there is exactly one link", () => {
    const src = milestoneDateSource(
      [{ workItemId: "wi-1" }],
      new Map([["wi-1", d("2026-09-25T00:00:00Z")]]),
    );
    expect(src).toEqual({ workItemId: "wi-1", dueDate: d("2026-09-25T00:00:00Z") });
  });

  it("declines when the milestone has no links — it owns its date", () => {
    // 7 of the 20 milestones on production.
    expect(milestoneDateSource([], new Map())).toBeNull();
  });

  it("declines when several tickets are linked rather than picking one", () => {
    // Choosing among them would be a guess, and guessing wrong moves a date
    // nobody asked to move. Better to leave the milestone owning its own.
    const src = milestoneDateSource(
      [{ workItemId: "wi-1" }, { workItemId: "wi-2" }],
      new Map([
        ["wi-1", d("2026-09-25T00:00:00Z")],
        ["wi-2", d("2026-10-01T00:00:00Z")],
      ]),
    );
    expect(src).toBeNull();
  });

  it("declines when the linked ticket has no planned end", () => {
    // Nothing to follow — following would blank the milestone's date.
    expect(milestoneDateSource([{ workItemId: "wi-1" }], new Map([["wi-1", null]]))).toBeNull();
  });

  it("declines when the linked ticket is missing from the map", () => {
    // e.g. the item is outside the caller's scope; absence must not throw or
    // be read as "no date".
    expect(milestoneDateSource([{ workItemId: "gone" }], new Map())).toBeNull();
  });

  it("reproduces the production drift case", () => {
    // The reported case: the milestone said 08-10, its
    // ticket says 09-25. The ticket wins.
    const src = milestoneDateSource(
      [{ workItemId: "wi-reported" }],
      new Map([["wi-reported", d("2026-09-25T00:00:00Z")]]),
    );
    expect(src?.dueDate.toISOString().slice(0, 10)).toBe("2026-09-25");
  });
});

/**
 * The rule above is pure; this pins the WRITE path that consumes it — the half
 * that fails silently if it regresses.
 *
 * If the PATCH wrote the milestone's own `dueDate` while the date is derived
 * from a ticket, the edit would be overwritten by the derivation on the very
 * next read: the user sees it "work", then revert. So the route must (a)
 * redirect the write to the linked work item and (b) NOT write the milestone
 * row in that case.
 */
import { readFileSync } from "node:fs";

describe("milestone date write-through", () => {
  const SRC =
    "src/app/api/v1/orgs/[orgId]/projects/[projectId]/milestones/[milestoneId]/route.ts";
  const src = readFileSync(SRC, "utf8");

  it("redirects a date edit to the linked work item", () => {
    expect(src).toMatch(/prisma\.workItem\.update\(\{[\s\S]{0,200}dueDate/);
  });

  it("only redirects when the milestone follows exactly one ticket", () => {
    expect(src).toMatch(/existing\.links\.length === 1/);
  });

  it("does not also write the milestone's own date when redirected", () => {
    // Without this the derivation and the stored value disagree, and the stored
    // one loses on the next read — the silent-revert bug.
    expect(src).toMatch(/dateWrittenToWorkItemId === null && \{ dueDate/);
  });

  it("loads the links it branches on", () => {
    // Guards a subtle break: without the include, `links` is undefined and the
    // branch never fires, so every edit quietly writes the milestone again.
    //
    // Scoped to loadMilestone deliberately — a bare search for the include
    // matched the one on `milestone.update` further down and passed against
    // the mutation, which is how this was caught.
    const i = src.indexOf("function loadMilestone");
    expect(i).toBeGreaterThan(-1);
    const loader = src.slice(i, src.indexOf("}", src.indexOf("});", i)));
    expect(loader).toMatch(/include: \{ links: true \}/);
  });
});
