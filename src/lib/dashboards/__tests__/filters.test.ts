import { describe, it, expect } from "vitest";
import { effectiveValues, filterClause, filterDefsSchema, filterVars, withFilters, type DashboardFilterDef } from "../filters";
import { parseCql } from "@/lib/query/parser";
import { printCql } from "@/lib/query/print";
import { typecheck } from "@/lib/query/typecheck";
import { hasErrors } from "@/lib/query/errors";

const defs = filterDefsSchema.parse([
  { key: "person", default: null },
  { key: "sprint", default: "@currentSprint" },
  { key: "priority", multi: true, default: ["HIGH", "CRITICAL"] },
  { key: "dateWindow", default: null },
]) as DashboardFilterDef[];
const q = (t: string) => parseCql(t).query;
const print = (x: ReturnType<typeof withFilters>) => printCql(x);

describe("dashboard filters", () => {
  it("URL beats the viewer's remembered value beats the default; null means everyone", () => {
    const v = effectiveValues(defs, { person: "dana@x.com" }, { person: "ada@x.com", sprint: null }, undefined);
    expect(v).toEqual({ person: "dana@x.com", sprint: null, priority: ["HIGH", "CRITICAL"], dateWindow: null });
  });

  it("each set filter is one clause ANDed onto the panel; unset ones add nothing", () => {
    const out = withFilters(q("type = Bug ORDER BY due"), defs, { person: "dana@x.com", sprint: "@currentSprint", priority: ["HIGH"], dateWindow: "-7d" });
    expect(print(out)).toBe('type = Bug AND assignee IN ("dana@x.com") AND sprint IN currentSprint() AND priority IN (HIGH) AND updated >= -7d ORDER BY due ASC');
    expect(print(withFilters(q("type = Bug"), defs, { person: null, sprint: null, priority: null, dateWindow: null }))).toBe("type = Bug");
  });

  it("a panel can ignore a filter; an empty selection matches nothing rather than everything", () => {
    expect(print(withFilters(q("type = Bug"), defs, { person: "x", priority: ["LOW"] }, ["person"]))).toBe("type = Bug AND priority IN (LOW)");
    expect(filterClause("priority", [])).toEqual({ op: "in", field: { kind: "sys", id: "priority" }, values: [] });
  });

  it("every clause it builds typechecks as CQL", () => {
    const out = withFilters(null, defs, { person: ["@me", "dana@x.com"], sprint: "@currentSprint", priority: ["HIGH"], dateWindow: "-5wd" });
    const text = print(out);
    const p = parseCql(text);
    expect(hasErrors(p.diagnostics)).toBe(false);
    expect(hasErrors(typecheck(p.query, { customFields: [] }, text, p.spans).diagnostics)).toBe(false);
  });

  it("refuses a bad window, an unknown key, and a key twice", () => {
    expect(filterClause("dateWindow", "-7 days")).toBeNull();
    expect(filterClause("nonsense", "x")).toBeNull();
    expect(filterDefsSchema.safeParse([{ key: "person" }, { key: "person" }]).success).toBe(false);
    expect(filterDefsSchema.safeParse([{ key: "cf.sev" }]).success).toBe(true);
    expect(filterDefsSchema.safeParse([{ key: "cf.bad key" }]).success).toBe(false);
  });

  it("values reach panels as variables too, tokens excepted", () => {
    expect(filterVars({ person: "dana@x.com", sprint: "@currentSprint", priority: ["HIGH"], "cf.sev": "S1", dateWindow: "-7d" })).toEqual({
      person: "dana@x.com", sprint: null, priority: ["HIGH"], cf_sev: "S1",
    });
  });
});
