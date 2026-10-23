import { describe, it, expect } from "vitest";
import { parseCql } from "../parser";
import { typecheck, type CqlSchema } from "../typecheck";
import { FIELDS, type FieldDef, type OpFamily, type ValueKind } from "../fields";
import { CQL_VERSION, type CqlNode, type CqlValue } from "../ast";

const SCHEMA: CqlSchema = {
  customFields: [
    { key: "severity", name: "Severity", fieldType: "SELECT", options: ["S1", "S2"] },
    { key: "story_points_x", name: "Story Points X", fieldType: "NUMBER" },
    { key: "areas", name: "Areas", fieldType: "MULTI_SELECT" },
    { key: "approved", name: "Approved", fieldType: "CHECKBOX" },
    { key: "owner", name: "Owner", fieldType: "USER" },
    { key: "go_live", name: "Go Live", fieldType: "DATE" },
    { key: "notes", name: "Notes", fieldType: "TEXT" },
  ],
};

function check(cql: string) {
  const p = parseCql(cql);
  expect(p.diagnostics, cql).toEqual([]);
  return typecheck(p.query, SCHEMA, cql, p.spans);
}
const codes = (cql: string) => check(cql).diagnostics.map((d) => d.code);

/** A value a field of this kind accepts. */
function sample(kind: ValueKind): CqlValue {
  switch (kind.kind) {
    case "ref":
      return { t: "str", v: "something" };
    case "enum":
      return { t: "str", v: kind.values[0] };
    case "bool":
      return { t: "bool", v: true };
    case "number":
      return { t: "num", v: 3 };
    case "duration":
      return { t: "rel", v: "2h" };
    case "date":
    case "datetime":
      return { t: "date", v: "2026-10-31" };
    case "text":
    case "string":
      return { t: "str", v: "abc" };
  }
}

function leafFor(f: FieldDef, fam: OpFamily): CqlNode {
  const field = { kind: "sys" as const, id: f.id };
  const v = sample(f.value);
  switch (fam) {
    case "eq":
      return { op: "cmp", field, cmp: "eq", value: v };
    case "order":
      return { op: "cmp", field, cmp: "gt", value: f.value.kind === "ref" ? { t: "str", v: "ACME-1" } : v };
    case "in":
      return { op: "in", field, values: [v] };
    case "inAll":
      return { op: "in", field, all: true, values: [v] };
    case "empty":
      return { op: "empty", field };
    case "text":
      return { op: "text", field, query: "abc" };
    case "history":
      return { op: "changed", field };
  }
}

describe("typecheck — the field × operator matrix (generated from the registry)", () => {
  const families: OpFamily[] = ["eq", "in", "inAll", "order", "empty", "text", "history"];
  const cases = FIELDS.flatMap((f) => families.map((fam) => [f.id, fam, f] as const));

  it.each(cases)("%s × %s", (_id, fam, f) => {
    const r = typecheck({ v: CQL_VERSION, where: leafFor(f, fam) }, SCHEMA);
    const c = r.diagnostics.map((d) => d.code);
    if (f.pending) {
      expect(c).toEqual(["CQL_NOT_YET_SUPPORTED"]);
    } else if (!f.ops.includes(fam)) {
      expect(c).toEqual([fam === "history" ? "CQL_HISTORY_UNSUPPORTED" : "CQL_OPERATOR_NOT_SUPPORTED"]);
    } else if (fam === "order" && f.value.kind === "ref" && f.id !== "key") {
      expect(c).toEqual(["CQL_OPERATOR_NOT_SUPPORTED"]);
    } else {
      expect(c.filter((x) => x !== "CQL_NEQ_EXCLUDES_EMPTY")).toEqual([]);
    }
  });

  it("every field declares a description and at least ORDER BY or one operator", () => {
    for (const f of FIELDS) {
      expect(f.description.length, f.id).toBeGreaterThan(5);
      expect(f.ops.length > 0 || f.sortable, f.id).toBe(true);
    }
  });
});

describe("typecheck — fields", () => {
  it("unknown fields get suggestions, across system and custom fields", () => {
    const d = check("priorty = HIGH").diagnostics[0];
    expect(d.code).toBe("CQL_UNKNOWN_FIELD");
    expect(d.hint).toContain("`priority`");
    expect([d.from, d.to]).toEqual([0, 7]);
    expect(check("Severty = S1").diagnostics[0].hint).toContain("Severity");
  });

  it("Jira-only fields name the Cosmos equivalent", () => {
    const d = check("fixVersion = 1.2").diagnostics[0];
    expect(d.code).toBe("CQL_UNKNOWN_FIELD");
    expect(d.message).toMatch(/sprint|milestone/);
  });

  it("a custom field by display name, key or cf[...] becomes its key", () => {
    for (const q of ['"Severity" = S1', "Severity = S1", "cf[severity] = S1", 'cf["Severity"] = S1']) {
      const r = check(q);
      expect(r.diagnostics, q).toEqual([]);
      expect((r.query.where as { field: unknown }).field).toEqual({ kind: "cf", key: "severity" });
    }
  });

  it("custom field operators follow the field type", () => {
    expect(codes("Severity IN (S1, S2)")).toEqual([]);
    expect(codes("Areas IN ALL (web, api)")).toEqual([]);
    expect(codes('"Story Points X" > 3')).toEqual([]);
    expect(codes("Approved = true")).toEqual([]);
    expect(codes('"Go Live" < 2026-12-01')).toEqual([]);
    expect(codes("Owner = me")).toEqual([]);
    expect(codes("Approved > 3")).toEqual(["CQL_OPERATOR_NOT_SUPPORTED"]);
    expect(codes("Notes ~ abc")).toEqual([]);
    expect(codes("Severity ~ abc")).toEqual(["CQL_OPERATOR_NOT_SUPPORTED"]);
    expect(codes("Severity IS EMPTY")).toEqual([]);
    expect(codes("Severity IN (S1, EMPTY)")).toEqual([]);
    expect(codes("Approved IS EMPTY")).toEqual(["CQL_OPERATOR_NOT_SUPPORTED"]);
    // The Jira != gotcha applies to custom fields too.
    expect(codes("Severity != S1")).toEqual(["CQL_NEQ_EXCLUDES_EMPTY"]);
  });
});

describe("typecheck — values", () => {
  it("enum values are canonicalised; statusCategory accepts everyday spellings", () => {
    const r = check('priority = high AND statusCategory = "in progress" AND statusCategory != todo');
    expect(r.diagnostics.map((d) => d.code)).toEqual([]);
    expect(JSON.stringify(r.query)).toContain('"v":"HIGH"');
    expect(JSON.stringify(r.query)).toContain('"v":"IN_PROGRESS"');
    expect(JSON.stringify(r.query)).toContain('"v":"TODO"');
  });

  it("an unknown enum value is reported with a suggestion", () => {
    const d = check("priority = HIHG").diagnostics[0];
    expect(d.code).toBe("CQL_UNKNOWN_VALUE");
    expect(d.hint).toContain("HIGH");
  });

  it("type mismatches", () => {
    expect(codes("points > abc")).toEqual(["CQL_TYPE_MISMATCH"]);
    expect(codes("blocked = yes")).toEqual(["CQL_TYPE_MISMATCH"]);
    expect(codes("due < soon")).toEqual(["CQL_TYPE_MISMATCH"]);
    expect(codes("timeSpent > 3")).toEqual(["CQL_TYPE_MISMATCH"]);
    expect(codes("timeSpent > -3d")).toEqual(["CQL_TYPE_MISMATCH"]);
    expect(codes("reporter IS EMPTY")).toEqual(["CQL_OPERATOR_NOT_SUPPORTED"]);
    expect(codes("project IN (EMPTY)")).toEqual(["CQL_TYPE_MISMATCH"]);
  });

  it("functions: unknown names, arity, argument kinds and return kinds", () => {
    const u = check("sprint IN openSprint()").diagnostics[0];
    expect(u.code).toBe("CQL_UNKNOWN_FUNCTION");
    expect(u.hint).toContain("openSprints()");
    expect(codes("assignee IN membersOf()")).toEqual(["CQL_TYPE_MISMATCH"]);
    expect(codes("created > startOfWeek(abc)")).toEqual(["CQL_TYPE_MISMATCH"]);
    expect(codes("created > startOfWeek(-1)")).toEqual([]);
    expect(codes("assignee IN openSprints()")).toEqual(["CQL_TYPE_MISMATCH"]);
    expect(codes("due < openSprints()")).toEqual(["CQL_TYPE_MISMATCH"]);
    expect(codes("linkedItems(ACME-1, NOPE)")).toEqual(["CQL_TYPE_MISMATCH"]);
    expect(codes("descendantsOf(ACME-1)")).toEqual([]);
  });

  it("a set-valued function after = is taken as the IN it means", () => {
    const r = check("sprint = openSprints()");
    expect(r.diagnostics).toEqual([]);
    expect(r.query.where).toMatchObject({ op: "in", values: [{ t: "fn", name: "openSprints" }] });
  });

  it("variables are accepted anywhere a value is", () => {
    expect(codes("assignee = $speaker AND team IN $team AND project = $project")).toEqual([]);
  });

  it("~ needs text; * only as a trailing prefix", () => {
    expect(codes('summary ~ "log*"')).toEqual([]);
    expect(codes('summary ~ "*log"')).toEqual(["CQL_TYPE_MISMATCH"]);
    expect(codes('summary ~ "   "')).toEqual(["CQL_TYPE_MISMATCH"]);
  });
});

describe("typecheck — the != warning (Jira's empty-value gotcha)", () => {
  it("warns on nullable fields and offers a one-click fix that keeps empties", () => {
    const text = "assignee != me";
    const r = check(text);
    const d = r.diagnostics[0];
    expect(d.code).toBe("CQL_NEQ_EXCLUDES_EMPTY");
    expect(d.severity).toBe("warning");
    expect(d.fixes?.[0].replace).toEqual({ from: 0, to: 14, insert: "(assignee != me OR assignee IS EMPTY)" });
  });
  it("no warning on fields that are never empty, or when EMPTY is already listed", () => {
    expect(codes("priority != HIGH")).toEqual([]);
    expect(codes("assignee NOT IN (me, EMPTY)")).toEqual([]);
    expect(codes("assignee NOT IN (me)")).toEqual(["CQL_NEQ_EXCLUDES_EMPTY"]);
  });
});

describe("typecheck — ORDER BY", () => {
  it("sortable fields pass, two-phase sorts are not yet, others are refused", () => {
    expect(codes("ORDER BY due DESC, priority, key")).toEqual([]);
    expect(codes("ORDER BY assignee")).toEqual(["CQL_NOT_YET_SUPPORTED"]);
    expect(codes("ORDER BY Severity")).toEqual(["CQL_NOT_YET_SUPPORTED"]);
    expect(codes("ORDER BY summary")).toEqual(["CQL_OPERATOR_NOT_SUPPORTED"]);
  });
});

describe("quick-fixes for typos", () => {
  const fixed = (cql: string) => {
    const p = parseCql(cql);
    const d = typecheck(p.query, { customFields: [] }, cql, p.spans).diagnostics.find((x) => x.fixes?.length);
    const f = d?.fixes?.[0];
    return f ? cql.slice(0, f.replace.from) + f.replace.insert + cql.slice(f.replace.to) : null;
  };
  it("a misspelt field, function or value is one click from right", () => {
    expect(fixed("priorty = HIGH")).toBe("priority = HIGH");
    expect(fixed("due < startOfWek(-1w)")).toBe("due < startOfWeek(-1w)");
    expect(fixed("priority = HIHG")).toBe("priority = HIGH");
    // Nothing near: no fix offered.
    expect(fixed("zzzzzzzz = 1")).toBeNull();
  });
});

describe("variables are people, teams, projects and sprints", () => {
  const errs = (cql: string) => {
    const p = parseCql(cql);
    return typecheck(p.query, { customFields: [] }, cql, p.spans).diagnostics.filter((d) => d.severity === "error");
  };
  it("are allowed on those fields", () => {
    expect(errs("assignee = $speaker AND team IN ($team) AND project = $project AND sprint = $sprint")).toEqual([]);
  });
  it("are refused on dates and numbers (no silent `has a due date`)", () => {
    expect(errs("due < $d")[0]).toMatchObject({ code: "CQL_TYPE_MISMATCH", message: expect.stringContaining("can't be used on `due`") });
    expect(errs("due = $d")).toHaveLength(1);
    expect(errs("points > $n")).toHaveLength(1);
    expect(errs("priority = $p")).toHaveLength(1);
  });
  it("are refused as function arguments", () => {
    expect(errs("key IN updatedBy(me, $d)")[0]).toMatchObject({ code: "CQL_TYPE_MISMATCH", message: expect.stringContaining("doesn't take variables") });
    expect(errs("assignee IN membersOf($team)")).toHaveLength(1);
  });
  it("updatedBy takes a person: a name, or me — no other function", () => {
    expect(errs("key IN updatedBy(me)")).toEqual([]);
    expect(errs('key IN updatedBy("Dana")')).toEqual([]);
    expect(errs("key IN updatedBy(now())")).toHaveLength(1);
  });
});

describe("typecheck — history (WAS / CHANGED)", () => {
  it("accepts the Jira forms on the fields Activity records", () => {
    for (const q of [
      'status WAS "In Progress"',
      "status WAS IN (todo, done) AFTER -30d",
      "status WAS NOT done BEFORE 2026-10-01",
      "priority WAS HIGH ON 2026-10-10",
      "assignee WAS me BY me",
      "assignee WAS EMPTY",
      "sprint WAS IN openSprints()",
      'status CHANGED FROM "In Progress" TO todo AFTER -14d',
      "priority CHANGED BY membersOf(Platform) DURING (startOfWeek(-1w), endOfWeek(-1w))",
      "due CHANGED",
      "due WAS 2026-10-20",
      "completed CHANGED AFTER startOfMonth()",
    ]) {
      expect(codes(q).filter((c) => c !== "CQL_NEQ_EXCLUDES_EMPTY"), q).toEqual([]);
    }
  });

  it("types each part: values as the field, BY as people, the rest as dates", () => {
    // The same finding `priority = URGENT` gets.
    expect(codes("priority WAS URGENT")).toEqual(codes("priority = URGENT"));
    expect(codes("priority CHANGED TO URGENT")).toEqual(codes("priority = URGENT"));
    expect(codes("priority = URGENT")).toHaveLength(1);
    expect(codes("status CHANGED BY 2026-10-01")).toEqual(["CQL_TYPE_MISMATCH"]);
    expect(codes("status CHANGED AFTER me")).toEqual(["CQL_TYPE_MISMATCH"]);
    expect(codes("status WAS EMPTY")).toEqual(["CQL_TYPE_MISMATCH"]);
  });

  it("FROM / TO only with CHANGED, ON alone", () => {
    expect(codes("status WAS done FROM todo")).toEqual(["CQL_TYPE_MISMATCH"]);
    expect(codes("status CHANGED ON 2026-10-01 AFTER 2026-09-01")).toEqual(["CQL_TYPE_MISMATCH"]);
  });

  it("fields history doesn't record say which ones it does", () => {
    const d = check("cancelReason CHANGED").diagnostics[0];
    expect(d.code).toBe("CQL_HISTORY_UNSUPPORTED");
    expect(d.message).toContain("status");
    expect(d.message).not.toContain("cancelReason");
  });
});
