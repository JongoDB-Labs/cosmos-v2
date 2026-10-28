// Does this free text look like somebody trying to write a query?
//
// Reported: "i typed 'type == feature' and it showed nothing. also, i'm not
// sure what the difference between basic and advanced is."
//
// Both halves have one cause. Basic mode is the default, and its box is a
// FREE-TEXT search — the comment in query-builder says so: "the free-text box
// IS the `text ~` chip". So a query typed there is searched for LITERALLY, as
// a phrase, in titles and descriptions. It matches nothing, and nothing says
// why: no diagnostic, because nothing was parsed as a query in the first place.
//
// This is the predicate behind the hint that offers to run it properly.
import { describe, it, expect } from "vitest";
import { looksLikeQuery } from "./looks-like-query";

describe("looksLikeQuery", () => {
  it("recognises the query the report was filed about", () => {
    expect(looksLikeQuery("type == feature")).toBe(true);
  });

  it("recognises the ordinary comparisons", () => {
    for (const q of [
      "status = Done",
      "priority != LOW",
      "points > 3",
      "points >= 3",
      "due < now()",
      "assignee = me",
      'summary ~ "login"',
    ]) {
      expect(looksLikeQuery(q), q).toBe(true);
    }
  });

  it("recognises the word operators", () => {
    for (const q of ["assignee IS EMPTY", "status IN (Done, Review)", "status WAS Done"]) {
      expect(looksLikeQuery(q), q).toBe(true);
    }
  });

  it("leaves ordinary searching alone", () => {
    // The cost of a false positive is a hint nobody wanted on a normal search,
    // so these matter as much as the positives.
    for (const q of [
      "login bug",
      "Q3 report",
      "crash on save",
      "",
      "   ",
      "payment >> refund",
      "a=b",            // no space, no field-looking left side worth prompting on
      "rate 5/5",
      "100% done",
    ]) {
      expect(looksLikeQuery(q), JSON.stringify(q)).toBe(false);
    }
  });

  it("requires a FIELD on the left, not any word", () => {
    // `=` alone is not enough: people do type "scope = tbd" in a title search.
    // Only a name the query language actually knows should prompt.
    expect(looksLikeQuery("widget = blue")).toBe(false);
    expect(looksLikeQuery("status = blue")).toBe(true);
  });

  it("accepts a field's alias, since the hint should fire on what people type", () => {
    expect(looksLikeQuery("creator = me")).toBe(true);
  });
});
