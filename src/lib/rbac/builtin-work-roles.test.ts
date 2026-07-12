import { describe, expect, it } from "vitest";
import { BUILTIN_WORK_ROLES, BUILTIN_KEY_PREFIX } from "./builtin-work-roles";
import { Permission } from "./permissions";

describe("BUILTIN_WORK_ROLES catalog", () => {
  it("has 8 entries with unique keys and names", () => {
    expect(BUILTIN_WORK_ROLES).toHaveLength(8);
    const keys = BUILTIN_WORK_ROLES.map((r) => r.key);
    const names = BUILTIN_WORK_ROLES.map((r) => r.name.toLowerCase());
    expect(new Set(keys).size).toBe(8);
    expect(new Set(names).size).toBe(8);
  });
  it("every key carries the reserved prefix", () => {
    for (const r of BUILTIN_WORK_ROLES) expect(r.key.startsWith(BUILTIN_KEY_PREFIX)).toBe(true);
  });
  it("every permission is a real Permission key, deduplicated, non-empty", () => {
    for (const r of BUILTIN_WORK_ROLES) {
      expect(r.permissions.length).toBeGreaterThan(0);
      expect(new Set(r.permissions).size).toBe(r.permissions.length);
      for (const p of r.permissions) expect(Permission).toHaveProperty(p);
    }
  });
  it("descriptions are single sentences", () => {
    for (const r of BUILTIN_WORK_ROLES) {
      expect(r.description.length).toBeGreaterThan(10);
      expect(r.description.trim().split(". ").length).toBeLessThanOrEqual(2);
    }
  });
  it("Analyst grants no write bits", () => {
    const analyst = BUILTIN_WORK_ROLES.find((r) => r.key === "builtin.analyst")!;
    const writes = analyst.permissions.filter((p) =>
      /_(CREATE|UPDATE|DELETE|MANAGE|APPROVE|CLOSE|ASSIGN|BULK_EDIT|COMPLETE)$/.test(p) &&
      !["COMMENT_CREATE", "REPORT_CREATE"].includes(p),
    );
    expect(writes).toEqual([]);
  });
});
