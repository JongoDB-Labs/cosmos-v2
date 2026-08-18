import { describe, it, expect } from "vitest";
import { blockingChildren, describeBlockers, type ChildLike } from "./parent-done-guard";

const child = (id: string, columnKey: string | null, title = `Child ${id}`): ChildLike => ({
  id,
  title,
  columnKey,
});

const DONE = new Set(["done", "shipped"]);
const CANCELLED = new Set(["cancelled"]);

describe("blockingChildren", () => {
  it("lets a parent with no children through", () => {
    expect(blockingChildren([], DONE)).toEqual([]);
  });

  it("lets a parent through when every child is done", () => {
    expect(blockingChildren([child("a", "done"), child("b", "shipped")], DONE)).toEqual([]);
  });

  it("blocks on a child still in progress", () => {
    const out = blockingChildren([child("a", "done"), child("b", "in-progress")], DONE);
    expect(out.map((c) => c.id)).toEqual(["b"]);
  });

  it("honours EVERY done column, not just one called 'done'", () => {
    // A project can have several; hard-coding "done" would block on "Shipped".
    expect(blockingChildren([child("a", "shipped")], DONE)).toEqual([]);
    expect(blockingChildren([child("a", "shipped")], new Set(["done"])).map((c) => c.id)).toEqual(["a"]);
  });

  it("treats CANCELLED work as settled, so it does not block", () => {
    expect(blockingChildren([child("a", "cancelled")], DONE, CANCELLED)).toEqual([]);
    // ...but only when the caller says which columns those are.
    expect(blockingChildren([child("a", "cancelled")], DONE).map((c) => c.id)).toEqual(["a"]);
  });

  it("blocks on a child with no column at all rather than assuming it is finished", () => {
    expect(blockingChildren([child("a", null)], DONE).map((c) => c.id)).toEqual(["a"]);
  });

  it("keeps the given order, so the message names the first children on the board", () => {
    const out = blockingChildren([child("a", "todo"), child("b", "todo"), child("c", "todo")], DONE);
    expect(out.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});

describe("describeBlockers", () => {
  it("names one", () => {
    expect(describeBlockers([child("a", "todo", "Wire the API")])).toBe("Wire the API");
  });

  it("joins two with 'and'", () => {
    expect(describeBlockers([child("a", "todo", "One"), child("b", "todo", "Two")])).toBe(
      "One and Two",
    );
  });

  it("counts the rest beyond two", () => {
    expect(
      describeBlockers([
        child("a", "todo", "One"),
        child("b", "todo", "Two"),
        child("c", "todo", "Three"),
        child("d", "todo", "Four"),
      ]),
    ).toBe("One, Two and 2 more");
  });

  it("says nothing when nothing blocks", () => {
    expect(describeBlockers([])).toBe("");
  });
});
