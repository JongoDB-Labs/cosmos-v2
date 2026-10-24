import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { handlerCode } from "@/lib/auth/__tests__/gate-bits";

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
 * (project-role.ts). The reads were held to that above; the writes were not,
 * and on a project that opted into `teamScopedAccess` a non-member who could
 * see none of it could still write there by id:
 *
 *   - 32 writes gated on the action's org bit alone, or on
 *     `requireProjectManage` with a bit every MEMBER holds (which passes before
 *     the manager check), so any member could create, delete, merge, duplicate
 *     (echoing the source) and comment on its items.
 *   - 61 more passed `requireProjectManage` on an org-wide elevated bit
 *     (PROJECT_UPDATE, WORKFLOW_MANAGE, SPRINT_*, …), so a work role holding one
 *     managed projects it could not see.
 *
 * The rule now has no exception: a write handler, with the helpers it calls,
 * runs a visibility check, whatever bit it gates on. Org owners and admins lose
 * nothing by it, because `isProjectVisible` lets them see every project.
 */
const VISIBLE = /\b(?:requireProjectRead|requireProjectVisible|requireProjectVisibleIf|inVisibleProject|isProjectVisible|canReadProject|readableItemProjectId|assertProjectRead|canManageProject|getManagedProjectIds|readableDocument)\(/;
const WRITES = ["POST", "PUT", "PATCH", "DELETE"];

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

  it("every write checks the project is visible, whatever bit it gates on", () => {
    expect(handlers.filter((h) => !VISIBLE.test(h.code)).map((h) => h.at)).toEqual([]);
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

/**
 * The rule doesn't stop at the `projects/[projectId]` tree. A write anywhere
 * else that touches a project is held to it too: one that names a project
 * (a body or query `projectId` or `projectIds`), writes a record that belongs
 * to one (any model with a `projectId` column, read from the schema so a new
 * one is covered without editing this file), or loads such a record by id and
 * then writes anything (a meeting's attendees, a field's binding to a type). The first scan stopped at the tree, and
 * meetings, time entries, contracts and custom fields filed under a
 * team-scoped project could be changed by people kept out of it, though their
 * reads already hid them.
 *
 * Two named lists, each pinned exactly in both directions: a listed route that
 * gains a check, or goes away, fails here until it's taken off.
 */
const PROJECT_MODELS = (() => {
  const schema = readFileSync("src/../prisma/schema.prisma", "utf8");
  const models = new Set<string>();
  let current = "";
  for (const line of schema.split("\n")) {
    const m = line.match(/^model (\w+) \{/);
    if (m) current = m[1];
    else if (/^  projectId +String/.test(line) && current) models.add(current[0].toLowerCase() + current.slice(1));
  }
  return [...models];
})();
const WRITES_A_PROJECT_MODEL = new RegExp(
  `\\b(?:prisma|tx)\\.(?:${PROJECT_MODELS.join("|")})\\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\\(`,
);
const LOADS_A_PROJECT_MODEL = new RegExp(
  `\\b(?:prisma|tx)\\.(?:${PROJECT_MODELS.join("|")})\\.(?:findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow)\\(`,
);
const WRITES_ANYTHING = /\b(?:prisma|tx)\.\w+\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$transaction\(/;
/** Saved views gate through the viewer's readable projects. */
const VISIBLE_ANYWHERE = new RegExp(`${VISIBLE.source}|\\b(?:getReadableProjectIds|getVisibleProjectIds|visibleProjectIdsForActor|viewerScope)\\(`);

/**
 * Modules whose READS aren't team-scoped either: anyone with the module's bit
 * sees every record, whatever its project. Gating only their writes would
 * refuse a change to a record its author can plainly see, so they are held
 * back for one decision covering reads and writes together (raised to ops
 * 2026-10-24). Listed so none can be forgotten, and none added silently.
 */
const NOT_TEAM_SCOPED = new Set([
  // Chat channels: visible by channel membership, not by project.
  "POST /v1/orgs/[orgId]/chat/channels/route.ts",
  "PATCH /v1/orgs/[orgId]/chat/channels/[channelId]/route.ts",
  "DELETE /v1/orgs/[orgId]/chat/channels/[channelId]/route.ts",
  "POST /v1/orgs/[orgId]/chat/channels/[channelId]/commands/route.ts",
  "POST /v1/orgs/[orgId]/chat/channels/[channelId]/join/route.ts",
  "POST /v1/orgs/[orgId]/chat/channels/[channelId]/read/route.ts",
  // Data classifications: every member reads them, to render banners.
  "POST /v1/orgs/[orgId]/classifications/route.ts",
  "PUT /v1/orgs/[orgId]/classifications/[classificationId]/route.ts",
  "PATCH /v1/orgs/[orgId]/classifications/[classificationId]/route.ts",
  "DELETE /v1/orgs/[orgId]/classifications/[classificationId]/route.ts",
  // Feedback: an org-wide board; a project is where a report is routed.
  "POST /v1/orgs/[orgId]/feedback/route.ts",
  "PUT /v1/orgs/[orgId]/feedback/[feedbackId]/route.ts",
  "DELETE /v1/orgs/[orgId]/feedback/[feedbackId]/route.ts",
  "POST /v1/orgs/[orgId]/feedback/[feedbackId]/vote/route.ts",
  "DELETE /v1/orgs/[orgId]/feedback/[feedbackId]/vote/route.ts",
  "DELETE /v1/orgs/[orgId]/feedback/[feedbackId]/comments/[commentId]/route.ts",
  "POST /v1/orgs/[orgId]/feedback/[feedbackId]/merge/route.ts",
  "PUT /v1/orgs/[orgId]/feedback/remediation-config/route.ts",
  // Expenses: finance roles read every expense in the org.
  "POST /v1/orgs/[orgId]/finance/expenses/route.ts",
  "PUT /v1/orgs/[orgId]/finance/expenses/[expenseId]/route.ts",
  "DELETE /v1/orgs/[orgId]/finance/expenses/[expenseId]/route.ts",
  "POST /v1/orgs/[orgId]/finance/expenses/[expenseId]/approve/route.ts",
  "POST /v1/orgs/[orgId]/finance/expenses/[expenseId]/submit/route.ts",
  "POST /v1/orgs/[orgId]/finance/expenses/bulk-approve/route.ts",
  "POST /v1/orgs/[orgId]/import/json/route.ts",
]);

/** Writes the scan flags that write to no project the caller chooses, and why. */
const NOT_A_PROJECT_WRITE: Record<string, string> = {
  "POST /v1/orgs/[orgId]/projects/route.ts": "creates the project; its creator is its first member",
  "POST /v1/orgs/[orgId]/api-keys/route.ts": "naming projects only narrows the key, whose reach never exceeds its minter's",
  "POST /v1/orgs/[orgId]/contracts/route.ts": "an org-level contract: the body can't name a project",
  "POST /v1/orgs/[orgId]/documents/route.ts": "files the document under no project",
  "POST /v1/orgs/[orgId]/chat/dms/route.ts": "a direct message belongs to no project",
  "POST /v1/orgs/[orgId]/feedback/report-bug/route.ts": "the system routes the report to a project, not the caller",
  "DELETE /v1/orgs/[orgId]/members/[memberId]/route.ts": "removing a member clears their own Teams conversation",
  "PUT /v1/orgs/[orgId]/microsoft/teams-app/notifications/route.ts": "the caller's own Teams notification settings",
  "DELETE /v1/orgs/[orgId]/workflow-templates/[templateId]/route.ts": "org templates belong to no project",
};

describe("writes outside projects/[projectId] that touch a project are gated too", () => {
  const API = "src/app/api";
  const flagged = routeFiles(API)
    .filter((f) => !f.startsWith(ROOT))
    .flatMap((f) => {
      const src = readFileSync(f, "utf8");
      return WRITES.flatMap((m) => {
        const code = handlerCode(src, m, f);
        if (!code) return [];
        const touches =
          WRITES_A_PROJECT_MODEL.test(code) ||
          /\bprojectIds?\b/.test(code) ||
          (LOADS_A_PROJECT_MODEL.test(code) && WRITES_ANYTHING.test(code));
        if (!touches) return [];
        return [{ at: `${m} ${f.slice(API.length)}`, gated: VISIBLE_ANYWHERE.test(code) }];
      });
    });

  it("read the schema and the real routes", () => {
    expect(PROJECT_MODELS).toEqual(expect.arrayContaining(["workItem", "syncMeeting", "timeEntry", "contract"]));
    expect(flagged.length).toBeGreaterThan(40);
    // The ones this rule was written for are in scope, and gated.
    for (const at of [
      "POST /v1/orgs/[orgId]/meetings/route.ts",
      "PUT /v1/orgs/[orgId]/time-entries/[entryId]/route.ts",
      "DELETE /v1/orgs/[orgId]/contracts/[contractId]/route.ts",
      "POST /v1/orgs/[orgId]/meetings/[meetingId]/attendees/route.ts",
      "POST /v1/orgs/[orgId]/work-item-types/[typeId]/fields/route.ts",
    ]) {
      expect(flagged.find((h) => h.at === at), at).toMatchObject({ gated: true });
    }
  });

  it("every one checks visibility, or is listed with its reason", () => {
    const ungated = flagged.filter((h) => !h.gated).map((h) => h.at);
    expect(ungated.filter((at) => !NOT_TEAM_SCOPED.has(at) && !(at in NOT_A_PROJECT_WRITE))).toEqual([]);
  });

  it("the lists are exact: every entry is real and still ungated", () => {
    const ungated = new Set(flagged.filter((h) => !h.gated).map((h) => h.at));
    expect([...NOT_TEAM_SCOPED, ...Object.keys(NOT_A_PROJECT_WRITE)].filter((at) => !ungated.has(at))).toEqual([]);
  });
});
