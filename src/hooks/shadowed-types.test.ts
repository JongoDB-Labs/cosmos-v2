import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SHADOW_TYPE_KEYS } from "./use-work-item-types";

/**
 * Guards the CLASS of bug, not one instance of it.
 *
 * Six entities — Goal, KeyResult, Kpi, Milestone, Objective, Risk — exist as
 * Prisma models AND were also seeded as work-item types. A "Milestone" filed
 * from a New issue dialog is a WorkItem, so it never reaches the Milestones
 * board. SHADOW_TYPE_KEYS hides those from creation.
 *
 * That list was first written as "the cross-cutting types", so it caught every
 * `cross.*` key and missed `consulting.milestone_item` — seeded with name
 * "Milestone" and pluralName "Milestones", shadowing the same table just as
 * badly, in every Client Engagement project.
 *
 * So this does not hard-code a list. It reads the seed files, finds every
 * seeded type whose NAME collides with a real model, and requires each one to
 * be registered. A new sector that seeds its own "Risk" or "Goal" fails here
 * rather than shipping a duplicate.
 */

// Entities with their own Prisma model, board and API. A work-item type sharing
// one of these names is a duplicate of a real table by construction.
const REAL_ENTITY_NAMES = new Set([
  "Goal",
  "Key Result",
  "KPI",
  "Milestone",
  "Objective",
  "Risk",
]);

const SEED_DIRS = ["prisma/seed/sectors", "prisma/seed/shared"];

/** Every `key: "…", name: "…"` pair declared across the seed files. */
function seededTypes(): { key: string; name: string; file: string }[] {
  const found: { key: string; name: string; file: string }[] = [];
  for (const dir of SEED_DIRS) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(dir, file), "utf8");
      const re = /key:\s*"([^"]+)",\s*name:\s*"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        found.push({ key: m[1], name: m[2], file: `${dir}/${file}` });
      }
    }
  }
  return found;
}

describe("work-item types that shadow a real table", () => {
  it("finds the seed declarations at all (guards the regex itself)", () => {
    // Without this, a seed-format change would silently make every assertion
    // below vacuous — the scan would return nothing and trivially pass.
    const all = seededTypes();
    expect(all.length).toBeGreaterThan(20);
    expect(all.map((t) => t.key)).toContain("cross.milestone");
  });

  it("registers every seeded type whose name collides with a real model", () => {
    const unregistered = seededTypes()
      .filter((t) => REAL_ENTITY_NAMES.has(t.name))
      .filter((t) => !SHADOW_TYPE_KEYS.has(t.key))
      .map((t) => `${t.key} ("${t.name}") in ${t.file}`);

    expect(unregistered).toEqual([]);
  });

  it("does not register keys that no longer exist in the seeds", () => {
    // A stale entry is harmless at runtime but means the list has drifted from
    // reality, which is how the original gap went unnoticed.
    const seededKeys = new Set(seededTypes().map((t) => t.key));
    const stale = [...SHADOW_TYPE_KEYS].filter((k) => !seededKeys.has(k));
    expect(stale).toEqual([]);
  });
});
