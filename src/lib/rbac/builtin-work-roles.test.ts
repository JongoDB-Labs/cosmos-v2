import { describe, expect, it } from "vitest";
import { BUILTIN_WORK_ROLES, BUILTIN_KEY_PREFIX } from "./builtin-work-roles";
import { Permission, permissionMaskFromKeys, maskToDb } from "./permissions";
import { readFileSync } from "node:fs";

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
  it("Project Manager grants no ORG-WIDE project administration", () => {
    // A work role is additive on top of the org role, so any of these would make
    // the holder an administrator of EVERY project in the org — which is the bug
    // this catalog change fixed. Each is still theirs inside a project they
    // MANAGE, via requireProjectManage.
    const pm = BUILTIN_WORK_ROLES.find((r) => r.key === "builtin.project-manager")!;
    expect(pm.permissions).not.toContain("PROJECT_MANAGE");
    expect(pm.permissions).not.toContain("PROJECT_UPDATE");
    for (const p of ["SPRINT_CREATE", "SPRINT_UPDATE", "SPRINT_COMPLETE"]) {
      expect(pm.permissions).not.toContain(p);
    }
    for (const p of ["BOARD_UPDATE", "BOARD_DELETE", "BOARD_MANAGE"]) {
      expect(pm.permissions).not.toContain(p);
    }
    expect(pm.permissions).not.toContain("ITEM_DELETE");
    expect(pm.permissions).not.toContain("ITEM_BULK_EDIT");
    // …but they must still be able to CREATE a project, which is what makes them
    // its MANAGER and hands back everything above, scoped to that project.
    expect(pm.permissions).toContain("PROJECT_CREATE");
  });

  it("a Project Manager cannot approve time", () => {
    // Running a project and signing off company time are different authorities.
    // Bundling them meant granting someone a project silently made them an
    // approver of everyone's hours — 16 people in the first org to hit it.
    const pm = BUILTIN_WORK_ROLES.find((r) => r.key === "builtin.project-manager")!;
    expect(pm.permissions).not.toContain("TIME_APPROVE");
    // They still SEE time — a manager tracking delivery needs the hours.
    expect(pm.permissions).toContain("TIME_READ");
  });

  it("Reviewer / Approver is where time approval lives instead", () => {
    // The separation only works if there is somewhere else to put the authority.
    const ra = BUILTIN_WORK_ROLES.find((r) => r.key === "builtin.reviewer-approver")!;
    expect(ra.permissions).toContain("TIME_APPROVE");
    expect(ra.permissions).toContain("TIME_READ");
  });

  it("the LATEST re-sync migration's mask still matches the catalog", () => {
    // The migration carries a literal because SQL cannot read this file. If the
    // catalog changes and the migration does not, existing orgs silently keep
    // the old grants while new orgs get the new ones — a split-brain that is
    // invisible until someone compares two orgs.
    //
    // Points at the NEWEST re-sync. Earlier ones are history: they have already
    // run in production, and their literals must never be edited to match a
    // catalog they predate.
    const sql = readFileSync(
      "prisma/migrations/20260801220000_project_manager_loses_time_approve/migration.sql",
      "utf8",
    );
    const pm = BUILTIN_WORK_ROLES.find((r) => r.key === "builtin.project-manager")!;
    expect(sql).toContain(maskToDb(permissionMaskFromKeys(pm.permissions)));
  });

  it("the change from the previous re-sync is TIME_APPROVE and NOTHING else", () => {
    // A mask literal is opaque. A typo, or an unrelated catalog edit made in the
    // same commit, would quietly revoke other permissions from 16 people and
    // look identical in review.
    const pm = BUILTIN_WORK_ROLES.find((r) => r.key === "builtin.project-manager")!;
    const previous = 283954336511455713695124606159872n;
    expect(previous - permissionMaskFromKeys(pm.permissions)).toBe(
      Permission.TIME_APPROVE,
    );
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
