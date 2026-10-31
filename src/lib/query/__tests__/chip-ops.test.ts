import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { fromChips, toChips, type Chip } from "../basic";
import {
  ARCHIVED_ONLY,
  WATCHING,
  chipField,
  chipFields,
  chipOps,
  datePresets,
  fromEdit,
  hasClause,
  newEdit,
  parseValueText,
  presetEdit,
  presetOf,
  legacyText,
  simplifyLegacyText,
  toEdit,
  toggleClause,
  withOp,
} from "../chip-ops";
import { SYSTEM_FIELD_IDS } from "../fields";
import { normalize } from "../normalize";
import { parseCql } from "../parser";
import { printCql } from "../print";
import { fromWorkItemFilter } from "../adapters";
import type { SchemaCustomField } from "../typecheck";
import { queryArb } from "./arbitraries";

const CFS: SchemaCustomField[] = [
  { key: "severity", name: "Severity", fieldType: "SELECT", options: ["S1", "S2"] },
  { key: "flagged", name: "Flagged", fieldType: "CHECKBOX" },
  { key: "launch", name: "Launch", fieldType: "DATE" },
];
const sys = (id: string) => chipField({ kind: "sys", id } as never, CFS)!;
const q = (cql: string) => parseCql(cql).query;

describe("chip editing", () => {
  it("an untouched chip edits back to the same query", () => {
    // Every chip basic mode accepts survives toEdit → fromEdit unchanged (up to normalize).
    let seen = 0;
    fc.assert(
      fc.property(queryArb, (query) => {
        const r = toChips(query);
        if (!r.ok || !r.chips.length) return;
        const back = r.chips.map((c) => fromEdit(toEdit(c, chipField(c.field, CFS))) as Chip);
        expect(back.every(Boolean)).toBe(true);
        seen++;
        expect(fromChips(back, r.matchAny, r.orderBy)).toEqual(fromChips(r.chips, r.matchAny, r.orderBy));
      }),
      { numRuns: 3000 },
    );
    expect(seen).toBeGreaterThan(300);
  });

  it("offers only what the typechecker accepts for the field", () => {
    expect(chipOps(sys("assignee"))).toEqual(["any", "none", "empty", "notEmpty"]);
    expect(chipOps(sys("label"))).toEqual(["any", "none", "all", "empty", "notEmpty"]);
    expect(chipOps(sys("due"))).toEqual(["is", "lt", "gt", "between", "empty", "notEmpty"]);
    expect(chipOps(sys("created"))).toEqual(["is", "lt", "gt", "between"]);
    expect(chipOps(sys("summary"))).toEqual(["contains", "notContains"]);
    expect(chipOps(sys("blocked"))).toEqual(["is"]);
    expect(chipOps(chipField({ kind: "cf", key: "severity" }, CFS)!)).toEqual(["any", "none", "empty", "notEmpty"]);
    expect(chipOps(chipField({ kind: "cf", key: "flagged" }, CFS)!)).toEqual(["is"]);
  });

  it("leaves out ORDER-BY-only fields and the free-text field", () => {
    const ids = chipFields(CFS, SYSTEM_FIELD_IDS).map((f) => (f.field.kind === "sys" ? f.field.id : `cf:${f.field.key}`));
    expect(ids).toContain("ancestor");
    expect(ids).not.toContain("rank");
    expect(ids).not.toContain("text");
    expect(ids).toContain("cf:severity");
    expect(chipField({ kind: "cf", key: "nope" }, CFS)).toBeNull();
  });

  /**
   * The "Add filter" catalogue is a flat list of 48 labels. Searching it matched
   * the LABEL only, so the words people actually type reached nothing: `pi` is a
   * field id, `interval` and `iteration` are registry aliases of Sprint, and
   * `phase` is a value of Interval kind — none of them appear in any label.
   * Reported as "why don't we just have an interval filter I can choose" and
   * "I saw an ancestor filter, but I'm not really sure what that is".
   */
  describe("a field is findable by the words people type", () => {
    const termsOf = (id: string) => (sys(id).terms ?? "").toLowerCase();

    it("carries the id, the aliases and the description", () => {
      // `pi` is the id; the label is "Program increment" and contains no "pi".
      expect(termsOf("pi")).toContain("pi");
      expect(termsOf("pi")).toContain("programincrement");
      expect(sys("pi").label.toLowerCase()).not.toContain("pi");

      // Sprint answers to the two words the schema itself uses for it.
      expect(termsOf("sprint")).toContain("interval");
      expect(termsOf("sprint")).toContain("iteration");

      // Ancestor's meaning lives in its description, and now travels with it.
      expect(termsOf("ancestor")).toContain("any depth");
      expect(sys("ancestor").hint).toMatch(/any depth/i);
    });

    it("includes an enum's values, so `phase` finds Interval kind", () => {
      expect(termsOf("intervalKind")).toContain("phase");
      expect(termsOf("intervalKind")).toContain("program_increment");
    });

    it("makes a custom field findable by its cf[key] key", () => {
      const cf = chipField({ kind: "cf", key: "severity" }, CFS)!;
      expect((cf.terms ?? "").toLowerCase()).toContain("severity");
    });

    it("gives every chippable system field both a hint and terms", () => {
      for (const f of chipFields(CFS, SYSTEM_FIELD_IDS)) {
        if (f.field.kind !== "sys") continue;
        expect(f.terms, `${f.field.id} terms`).toBeTruthy();
        expect(f.hint, `${f.field.id} hint`).toBeTruthy();
      }
    });
  });

  it("an incomplete chip says nothing", () => {
    expect(fromEdit(newEdit(sys("assignee")))).toBeNull();
    expect(fromEdit({ ...newEdit(sys("due")), op: "between", values: [{ t: "rel", v: "-7d" }] })).toBeNull();
    expect(fromEdit({ ...newEdit(sys("summary")), op: "contains", text: "" })).toBeNull();
    // …but a checkbox starts as `= true`, and emptiness needs no value.
    expect(fromEdit(newEdit(sys("blocked")))).toEqual({ kind: "cmp", field: { kind: "sys", id: "blocked" }, cmp: "eq", value: { t: "bool", v: true } });
    expect(fromEdit({ ...newEdit(sys("assignee")), op: "empty" })).toEqual({ kind: "empty", field: { kind: "sys", id: "assignee" } });
  });

  it("one value reads as = / !=, several as IN / NOT IN", () => {
    const e = { ...newEdit(sys("priority")), values: [{ t: "str" as const, v: "HIGH" }] };
    expect(fromEdit(e)).toMatchObject({ kind: "cmp", cmp: "eq" });
    expect(fromEdit({ ...e, op: "none" })).toMatchObject({ kind: "cmp", cmp: "neq" });
    expect(fromEdit({ ...e, values: [...e.values, { t: "str", v: "LOW" }] })).toMatchObject({ kind: "in", values: [{ v: "HIGH" }, { v: "LOW" }] });
    expect(fromEdit({ ...e, op: "none", values: [...e.values, { t: "str", v: "LOW" }] })).toMatchObject({ kind: "in", negate: true });
    // `IN (EMPTY)` stays a list: `assignee = EMPTY` is not CQL.
    expect(fromEdit({ ...e, field: { kind: "sys", id: "assignee" }, values: [{ t: "empty" }] })).toMatchObject({ kind: "in" });
  });

  it("changing the operator keeps the values that still fit", () => {
    const e = { ...newEdit(sys("priority")), values: [{ t: "str" as const, v: "HIGH" }, { t: "str" as const, v: "LOW" }] };
    expect(withOp(e, "none").values).toHaveLength(2);
    expect(withOp(e, "empty").values).toHaveLength(0);
    const d = { ...newEdit(sys("due")), op: "between" as const, values: [{ t: "rel" as const, v: "-7d" }, { t: "rel" as const, v: "7d" }] };
    expect(withOp(d, "lt").values).toEqual([{ t: "rel", v: "-7d" }]);
  });

  it("date presets compile to the documented CQL and are recognised again", () => {
    const due = { kind: "sys", id: "due" } as const;
    const text = (p: Parameters<typeof presetEdit>[1]) => printCql(fromChips([fromEdit(presetEdit(due, p))!], false));
    expect(text("overdue")).toBe("due < now()");
    expect(text("thisWeek")).toBe("due >= startOfWeek() AND due <= endOfWeek()");
    expect(text("none")).toBe("due IS EMPTY");
    for (const p of ["overdue", "thisWeek", "thisMonth", "last7", "last30", "none"] as const) {
      expect(presetOf(presetEdit(due, p))).toBe(p);
    }
    expect(presetOf({ field: due, op: "lt", values: [{ t: "date", v: "2026-01-01" }], text: "" })).toBeNull();
  });

  it("offers the presets that make sense for the field", () => {
    expect(datePresets(sys("due")).map((p) => p.id)).toEqual(["overdue", "thisWeek", "thisMonth", "none"]);
    expect(datePresets(sys("created")).map((p) => p.id)).toEqual(["thisWeek", "thisMonth", "last7", "last30"]);
    expect(datePresets(sys("priority"))).toEqual([]);
  });

  it("reads a suggestion's insert text as a value", () => {
    expect(parseValueText("me")).toEqual({ t: "fn", name: "currentUser", args: [] });
    expect(parseValueText('"Dana Ruiz"')).toEqual({ t: "str", v: "Dana Ruiz" });
    expect(parseValueText("EMPTY")).toEqual({ t: "empty" });
    expect(parseValueText("-7d")).toEqual({ t: "rel", v: "-7d" });
    expect(parseValueText("")).toBeNull();
    expect(parseValueText("a b")).toBeNull();
  });
});

describe("Watching / Archived toggles", () => {
  it("adds and removes a top-level clause, leaving the rest alone", () => {
    const start = q("priority = HIGH");
    const on = toggleClause(start, WATCHING);
    expect(printCql(on)).toBe("priority = HIGH AND watcher = me");
    expect(hasClause(on, WATCHING)).toBe(true);
    expect(hasClause(on, ARCHIVED_ONLY)).toBe(false);
    const off = toggleClause(on, WATCHING);
    expect(printCql(off)).toBe("priority = HIGH");
    expect(printCql(toggleClause(q(""), ARCHIVED_ONLY))).toBe("archived = true");
    expect(toggleClause(toggleClause(q(""), ARCHIVED_ONLY), ARCHIVED_ONLY).where).toBeNull();
  });

  it("ANDs onto a top-level OR without breaking it", () => {
    const on = toggleClause(q("priority = HIGH OR priority = LOW"), WATCHING);
    expect(printCql(on)).toBe("(priority = HIGH OR priority = LOW) AND watcher = me");
    // A clause nested inside the OR is not "on".
    expect(hasClause(q("watcher = me OR priority = LOW"), WATCHING)).toBe(false);
  });
});

describe("legacy text", () => {
  it("turns the legacy title-or-description search into the Issues box's `text ~`", () => {
    const legacy = fromWorkItemFilter({ text: "login", priorities: ["HIGH"] });
    expect(toChips(legacy).ok).toBe(false);
    const simple = simplifyLegacyText(legacy);
    expect(printCql(simple)).toBe('priority IN (HIGH) AND text ~ "login"');
    expect(toChips(simple).ok).toBe(true);
    // …and back, for the legacy shape saved views still store.
    expect(normalize(legacyText(simple))).toEqual(normalize(legacy));
    // Anything else is untouched.
    const other = q('summary ~ "a" OR description ~ "b"');
    expect(normalize(simplifyLegacyText(other))).toEqual(normalize(other));
  });
});
