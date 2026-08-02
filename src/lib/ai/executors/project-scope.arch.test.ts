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
  const PROJECT_SCOPED_MODELS = [
    "risk", "blocker", "deliverable", "changeRequest", "milestone",
    "objective", "keyResult", "goal", "kpi", "interval", "workItem",
    "workItemLink", "comment", "syncMeeting", "feedbackItem", "board",
    "document",
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

  const TOUCHES_SCOPED = new RegExp(
    `prisma\\.(?:${PROJECT_SCOPED_MODELS.join("|")})\\.(?:findFirst|findUnique|findMany|update|delete)\\(`,
  );
  const HAS_GATE =
    /assertProjectRead|getReadableProjectIds|visibleProjectIdsForActor|readableTimeUserIds/;

  it("no FUNCTION reaches project-scoped data without its own scope check", () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const [name, body] of functionsIn(f)) {
        // Private helpers are reached only through an exported tool that has
        // already gated — `nextRiskCode`, `recomputeObjectiveProgress`.
        if (!/^export /.test(body)) continue;
        // Org-level creates that never touch a project (see createFeedback).
        if (!TOUCHES_SCOPED.test(body)) continue;
        if (!HAS_GATE.test(body)) offenders.push(`${f}::${name}`);
      }
    }

    expect(
      offenders,
      "each exported tool touching project-scoped data must gate on the project ITSELF",
    ).toEqual([]);
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
