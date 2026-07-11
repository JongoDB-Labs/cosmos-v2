import { describe, it, expect } from "vitest";
import { Priority } from "@prisma/client";
import { parseJql, suggestJql, type QueryVocab } from "./jql";

/** A representative vocabulary mirroring what the Issues facets provide. */
const VOCAB: QueryVocab = {
  project: [
    { value: "p_fsc", label: "Falcon Shield", aliases: ["FSC"] },
    { value: "p_atn", label: "Atlantis", aliases: ["ATN"] },
  ],
  type: [
    { value: "t_bug", label: "Bug", aliases: ["bug"] },
    { value: "t_story", label: "Story", aliases: ["story"] },
  ],
  status: [
    { value: "todo", label: "To Do", aliases: ["todo"] },
    { value: "in-progress", label: "In Progress", aliases: ["in-progress"] },
    { value: "done", label: "Done", aliases: ["done"] },
  ],
  priority: [
    { value: Priority.CRITICAL, label: "Critical" },
    { value: Priority.HIGH, label: "High" },
    { value: Priority.MEDIUM, label: "Medium" },
    { value: Priority.LOW, label: "Low" },
  ],
  assignee: [
    { value: "u_ada", label: "Ada Lovelace" },
    { value: "u_alan", label: "Alan Turing" },
  ],
  label: [
    { value: "urgent", label: "urgent" },
    { value: "backend", label: "backend" },
  ],
  cycle: [{ value: "c_1", label: "Sprint 1", aliases: ["1"] }],
  currentUserId: "u_ada",
};

describe("parseJql — structured clauses", () => {
  it("parses a field = value clause into the filter", () => {
    const r = parseJql("project = FSC", VOCAB);
    expect(r.errors).toEqual([]);
    expect(r.filter.projectIds).toEqual(["p_fsc"]);
    expect(r.clauses).toHaveLength(1);
    expect(r.clauses[0]).toMatchObject({ field: "project", operator: "=", value: "p_fsc" });
  });

  it("accepts the `is`, `:` and `==` operators as equality synonyms", () => {
    expect(parseJql("type is bug", VOCAB).filter.typeIds).toEqual(["t_bug"]);
    expect(parseJql("type:bug", VOCAB).filter.typeIds).toEqual(["t_bug"]);
    expect(parseJql("type == bug", VOCAB).filter.typeIds).toEqual(["t_bug"]);
  });

  it("resolves priority by name, case-insensitively", () => {
    const r = parseJql("priority = high", VOCAB);
    expect(r.errors).toEqual([]);
    expect(r.filter.priorities).toEqual([Priority.HIGH]);
  });

  it("resolves a quoted multi-word status value", () => {
    const r = parseJql('status = "In Progress"', VOCAB);
    expect(r.errors).toEqual([]);
    expect(r.filter.columnKeys).toEqual(["in-progress"]);
  });

  it("resolves assignee sentinels (me / unassigned)", () => {
    expect(parseJql("assignee = me", VOCAB).filter.assigneeIds).toEqual(["u_ada"]);
    expect(parseJql("assignee is unassigned", VOCAB).filter.assigneeIds).toEqual(["unassigned"]);
    expect(parseJql("assignee = Ada", VOCAB).filter.assigneeIds).toEqual(["u_ada"]);
  });

  it("combines several clauses and collects free text as `text`", () => {
    const r = parseJql("project = FSC priority = high overdue login", VOCAB);
    expect(r.errors).toEqual([]);
    expect(r.filter.projectIds).toEqual(["p_fsc"]);
    expect(r.filter.priorities).toEqual([Priority.HIGH]);
    expect(r.filter.text).toBe("overdue login");
    expect(r.text).toBe("overdue login");
  });

  it("treats a bare query (no clauses) as free text", () => {
    const r = parseJql("payment gateway timeout", VOCAB);
    expect(r.clauses).toEqual([]);
    expect(r.filter.text).toBe("payment gateway timeout");
  });

  it("applies an unknown label verbatim (tags are free-form)", () => {
    const r = parseJql("label = shipping", VOCAB);
    expect(r.errors).toEqual([]);
    expect(r.filter.labels).toEqual(["shipping"]);
  });

  it("normalises a known label to its canonical casing", () => {
    const r = parseJql("tag = URGENT", VOCAB);
    expect(r.filter.labels).toEqual(["urgent"]);
  });
});

describe("parseJql — parse-error feedback", () => {
  it("reports an unknown value for a scoped field", () => {
    const r = parseJql("project = Nope", VOCAB);
    expect(r.filter.projectIds).toBeUndefined();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/No project matches "Nope"/);
  });

  it("reports a missing value", () => {
    const r = parseJql("project =", VOCAB);
    expect(r.errors[0].message).toMatch(/Missing value for "project"/);
  });

  it("reports a missing value when another clause immediately follows", () => {
    const r = parseJql("project = status = done", VOCAB);
    expect(r.errors.some((e) => /Missing value for "project"/.test(e.message))).toBe(true);
    // …but the following clause still parses.
    expect(r.filter.columnKeys).toEqual(["done"]);
  });

  it("flags unsupported operators (!= / is not) instead of silently ignoring", () => {
    const neq = parseJql("priority != low", VOCAB);
    expect(neq.filter.priorities).toBeUndefined();
    expect(neq.errors[0].message).toMatch(/isn't supported yet/);

    const isNot = parseJql("assignee is not me", VOCAB);
    expect(isNot.errors[0].message).toMatch(/isn't supported yet/);
  });

  it("reports an unterminated quote", () => {
    const r = parseJql('status = "In Progress', VOCAB);
    expect(r.errors.some((e) => /Unterminated quote/.test(e.message))).toBe(true);
  });

  it("does not resolve clauses against an empty vocabulary but still parses text", () => {
    const r = parseJql("project = FSC hello");
    expect(r.errors.some((e) => /No project matches/.test(e.message))).toBe(true);
    expect(r.filter.text).toBe("hello");
  });
});

describe("suggestJql — autocomplete", () => {
  it("suggests field names for an empty query", () => {
    const s = suggestJql("", VOCAB);
    const labels = s.map((x) => x.label);
    expect(labels).toContain("project");
    expect(labels).toContain("priority");
    expect(s.every((x) => x.kind === "field")).toBe(true);
  });

  it("suggests field names by prefix", () => {
    const s = suggestJql("pr", VOCAB);
    const labels = s.map((x) => x.label);
    expect(labels).toEqual(expect.arrayContaining(["project", "priority"]));
    expect(labels).not.toContain("status");
    // Accepting one appends a trailing space, ready for the operator.
    expect(s.find((x) => x.label === "project")!.newInput).toBe("project ");
  });

  it("suggests operators after a completed field name", () => {
    const s = suggestJql("project ", VOCAB);
    expect(s.map((x) => x.label)).toEqual(["=", "is"]);
    expect(s.every((x) => x.kind === "operator")).toBe(true);
    expect(s[0].newInput).toBe("project = ");
  });

  it("suggests values after an operator", () => {
    const s = suggestJql("project = ", VOCAB);
    expect(s.every((x) => x.kind === "value")).toBe(true);
    expect(s.map((x) => x.label)).toEqual(expect.arrayContaining(["Falcon Shield", "Atlantis"]));
    // The echoed token prefers a single-token alias (the project key).
    expect(s.find((x) => x.label === "Falcon Shield")!.newInput).toBe("project = FSC ");
  });

  it("filters value suggestions by the partial being typed", () => {
    const s = suggestJql("project = atl", VOCAB);
    expect(s.map((x) => x.label)).toEqual(["Atlantis"]);
    expect(s[0].newInput).toBe("project = ATN ");
  });

  it("quotes a multi-word value when echoing it back", () => {
    const s = suggestJql("assignee = ", VOCAB);
    expect(s.find((x) => x.label === "Ada Lovelace")!.newInput).toBe('assignee = "Ada Lovelace" ');
  });

  it("suggests the next field after a completed clause", () => {
    const s = suggestJql("project = FSC ", VOCAB);
    expect(s.every((x) => x.kind === "field")).toBe(true);
    expect(s.map((x) => x.label)).toContain("status");
    expect(s.find((x) => x.label === "status")!.newInput).toBe("project = FSC status ");
  });
});
