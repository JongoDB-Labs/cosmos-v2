import { describe, it, expect } from "vitest";
import { completionAt } from "../complete";

/** `|` marks the cursor. */
function at(src: string) {
  const cursor = src.indexOf("|");
  return completionAt(src.slice(0, cursor) + src.slice(cursor + 1), cursor);
}

describe("completionAt — slots", () => {
  it.each([
    ["|", { kind: "field" }],
    ["pri|", { kind: "field" }],
    ["(|", { kind: "field" }],
    ["NOT |", { kind: "field" }],
    ["priority = HIGH AND |", { kind: "field" }],
    ["priority = HIGH OR st|", { kind: "field" }],
    ["(priority = HIGH) AND |", { kind: "field" }],
    ["priority |", { kind: "operator", field: "priority" }],
    ["priority NOT |", { kind: "operator", field: "priority" }],
    ['"Story Points" |', { kind: "operator", field: "Story Points" }],
    ["cf[severity] |", { kind: "operator", field: "severity" }],
    ["priority = |", { kind: "value", field: "priority", inList: false }],
    ["priority = HI|", { kind: "value", field: "priority", inList: false }],
    ["priority != |", { kind: "value", field: "priority", inList: false }],
    ["summary ~ |", { kind: "value", field: "summary", inList: false }],
    ["priority IN |", { kind: "value", field: "priority", inList: true }],
    ["priority IN (|", { kind: "value", field: "priority", inList: true }],
    ["priority IN (HIGH, |", { kind: "value", field: "priority", inList: true }],
    ["priority NOT IN (HIGH, CR|", { kind: "value", field: "priority", inList: true }],
    ["labels IN ALL (|", { kind: "value", field: "labels", inList: true }],
    ["assignee IS |", { kind: "value", field: "assignee", inList: false, afterIs: true }],
    ["assignee IS NOT |", { kind: "value", field: "assignee", inList: false, afterIs: true }],
    ["status WAS |", { kind: "value", field: "status", inList: false }],
    ["status CHANGED FROM |", { kind: "value", field: "status", inList: false }],
    ["status CHANGED FROM todo TO |", { kind: "value", field: "status", inList: false }],
    ["priority = HIGH |", { kind: "keyword" }],
    ["priority = HIGH AN|", { kind: "keyword" }],
    ["priority IN (HIGH, LOW) |", { kind: "keyword" }],
    ["priority IN (HIGH |", { kind: "keyword" }],
    ["assignee IS EMPTY |", { kind: "keyword" }],
    ["sprint IN openSprints() |", { kind: "keyword" }],
    ["created >= startOfWeek(-1w) |", { kind: "keyword" }],
    ["status CHANGED |", { kind: "keyword" }],
    ["descendantsOf(ACME-1) |", { kind: "keyword" }],
    ["priority = HIGH ORDER |", { kind: "keyword" }],
    ["ORDER BY |", { kind: "sortField" }],
    ["priority = HIGH ORDER BY d|", { kind: "sortField" }],
    ["ORDER BY due, |", { kind: "sortField" }],
    ["ORDER BY due |", { kind: "sortDir" }],
    ["ORDER BY due DESC |", { kind: "sortDir" }],
    ["ORDER BY due DESC NULLS |", { kind: "sortDir" }],
    ["assignee IN membersOf(|", { kind: "argument", fn: "membersOf", index: 0, field: "assignee" }],
    ["created >= startOfWeek(|", { kind: "argument", fn: "startOfWeek", index: 0, field: "created" }],
    ["linkedItems(ACME-1, |", { kind: "argument", fn: "linkedItems", index: 1, field: null }],
    ["((priority = HIGH OR |", { kind: "field" }],
  ])("%s", (src, slot) => {
    expect(at(src).slot).toEqual(slot);
  });
});

describe("completionAt — the word being typed", () => {
  it("covers a partial word, and an unclosed quote", () => {
    expect(at("priority = HI|")).toMatchObject({ from: 11, prefix: "HI" });
    expect(at("priority = |")).toMatchObject({ from: 11, prefix: "" });
    expect(at('assignee = "Dana R|')).toMatchObject({ slot: { kind: "value", field: "assignee" }, from: 11, prefix: "Dana R" });
    expect(at("assignee = $sp|")).toMatchObject({ from: 11, prefix: "$sp" });
  });

  it("never throws on garbage", () => {
    for (const s of ["@@@", '"""', "((((", "))))", "= = =", "cf[", "cf[x", "ORDER BY BY BY", "a IN (,,,"]) {
      expect(() => completionAt(s, s.length)).not.toThrow();
    }
  });
});
