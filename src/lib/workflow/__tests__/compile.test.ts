import { describe, it, expect } from "vitest";
import { buildOpenDefinition, compileWorkflow, openTransitionId, resolveTransition } from "../compile";
import { validateDefinition, type StatusRef, type WorkflowDefinition } from "../definition";

const wf = compileWorkflow({
  schemaVersion: 1,
  statuses: [{ key: "todo", isInitial: true }, { key: "doing" }, { key: "review" }, { key: "done" }],
  transitions: [
    { id: "start", name: "Start", from: ["todo"], to: "doing" },
    { id: "resolve", name: "Resolve", from: ["review"], to: "done" },
    { id: "fast-close", name: "Close", from: ["review"], to: "done" },
    { id: "any-done", name: "Done", from: "*", to: "done" },
    { id: "back", name: "Back to To Do", from: "*", to: "todo" },
  ],
});

describe("resolveTransition", () => {
  it("uses the unique transition between two statuses", () => {
    expect(resolveTransition(wf, { from: "todo", to: "doing" })).toMatchObject({ ok: true, transition: { id: "start" } });
  });

  it("prefers a named transition over a global one", () => {
    // todo → done has only the global transition; doing → done too.
    expect(resolveTransition(wf, { from: "doing", to: "done" })).toMatchObject({ ok: true, transition: { id: "any-done" } });
  });

  it("reports a tie between named transitions as ambiguous, listing them", () => {
    const r = resolveTransition(wf, { from: "review", to: "done" });
    expect(r).toMatchObject({ ok: false, code: "transition_ambiguous" });
    expect(r.ok === false && r.code === "transition_ambiguous" && r.candidates.map((c) => c.id)).toEqual([
      "resolve",
      "fast-close",
    ]);
  });

  it("honours an explicit transition id that fits", () => {
    expect(resolveTransition(wf, { from: "review", to: "done", transitionId: "fast-close" })).toMatchObject({
      ok: true,
      transition: { id: "fast-close" },
    });
  });

  it("refuses an explicit id that does not lead there", () => {
    expect(resolveTransition(wf, { from: "todo", to: "done", transitionId: "resolve" })).toMatchObject({
      ok: false,
      code: "transition_not_allowed",
    });
  });

  it("refuses a move with no transition, and a status outside the workflow", () => {
    expect(resolveTransition(wf, { from: "todo", to: "review" })).toMatchObject({ ok: false, code: "transition_not_allowed" });
    expect(resolveTransition(wf, { from: "todo", to: "ghost" })).toMatchObject({ ok: false, code: "transition_not_allowed" });
  });
});

describe("buildOpenDefinition (the default workflow equals today's behaviour)", () => {
  const CATEGORIES = ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"] as const;

  /** Deterministic pseudo-random status sets, so a failure reproduces. */
  function* statusSets(): Generator<(StatusRef & { name: string; sortOrder: number })[]> {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 200; n++) {
      const size = 1 + Math.floor(rand() * 10);
      yield Array.from({ length: size }, (_, i) => ({
        key: `s${n}-${i}`,
        name: `S ${i}`,
        sortOrder: Math.floor(rand() * 20),
        category: CATEGORIES[Math.floor(rand() * 4)],
        archived: rand() < 0.15,
      }));
    }
  }

  it("allows every (from, to) pair, for any set of statuses", () => {
    for (const statuses of statusSets()) {
      const compiled = compileWorkflow(buildOpenDefinition(statuses));
      for (const from of statuses) {
        for (const to of statuses) {
          const r = resolveTransition(compiled, { from: from.key, to: to.key });
          expect(r, `${from.key} → ${to.key}`).toMatchObject({ ok: true, transition: { id: openTransitionId(to.key) } });
        }
      }
    }
  });

  it("starts in the first unarchived To Do status by sort order", () => {
    const def = buildOpenDefinition([
      { key: "done", name: "Done", sortOrder: 0, category: "DONE" },
      { key: "old", name: "Old", sortOrder: 1, category: "TODO", archived: true },
      { key: "todo", name: "To Do", sortOrder: 2, category: "TODO" },
      { key: "backlog", name: "Backlog", sortOrder: 3, category: "TODO" },
    ]);
    expect(def.statuses.filter((s) => s.isInitial).map((s) => s.key)).toEqual(["todo"]);
  });

  it("passes validation for a project with To Do and Done", () => {
    const statuses = [
      { key: "todo", name: "To Do", sortOrder: 0, category: "TODO" as const },
      { key: "done", name: "Done", sortOrder: 1, category: "DONE" as const },
    ];
    const def: WorkflowDefinition = buildOpenDefinition(statuses);
    expect(validateDefinition(def, statuses)).toEqual([]);
  });
});
