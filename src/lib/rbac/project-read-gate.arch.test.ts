import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every project-scoped READ must ask whether the actor may see THAT project.
 *
 * #505 moved 47 routes under `projects/[projectId]` onto
 * `requireProjectRead(ctx, projectId, ACTION)` — `requireAccess` for the
 * action's own bit and any ABAC policy, THEN `isProjectVisible` for team
 * scoping. Its own finding was that gating on the org-wide bit alone left "the
 * same rows readable by asking the project's own endpoint".
 *
 * Three GET handlers were missed, including `work-items` — the highest-traffic
 * project read there is. Nothing failed, because nothing asserted the rule:
 * team-scoped access is opt-in and defaults off, so the gap is invisible until
 * an org turns it on, which is precisely when they believe they are protected.
 *
 * So this asserts the RULE rather than the 50 call sites: no route under
 * `projects/[projectId]` may gate a read on a bare `requireAccess(ctx,
 * "*_READ", …)`. A route added tomorrow fails here instead of shipping.
 *
 * A file that legitimately cannot use the helper — `key-results/[krId]/
 * checkins` passes an extra `objectiveId` attribute that `requireProjectRead`
 * would drop — opts out by doing both halves itself, which this recognises by
 * requiring an `isProjectVisible` call in the same file.
 */

const ROOT = "src/app/api/v1/orgs/[orgId]/projects/[projectId]";

/** `requireAccess(ctx, "SOMETHING_READ"` — a read gated on the bit alone. */
const BARE_READ = /requireAccess\(\s*ctx\s*,\s*"[A-Z_]*READ"/;

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

describe("project-scoped reads go through the team-aware gate", () => {
  const files = routeFiles(ROOT);

  it("scanned the real route tree", () => {
    // A move or rename must fail loudly rather than scan nothing and pass.
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((f) => f.includes("work-items"))).toBe(true);
  });

  it("no route gates a READ on a bare requireAccess without a visibility check", () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      if (!BARE_READ.test(src)) return false;
      // Opt-out: the file does the visibility half itself.
      return !src.includes("isProjectVisible");
    });
    expect(offenders).toEqual([]);
  });

  it("the highest-traffic project read is gated", () => {
    // Named explicitly because this is the one that was missed, and the one
    // whose regression would matter most.
    const workItems = readFileSync(join(ROOT, "work-items/route.ts"), "utf8");
    // The CALL, not the import — reverting just the call left the import behind
    // and a `toContain("requireProjectRead")` passed against the reverted bug.
    expect(workItems).toMatch(/await\s+requireProjectRead\(\s*ctx\s*,/);
  });
});
