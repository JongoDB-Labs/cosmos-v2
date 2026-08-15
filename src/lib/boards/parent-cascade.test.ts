import { describe, it, expect } from "vitest";
import { shouldOfferParentCascade, type Phase } from "./parent-cascade";

const ask = (childCategory: Phase, parentCategory: Phase) =>
  shouldOfferParentCascade({ childCategory, parentCategory });

describe("shouldOfferParentCascade", () => {
  it("offers when a child moves ahead of a parent still in Backlog", () => {
    expect(ask("IN_PROGRESS", "TODO")).toBe(true);
    expect(ask("DONE", "TODO")).toBe(true);
  });

  it("offers when a child is finished but the parent is only started", () => {
    expect(ask("DONE", "IN_PROGRESS")).toBe(true);
  });

  it("stays quiet when the parent is already at or past the child", () => {
    expect(ask("IN_PROGRESS", "IN_PROGRESS")).toBe(false);
    expect(ask("IN_PROGRESS", "DONE")).toBe(false);
    expect(ask("TODO", "TODO")).toBe(false);
  });

  it("never offers on a BACKWARD move — other children may still be in flight", () => {
    expect(ask("TODO", "IN_PROGRESS")).toBe(false);
    expect(ask("TODO", "DONE")).toBe(false);
    expect(ask("IN_PROGRESS", "DONE")).toBe(false);
  });

  it("ignores CANCELLED on either side", () => {
    // Cancelling a child says nothing about its parent...
    expect(ask("CANCELLED", "TODO")).toBe(false);
    expect(ask("CANCELLED", "IN_PROGRESS")).toBe(false);
    // ...and a cancelled parent must not be resurrected by a child's move.
    expect(ask("IN_PROGRESS", "CANCELLED")).toBe(false);
    expect(ask("DONE", "CANCELLED")).toBe(false);
  });

  it("is exhaustive over every category pair", () => {
    // Guards a later CATEGORY addition silently falling through to `true`.
    const ALL: Phase[] = ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"];
    const offered: string[] = [];
    for (const c of ALL) {
      for (const p of ALL) if (ask(c, p)) offered.push(`${c}>${p}`);
    }
    expect(offered.sort()).toEqual(
      ["DONE>IN_PROGRESS", "DONE>TODO", "IN_PROGRESS>TODO"].sort(),
    );
  });
});
