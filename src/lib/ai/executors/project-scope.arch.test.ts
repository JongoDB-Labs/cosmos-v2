// @vitest-environment node
//
// An agent tool handed a projectId must ask whether the actor may OPEN it.
//
// The bug this locks out: every PM/OKR/milestone/work-item tool confirmed the
// project existed in the org (`projectInOrg`) and called that authorization. It
// is not. A project with `teamScopedAccess` is restricted to its members, and
// "exists in the org" is true of one the caller may not open — so a non-member
// read risks, blockers, deliverables, changes, objectives, goals, KPIs,
// milestones and item links straight through the assistant. Two of three
// production projects had team scoping on when this was found.
//
// The permission gates the tools carry cannot help: ANALYTICS_READ, ITEM_READ,
// OKR_READ and PROJECT_READ are all held by MEMBER and VIEWER. They authorise
// reading SOME project data and say nothing about WHICH project.
//
// A grep-based arch test is crude, but it is the only kind that fails for a NEW
// tool nobody thought to test — which is exactly how ten of these survived.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "src/lib/ai/executors");

/** Source with comments stripped, so the rule never fires on prose about it. */
function code(file: string): string {
  return readFileSync(join(DIR, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const files = readdirSync(DIR).filter(
  (f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f) && f !== "_ctx.ts",
);

describe("agent tools cannot read past project scoping", () => {
  it("has executor files to check", () => {
    // Guards the guard: an empty file list would make every assertion below
    // pass vacuously.
    expect(files.length).toBeGreaterThan(0);
  });

  it("no tool re-implements a bare project-existence check", () => {
    // `prisma.project.findFirst({ where: { id, orgId } })` as an authorization
    // step is the exact anti-pattern. Reaching for it again — under any helper
    // name — reintroduces the bypass.
    const offenders = files.filter((f) => {
      const src = code(f);
      return (
        /prisma\.project\.findFirst\(\{\s*where:\s*\{\s*id[^}]*orgId/.test(src) &&
        !/assertProjectRead/.test(src)
      );
    });

    expect(
      offenders,
      "use assertProjectRead — project EXISTENCE is not project ACCESS",
    ).toEqual([]);
  });

  /**
   * Files that accept a `projectId` and legitimately do not gate on it.
   *
   * An allowlist, not a silence: each entry names WHY, so adding a new one is a
   * decision somebody has to write down rather than a rule quietly weakened.
   */
  const NO_PROJECT_DATA_REACHED: Record<string, string> = {
    // The Note model has no projectId column. The field is accepted for
    // forward-compatibility and IGNORED, so no project-scoped row is reached.
    // If Note ever gains the column, this entry must go.
    "notes.ts": "accepts projectId for forward-compat and ignores it",
  };

  it("every tool file that takes a projectId gates on it", () => {
    // The positive form: if a file reads a caller-supplied projectId at all, it
    // must consult the scope helper somewhere.
    const offenders = files.filter((f) => {
      if (f in NO_PROJECT_DATA_REACHED) return false;
      const src = code(f);
      const takesProjectId = /projectId:\s*z\.string\(\)\.uuid\(\)/.test(src);
      const gates = /assertProjectRead|visibleProjectIdsForActor/.test(src);
      return takesProjectId && !gates;
    });

    expect(
      offenders,
      "a tool that accepts a projectId must check the actor may open it",
    ).toEqual([]);
  });

  /**
   * Models that carry a `projectId` (directly or through a parent), so a row of
   * one is project-scoped data and reaching it by id needs the scope check.
   *
   * This list closes the blind spot the FIRST version of this rule had: it only
   * looked at tools taking a `projectId` parameter, so it was blind to the far
   * larger set that take a CHILD id — `updateRisk(riskId)`,
   * `deleteComment(commentId)`, `updateKeyResult(keyResultId)` — and resolve the
   * project from the row. Thirty tools had that shape, and only reading the code
   * found them. Deliberately omits Note and CrmContact, which have no project.
   */
  /**
   * EVERY Prisma model carrying a `projectId`, derived from the schema rather
   * than curated by hand — 42 of them, not the 17 this list used to name.
   *
   * The omissions were the guard's real width, and `timeEntry` proves it: this
   * rule never examined `listTimeEntries`, so that function applied a
   * caller-supplied projectId raw for as long as the test existed and the suite
   * stayed green. Narrowing HAS_GATE did not help, because the function was
   * never looked at in the first place. A guard is only as wide as what it
   * reads, and a hand-kept list silently stops being the schema.
   *
   * Keep this in sync by regenerating it, not by remembering:
   *   grep -E '^\s*projectId\s' -B40 prisma/schema.prisma | grep '^model'
   */
  const PROJECT_SCOPED_MODELS = [
    "risk", "blocker", "deliverable", "changeRequest", "milestone",
    "objective", "keyResult", "goal", "kpi", "interval", "workItem",
    "workItemLink", "comment", "syncMeeting", "feedbackItem", "board",
    "document",
    // Added 2026-10-29: present in the schema, absent from this guard.
    "automationRule", "bill", "chatChannel", "clin", "contract", "customField",
    "dataClassification", "documentItemLink", "domainEvent", "expense", "flag",
    "journalLine", "milestoneSlip", "paceWeek", "pmLink",
    "projectCloseoutSnapshot", "projectMember", "projectPhase", "roadmapNode",
    "savedView", "staffingAllocation", "team", "teamsConversation",
    "timeEntry", "weeklyReportEntry", "workflow", "workflowAssignment",
    "workflowStatus",
  ];

  /**
   * Every top-level function in a file, as `name` → body.
   *
   * PER FUNCTION, not per file, and that distinction is the whole point. The
   * first version of this rule asked whether the FILE mentioned
   * `assertProjectRead` anywhere — so deleting the gate from one function
   * passed, because a dozen siblings in the same file still had theirs.
   * Mutation testing caught it: removing `listWorkItems`' gate, and
   * `updateRisk`'s, both went undetected. A rule that a real regression walks
   * straight through is worse than none, because it reads as coverage.
   */
  function functionsIn(file: string): Array<[string, string]> {
    const src = code(file);
    const out: Array<[string, string]> = [];
    for (const chunk of src.split(/\n(?=(?:export )?(?:async )?function )/)) {
      const m = chunk.match(/^(?:export )?(?:async )?function ([a-zA-Z0-9_]+)/);
      if (m) out.push([m[1], chunk]);
    }
    return out;
  }

  // CREATE and UPSERT included, and their absence was a real hole: the first
  // version listed only reads, updates and deletes, so `createMilestone`,
  // `createRisk` and `createKpi` were never checked at all — deleting their gate
  // passed. Mutation testing found it. A write into a project you cannot open is
  // as much a scope violation as a read out of one.
  const TOUCHES_SCOPED = new RegExp(
    `prisma\\.(?:${PROJECT_SCOPED_MODELS.join("|")})\\.(?:findFirst|findUnique|findMany|create|createMany|upsert|update|updateMany|delete|deleteMany)\\(`,
  );
  // `assertProjectManage` counts: it checks VISIBILITY first (via
  // requireProjectRead) and only then authority, so a function using it is
  // scoped as well as authorised. Writes use it instead of assertProjectRead
  // because the HTTP write routes use requireProjectManage — see _ctx.ts.
  // `readableTimeUserIds` is NOT a project gate and must never be accepted as
  // one. It answers "whose hours may I see" — self, or self + direct reports
  // for a supervisor — and says nothing about WHICH project those hours are on.
  // Accepting it let `list_time_entries` apply a caller-supplied projectId raw
  // for as long as this rule existed: the function satisfied the guard, so the
  // guard never looked at the project. That is the same shape as the bare
  // `projectInOrg` check this file was written to outlaw — a check that answers
  // a different question than the one being asked — and the test blessed it.
  const HAS_GATE =
    /assertProjectRead|assertProjectManage|getReadableProjectIds|visibleProjectIdsForActor|visibleProjectRecordsWhere/;

  /**
   * Writes that touch a project-scoped MODEL but never a project.
   *
   * Spelled out per function, so exempting a new one is a decision somebody has
   * to write down. Verify the claim before adding: the test is whether the
   * created row can carry a projectId AT ALL, not whether this call happens to
   * set one.
   */
  const ORG_LEVEL_WRITES = new Set([
    // FeedbackItem HAS a nullable projectId, but `create_feedback`'s zod schema
    // has no projectId field and its create() never sets one — every row it
    // makes is org-level. If the schema gains the field, this entry must go.
    "feedback.ts::createFeedback",
    // Expense HAS a projectId, but `logExpenseSchema` has no such field and the
    // create() never sets one — checked 2026-10-29, `projectId` does not appear
    // anywhere in finance.ts. Same precedent as createFeedback above: if the
    // schema gains the field, this entry must go.
    "finance.ts::logExpense",
  ]);

  /**
   * Exported helpers whose project scope is supplied BY THE CALLER, as an
   * argument, and which therefore cannot gate for themselves.
   *
   * This is a narrow exemption and it carries an obligation: the claim is about
   * the CALL SITES, so adding one means having read every caller. Verified
   * 2026-10-29 for the only entry.
   */
  const CALLER_SCOPED = new Set([
    // `teamFilter(orgId, teamId, projectIds)` constrains
    // `projectId: { in: projectIds }`, so it can only ever see the projects it
    // was handed. Both callers gate first: work-items.ts:677 runs
    // `assertProjectRead(ctx, data.projectId, "ITEM_READ")` before calling it,
    // and tool-executor.ts:749 passes `readable` (or a projectId already
    // matched against `readable`). If a third caller appears, re-verify.
    "teams.ts::teamFilter",
  ]);

  it("no FUNCTION reaches project-scoped data without its own scope check", () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const [name, body] of functionsIn(f)) {
        // Private helpers are reached only through an exported tool that has
        // already gated — `nextRiskCode`, `recomputeObjectiveProgress`.
        if (!/^export /.test(body)) continue;
        if (!TOUCHES_SCOPED.test(body)) continue;
        // Named exemptions, each with its reason — an allowlist, not a silence.
        if (ORG_LEVEL_WRITES.has(`${f}::${name}`)) continue;
        if (CALLER_SCOPED.has(`${f}::${name}`)) continue;
        if (!HAS_GATE.test(body)) offenders.push(`${f}::${name}`);
      }
    }

    expect(
      offenders,
      "each exported tool touching project-scoped data must gate on the project ITSELF",
    ).toEqual([]);
  });

  /**
   * A gate the caller can STEP AROUND is not a gate.
   *
   * `HAS_GATE` above is a substring test over a function body, so it accepts a gate that
   * sits inside `if (projectId) { … }`. Two tools shipped exactly that shape and passed
   * this file for as long as it has existed:
   *
   *   - `okrs.ts::listObjectives` gated the named path and, on the omission path, queried
   *     `{ orgId }` — every project's OKRs. Its comment justified this with "objectives
   *     with no project", a row class that cannot exist: `Objective.projectId` is `String`,
   *     not `String?`.
   *   - `tool-executor.ts::queryIntervals` (not even in this file's scanned directory) ran
   *     its gate on `input.projectId as string` when the value was `undefined`, which
   *     passed vacuously, and Prisma then dropped the undefined from the where.
   *
   * Neither read exists in the product — objectives and intervals are served only under
   * `/projects/[projectId]/…`, behind `requireProjectRead`.
   *
   * THE PROPERTY: if a body gates on a CALLER-SUPPLIED projectId being truthy, it must also
   * bound the branch where that value is absent — with a SET, not another conditional.
   * Matching `if (row.projectId)` is deliberately avoided: gating on the ROW's own project
   * is the correct pattern for a nullable column (`updateMeeting`, `setFeedbackStatus`), and
   * the row is not something the model chooses.
   */
  const CONDITIONAL_GATE =
    /if\s*\(\s*(?:data\.|input\.|parsed\.data\.)?projectId\s*\)\s*\{(?:[^{}]|\{[^{}]*\})*assertProject(?:Read|Manage)\(/;
  /** Narrowing that applies with NO argument from the caller — what the else-branch needs. */
  const BOUNDS_OMISSION =
    /getReadableProjectIds|visibleProjectRecordsWhere|visibleProjectIdsForActor|getVisibleProjectIds/;

  /**
   * ENUMERATES, i.e. reads a SET of rows rather than one row by id.
   *
   * The rule below applies only to these. For a WRITE, an absent `projectId` means "create
   * one unfiled row" on a nullable column — `createMeeting` and `logTime` both do this
   * legitimately, and there is no omission path to bound because nothing is read across
   * projects. For a `findFirst` by id the id bounds the read and the row's own projectId is
   * what gets gated. `findMany` is where omitting a project turns into "every project".
   */
  const ENUMERATES = new RegExp(
    `prisma\\.(?:${PROJECT_SCOPED_MODELS.join("|")})\\.(?:findMany|aggregate|groupBy|count)\\(`,
  );

  /**
   * Known-unbounded enumerations, each with the reason it is not fixed HERE.
   *
   * An exemption for a real defect is its own hazard, so this list carries the obligation
   * that each entry names what is blocking and what the fix would be. It is a written
   * record of an open decision, not a silence.
   */
  const OMISSION_DECISION_PENDING = new Set([
    // `list_time_entries` omitting projectId carries no project clause, so a supervisor
    // (readableTimeUserIds widens to direct reports and to anyone whose timesheet is routed
    // to them for approval) sees those people's hours on team-scoped projects the supervisor
    // cannot open. Rates stay redacted; nothing else does.
    //
    // NOT fixed here because `GET /orgs/[orgId]/time-entries` has the IDENTICAL shape
    // (route.ts:50 gates only when a projectId is supplied), so narrowing the agent alone
    // would make it stricter than the app — the drift _ctx.ts::assertProjectManage was
    // written to prevent. And the underlying question is a product one: bounding a
    // supervisor's view by THEIR OWN project access would stop them seeing, and approving,
    // hours their report logged on another project. Fix the shared rule or neither.
    "time.ts::listTimeEntries",
  ]);

  it("no FUNCTION gates only the branch where the caller named a project", () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const [name, body] of functionsIn(f)) {
        if (!/^export /.test(body)) continue;
        if (!TOUCHES_SCOPED.test(body)) continue;
        if (!ENUMERATES.test(body)) continue;
        if (ORG_LEVEL_WRITES.has(`${f}::${name}`)) continue;
        if (CALLER_SCOPED.has(`${f}::${name}`)) continue;
        if (OMISSION_DECISION_PENDING.has(`${f}::${name}`)) continue;
        if (CONDITIONAL_GATE.test(body) && !BOUNDS_OMISSION.test(body)) {
          offenders.push(`${f}::${name}`);
        }
      }
    }
    expect(
      offenders,
      "a project gate inside `if (projectId)` leaves the omission path unbounded — bound it with a readable/visible project SET",
    ).toEqual([]);
  });

  /**
   * POSITIVE CONTROL for the rule above.
   *
   * The rule is an absence assertion over a regex, and an absence assertion whose predicate
   * silently matches nothing is the most reassuring kind of dead test. So: the pre-fix shape
   * must be detected, and the fixed shape must not.
   */
  it("CONTROL: the conditional-gate rule detects the shape it exists to catch", () => {
    const broken = `export async function listThings(input, ctx) {
      if (projectId) {
        const outOfScope = await assertProjectRead(ctx, projectId, "OKR_READ");
        if (outOfScope) return outOfScope;
      }
      const rows = await prisma.objective.findMany({ where: { orgId: ctx.orgId } });
    }`;
    expect(CONDITIONAL_GATE.test(broken)).toBe(true);
    expect(BOUNDS_OMISSION.test(broken)).toBe(false);

    const fixed = broken.replace(
      "}\n      const rows",
      "} else { readable = await getReadableProjectIds(auth); }\n      const rows",
    );
    expect(BOUNDS_OMISSION.test(fixed) || !CONDITIONAL_GATE.test(fixed)).toBe(true);

    // And gating on the ROW's own nullable project must NOT trip it.
    const rowGated = `export async function updateThing(input, ctx) {
      const row = await prisma.syncMeeting.findFirst({ where: { id, orgId } });
      if (row.projectId) {
        const outOfScope = await assertProjectRead(ctx, row.projectId, "MEETING_UPDATE");
        if (outOfScope) return outOfScope;
      }
    }`;
    expect(CONDITIONAL_GATE.test(rowGated)).toBe(false);
  });

  /**
   * An org-wide pre-check in front of `assertProjectManage` defeats it.
   *
   * `assertProjectManage` forwards to `requireProjectManage`, which admits
   * EITHER the org-wide bit OR a MANAGER of that project — the second branch
   * exists because ~44 mutating routes once gated on the org bit alone, so
   * someone made MANAGER of a project still could not add a milestone to it.
   * The routes were fixed. Fifteen agent tools kept a raw
   * `assertPermission(ctx, <bit>)` ahead of the forward, which runs first and
   * rejects the manager before the manager branch is ever reached — so they ran
   * their project in the app and got "Insufficient permissions" from the
   * assistant. Stricter than the UI is still a parity defect, and it is the one
   * users actually report.
   *
   * This is the reverse direction from every other rule in this file, and it
   * needs its own because a too-strict gate is invisible to the others: they
   * only ask whether a gate EXISTS.
   */
  it("no tool puts an org-wide pre-check in front of assertProjectManage", () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const [name, body] of functionsIn(f)) {
        if (!/assertProjectManage\(/.test(body)) continue;
        const pre = body.search(/assertPermission\(/);
        if (pre === -1) continue;
        // Only a pre-check matters: BEFORE the forward, so it can short-circuit it.
        if (pre < body.search(/assertProjectManage\(/)) offenders.push(`${f}::${name}`);
      }
    }

    expect(
      offenders,
      "assertProjectManage already checks the org-wide bit — a raw assertPermission in front of it makes the project-MANAGER branch unreachable",
    ).toEqual([]);
  });

  it("vector search scopes every project-bearing table it queries", () => {
    // `semantic_search` reaches the same data by a different route — raw SQL
    // against pgvector — so the rules above, which read TypeScript call sites,
    // are blind to it. It was the last place the agent could still reach a
    // team-scoped project: `list_meetings` gates, and vector search did not,
    // while returning a snippet drawn from the meeting TRANSCRIPT.
    //
    // Asserting on the query text is cruder than a behavioural test, and that
    // is a real limit: it proves the filter is PRESENT, not that it is correct.
    // It earns its place by failing if someone deletes it.
    const rag = code("rag.ts");
    const meetings = rag.slice(rag.indexOf('FROM "sync_meetings"'));

    expect(rag).toContain('FROM "sync_meetings"');
    expect(
      meetings.slice(0, 400),
      "the meetings vector query must filter on project_id",
    ).toMatch(/project_id/);
  });

  it("covers the registers that were actually leaking", () => {
    // Names the files this was written for, so removing one from the rule is a
    // visible change rather than a quiet one.
    for (const f of ["pm-register.ts", "okrs.ts", "milestones.ts", "goals-kpis.ts", "work-items.ts"]) {
      expect(files, `${f} should still be audited by this rule`).toContain(f);
      expect(code(f), `${f} lost its project scope gate`).toMatch(
        /assertProjectRead/,
      );
    }
  });
});
