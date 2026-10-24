import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { handlerCode } from "@/lib/auth/__tests__/gate-bits";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";

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

  it("the org-scoped work-item reads gate on the item's project too", () => {
    // `/work-items/{itemId}` and its comments live outside projects/[projectId],
    // so the scan above can't see them. They resolve the item's project and
    // gate on it through readableItemProjectId, which runs requireProjectRead.
    for (const f of ["work-items/[itemId]/route.ts", "work-items/[itemId]/comments/route.ts"]) {
      const src = readFileSync(join("src/app/api/v1/orgs/[orgId]", f), "utf8");
      const get = src.slice(src.indexOf("export async function GET"));
      expect(get, f).toMatch(/readableItemProjectId\(\s*ctx\s*,/);
    }
    expect(readFileSync("src/lib/work-items/read.server.ts", "utf8")).toMatch(/requireProjectRead\(ctx, projectId, action\)/);
  });
});

/**
 * Every project-scoped WRITE must ask the same question.
 *
 * Visibility decides whether a non-member may act in a project at all
 * (project-role.ts). The reads were held to that above; 32 writes were not.
 * They gated on the action's org bit alone (`requireAccess(ctx, "ITEM_CREATE",
 * …)`), or on `requireProjectManage` with a bit every MEMBER holds, which
 * passes before the manager check is reached. So on a project that opted into
 * `teamScopedAccess`, a non-member who could see none of it could still create
 * items there, and delete, merge, duplicate (which echoes the source) and
 * comment on its items by id.
 *
 * The rule: a write handler, with the helpers it calls, runs a visibility
 * check. The one exception is a write gated by `requireProjectManage` /
 * `canAdministerProject` on a bit no MEMBER holds (PROJECT_UPDATE,
 * WORKFLOW_MANAGE, …): its org-wide holders keep their reach by design
 * (project-access.ts, "Writing inside a project still follows the
 * permission"). A MEMBER bit there is no exception, because that gate passes
 * every member.
 */
const VISIBLE = /\b(?:requireProjectRead|requireProjectVisible|isProjectVisible|canReadProject|readableItemProjectId|assertProjectRead|canManageProject|getManagedProjectIds|readableDocument)\(/;
const MANAGE_GATE = /\b(?:requireProjectManage|canAdministerProject)\(\s*ctx\s*,\s*[^,)]+(?:,\s*Permission\.([A-Z_]+))?/g;
const WRITES = ["POST", "PUT", "PATCH", "DELETE"];

/** Why this handler may write without a visibility check, or null if it may not. */
function exemptBy(code: string): string | null {
  const bits = [...code.matchAll(MANAGE_GATE)].map((m) => (m[1] ?? "PROJECT_UPDATE") as keyof typeof Permission);
  if (bits.length === 0) return null;
  return bits.every((b) => (RolePermissions.MEMBER & Permission[b]) === 0n) ? bits.join(",") : null;
}

describe("project-scoped writes go through the team-aware gate", () => {
  const handlers = routeFiles(ROOT).flatMap((f) => {
    const src = readFileSync(f, "utf8");
    return WRITES.flatMap((m) => {
      const code = handlerCode(src, m, f);
      return code ? [{ at: `${m} ${f.slice(ROOT.length)}`, code }] : [];
    });
  });

  it("scanned the real write handlers", () => {
    expect(handlers.length).toBeGreaterThan(100);
    expect(handlers.map((h) => h.at)).toContain("POST /work-items/route.ts");
  });

  it("every write checks the project is visible, unless only elevated managers pass its gate", () => {
    const offenders = handlers.filter((h) => !VISIBLE.test(h.code) && !exemptBy(h.code)).map((h) => h.at);
    expect(offenders).toEqual([]);
  });

  it("a MEMBER bit never exempts a write", () => {
    // Pins the exemption's reasoning: these gates pass every member, so they
    // must not count as an elevated-manager gate.
    expect(exemptBy("await requireProjectManage(ctx, projectId, Permission.OKR_UPDATE);")).toBeNull();
    expect(exemptBy("await requireProjectManage(ctx, projectId, Permission.ITEM_CREATE);")).toBeNull();
    expect(exemptBy("await requireProjectManage(ctx, projectId);")).toBe("PROJECT_UPDATE");
  });

  it("the org-scoped item writes reach the project handlers that check", () => {
    // They resolve the item's project and hand off to the project route, so
    // the scan above covers them only through that delegation.
    const byId = readFileSync("src/app/api/v1/orgs/[orgId]/work-items/[itemId]/route.ts", "utf8");
    const comments = readFileSync("src/app/api/v1/orgs/[orgId]/work-items/[itemId]/comments/route.ts", "utf8");
    expect(byId).toMatch(/from "\.\.\/\.\.\/projects\/\[projectId\]\/work-items\/\[itemId\]\/route"/);
    expect(comments).toMatch(/from "\.\.\/\.\.\/\.\.\/projects\/\[projectId\]\/work-items\/\[itemId\]\/comments\/route"/);
  });
});
