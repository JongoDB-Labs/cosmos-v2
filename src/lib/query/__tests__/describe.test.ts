import { describe, it, expect } from "vitest";
import { CQL_EXAMPLES, cqlFromReply, cqlReference, describeField, fieldNames } from "../describe";
import { FIELDS, fieldDef } from "../fields";
import { FUNCTIONS } from "../functions";
import { parseCql } from "../parser";
import { typecheck } from "../typecheck";
import { hasErrors } from "../errors";

describe("the CQL reference for the assistant", () => {
  it("names every queryable field and every function, from the registries", () => {
    const ref = cqlReference();
    for (const f of FIELDS) if (!f.pending) expect(ref).toContain(`- ${f.id}`);
    for (const fn of FUNCTIONS) if (!fn.pending) expect(ref).toContain(`- ${fn.name}(`);
    expect(fieldNames().split(", ")).toHaveLength(FIELDS.filter((f) => !f.pending).length);
  });

  it("describes a field's values and operators", () => {
    expect(describeField(fieldDef("priority"))).toBe(
      "priority (LOW|MEDIUM|HIGH|CRITICAL; = != IN NOT IN < <= > >= WAS CHANGED): LOW < MEDIUM < HIGH < CRITICAL.",
    );
    expect(describeField(fieldDef("rank"))).toMatch(/ORDER BY only/);
  });

  it("lists the org's custom fields with their options", () => {
    const ref = cqlReference([{ key: "sev", name: "Severity", fieldType: "SELECT", options: ["S1", "S2"] }]);
    expect(ref).toContain('- sev ("Severity", select; options S1|S2)');
  });

  it("every example parses and typechecks", () => {
    for (const e of CQL_EXAMPLES) {
      const parsed = parseCql(e.q);
      expect(hasErrors(parsed.diagnostics), e.q).toBe(false);
      expect(hasErrors(typecheck(parsed.query, { customFields: [] }, e.q, parsed.spans).diagnostics), e.q).toBe(false);
    }
  });
});

describe("cqlFromReply", () => {
  it.each([
    ["priority = HIGH", "priority = HIGH"],
    ["  `priority = HIGH`  ", "priority = HIGH"],
    ["CQL: priority = HIGH", "priority = HIGH"],
    ["```cql\npriority = HIGH\n```", "priority = HIGH"],
    ["Here you go:\n```\nassignee = me\n```\nThis finds yours.", "assignee = me"],
    ["\n\nassignee = me\nexplanation", "assignee = me"],
    ["", ""],
  ])("%j → %j", (raw, want) => {
    expect(cqlFromReply(raw)).toBe(want);
  });
});
