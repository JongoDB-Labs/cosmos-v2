import { describe, it, expect } from "vitest";
import {
  cellState,
  excludeStatus,
  freshTransitionId,
  includeStatus,
  removeTransition,
  setGlobal,
  setInitial,
  setMove,
  upsertTransition,
} from "../draft-edit";
import type { WorkflowDefinition } from "../definition";

const base = (): WorkflowDefinition => ({
  schemaVersion: 1,
  statuses: [{ key: "todo", isInitial: true }, { key: "doing" }, { key: "done" }],
  transitions: [
    { id: "start", name: "Start", from: ["todo"], to: "doing" },
    { id: "done", name: "Done", from: "*", to: "done" },
  ],
});

describe("the matrix cell", () => {
  it("is allowed by a named or a global transition, named first", () => {
    const def = base();
    expect(cellState(def, "todo", "doing")).toMatchObject({ allowed: true, onlyGlobal: false });
    expect(cellState(def, "doing", "done")).toMatchObject({ allowed: true, onlyGlobal: true });
    expect(cellState(def, "doing", "todo").allowed).toBe(false);
  });
});

describe("setMove", () => {
  it("joins a plain transition into the status when there is one", () => {
    const def = setMove(base(), "done", "doing", true);
    expect(def.transitions.find((t) => t.id === "start")?.from).toEqual(["todo", "done"]);
    expect(def.transitions).toHaveLength(2);
  });

  it("adds a transition named after the status when the existing one has rules", () => {
    const ruled = upsertTransition(base(), { id: "start", name: "Start", from: ["todo"], to: "doing", restrict: { kind: "actorIsAssignee" } });
    const def = setMove(ruled, "done", "doing", true, () => "Doing");
    expect(def.transitions.find((t) => t.id === "start")?.from).toEqual(["todo"]);
    expect(def.transitions.find((t) => t.id === "done-to-doing")).toEqual({ id: "done-to-doing", name: "Doing", from: ["done"], to: "doing" });
  });

  it("turns a global transition into 'every other status' when one cell is unticked", () => {
    const def = setMove(base(), "doing", "done", false);
    expect(def.transitions.find((t) => t.id === "done")?.from).toEqual(["todo"]);
    expect(cellState(def, "todo", "done").allowed).toBe(true);
    expect(cellState(def, "doing", "done").allowed).toBe(false);
  });

  it("drops a transition left leading from nowhere, and leaves a move onto itself alone", () => {
    const def = setMove(base(), "todo", "doing", false);
    expect(def.transitions.map((t) => t.id)).toEqual(["done"]);
    expect(setMove(base(), "todo", "todo", true)).toEqual(base());
  });
});

describe("statuses", () => {
  it("global moves on and off, and the initial status moves", () => {
    expect(setGlobal(base(), "todo", true, () => "Reopen").transitions.at(-1)).toEqual({ id: "todo", name: "Reopen", from: "*", to: "todo" });
    expect(setGlobal(base(), "done", false).transitions.map((t) => t.id)).toEqual(["start"]);
    expect(setInitial(base(), "doing").statuses.filter((s) => s.isInitial).map((s) => s.key)).toEqual(["doing"]);
  });

  it("including a status makes it reachable; excluding one takes it out of every transition", () => {
    const added = includeStatus(base(), "review", () => "Review");
    expect(added.statuses.map((s) => s.key)).toEqual(["todo", "doing", "done", "review"]);
    expect(cellState(added, "todo", "review").allowed).toBe(true);

    const dropped = excludeStatus(base(), "todo");
    expect(dropped.statuses).toEqual([{ key: "doing", isInitial: true }, { key: "done" }]);
    // "start" led only from To Do: gone.
    expect(dropped.transitions.map((t) => t.id)).toEqual(["done"]);
  });
});

describe("transitions", () => {
  it("get fresh ids, are replaced and renamed in place, and removed", () => {
    expect(freshTransitionId(base(), "Start")).toBe("start-2");
    expect(freshTransitionId(base(), "Review it!")).toBe("review-it");
    const renamed = upsertTransition(base(), { id: "begin", name: "Begin", from: ["todo"], to: "doing" }, "start");
    expect(renamed.transitions.map((t) => t.id)).toEqual(["begin", "done"]);
    expect(removeTransition(renamed, "begin").transitions.map((t) => t.id)).toEqual(["done"]);
  });
});
