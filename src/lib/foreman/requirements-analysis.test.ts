// @vitest-environment node
//
// Per-item AI requirements-coverage analysis for the Foreman console's
// Awaiting-Approval section (COSMOS-116). Pure unit test — every network/DB/model
// seam is injected, so it runs without the e2e DB or a live model. Proves:
//   - the per-criterion met/partial/missing mapping (parseRequirementsReport),
//     including an unknown status defaulting to `partial` (never `met`);
//   - the end-to-end PR path maps the model's report through;
//   - the report is cached per PR head SHA (no recompute on the next poll) and a
//     NEW head SHA re-runs the analysis;
//   - a no-PR item returns the fixed "nothing to analyze" report without a model
//     call (the console disables the button for these — see the console test).
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseRequirementsReport,
  analyzeRequirements,
  NO_PR_REPORT,
  _resetAnalysisCacheForTests,
  type FetchLike,
  type AnalyzeDeps,
} from "./requirements-analysis";

const PR_URL = "https://github.com/acme/widgets/pull/42";

/** Build a fetch mock that answers the two GitHub GETs this module makes (PR
 *  metadata JSON for the head SHA, then the unified diff), with a settable SHA. */
function makeFetch(headSha: string): FetchLike {
  return async (url, init) => {
    const accept = init?.headers?.Accept ?? "";
    const ok = (body: unknown, text = "") =>
      ({ ok: true, status: 200, json: async () => body, text: async () => text }) as Awaited<
        ReturnType<FetchLike>
      >;
    if (accept.includes("diff")) {
      return ok(null, "diff --git a/x b/x\n+hello");
    }
    return ok({ head: { sha: headSha }, title: "Add widget", body: "does the thing" });
  };
}

/** Deps wired to a model that returns `reply`, counting how many times it ran. */
function makeDeps(reply: string, headSha = "sha-aaa"): AnalyzeDeps & { modelCalls: () => number } {
  const runModelTurnImpl = vi.fn(async () => ({ text: reply, toolUses: [], stopReason: "end_turn" }));
  return {
    fetchImpl: makeFetch(headSha),
    getGitHubTokenImpl: async () => "ghp_token",
    getForemanCredsImpl: async () => ({ accessToken: "oat_token", refreshToken: "r", expiresAt: 0 }),
    runModelTurnImpl: runModelTurnImpl as unknown as AnalyzeDeps["runModelTurnImpl"],
    modelCalls: () => runModelTurnImpl.mock.calls.length,
  };
}

const ticket = {
  title: "Add role permissions",
  description: "Roles need editable permissions.",
  acceptanceCriteria: ["Creating a role with permissions succeeds", "A regression test covers it"],
};
const base = { orgId: "org-1", tenantClass: "commercial" as const, workItemId: "wi-1", ticket };

const REPORT_JSON = JSON.stringify({
  summary: "Covers the main criterion but the test is thin.",
  criteria: [
    { criterion: "Creating a role with permissions succeeds", status: "met", note: "handled in the diff" },
    { criterion: "A regression test covers it", status: "partial", note: "test asserts too little" },
    { criterion: "Docs updated", status: "missing", note: "no docs touched" },
  ],
  gaps: ["No docs update"],
  risks: ["Permission mask could overflow"],
  complete: false,
});

beforeEach(() => {
  _resetAnalysisCacheForTests();
});

describe("parseRequirementsReport", () => {
  it("maps each criterion status met/partial/missing from a clean JSON reply", () => {
    const r = parseRequirementsReport(REPORT_JSON);
    expect(r.criteria.map((c) => c.status)).toEqual(["met", "partial", "missing"]);
    expect(r.criteria[0]!.criterion).toBe("Creating a role with permissions succeeds");
    expect(r.gaps).toEqual(["No docs update"]);
    expect(r.risks).toEqual(["Permission mask could overflow"]);
    expect(r.complete).toBe(false);
    expect(r.summary).toBe("Covers the main criterion but the test is thin.");
  });

  it("tolerates code fences / stray prose around the JSON", () => {
    const r = parseRequirementsReport(
      'Sure:\n```json\n{"summary":"ok","criteria":[{"criterion":"c","status":"MET","note":"n"}],"complete":true}\n```',
    );
    expect(r.criteria[0]!.status).toBe("met");
    expect(r.complete).toBe(true);
  });

  it("defaults an unknown/absent criterion status to partial — never silently `met`", () => {
    const r = parseRequirementsReport(
      '{"criteria":[{"criterion":"a","status":"ship-it"},{"criterion":"b"}]}',
    );
    expect(r.criteria.map((c) => c.status)).toEqual(["partial", "partial"]);
    // A criterion with no text is dropped entirely.
    const empty = parseRequirementsReport('{"criteria":[{"status":"met"}]}');
    expect(empty.criteria).toEqual([]);
  });

  it("falls back to safe defaults on unusable output", () => {
    const r = parseRequirementsReport("garbage");
    expect(r.criteria).toEqual([]);
    expect(r.gaps).toEqual([]);
    expect(r.risks).toEqual([]);
    expect(r.complete).toBe(false);
    expect(r.summary.length).toBeGreaterThan(0);
  });
});

describe("analyzeRequirements", () => {
  it("returns the fixed no-PR report without touching the model", async () => {
    const deps = makeDeps(REPORT_JSON);
    const res = await analyzeRequirements({ ...base, prUrl: null }, deps);
    expect(res.summary).toBe(NO_PR_REPORT.summary);
    expect(res.criteria).toEqual([]);
    expect(res.complete).toBe(false);
    expect(res.cached).toBe(false);
    expect(deps.modelCalls()).toBe(0);
  });

  it("analyzes a PR-backed item and maps the model's per-criterion report", async () => {
    const deps = makeDeps(REPORT_JSON);
    const res = await analyzeRequirements({ ...base, prUrl: PR_URL }, deps);
    expect(res.criteria.map((c) => c.status)).toEqual(["met", "partial", "missing"]);
    expect(res.cached).toBe(false);
    expect(deps.modelCalls()).toBe(1);
  });

  it("caches per PR head SHA — no recompute on the next poll", async () => {
    const deps = makeDeps(REPORT_JSON, "sha-aaa");
    const first = await analyzeRequirements({ ...base, prUrl: PR_URL }, deps);
    expect(first.cached).toBe(false);

    const second = await analyzeRequirements({ ...base, prUrl: PR_URL }, deps);
    expect(second.cached).toBe(true);
    expect(second.criteria.map((c) => c.status)).toEqual(["met", "partial", "missing"]);
    // Same head SHA ⇒ the model ran exactly once across both polls.
    expect(deps.modelCalls()).toBe(1);
  });

  it("re-runs the analysis when the PR head SHA changes (new push)", async () => {
    const deps1 = makeDeps(REPORT_JSON, "sha-aaa");
    await analyzeRequirements({ ...base, prUrl: PR_URL }, deps1);

    const deps2 = makeDeps(
      '{"summary":"now complete","criteria":[{"criterion":"c","status":"met","note":"n"}],"complete":true}',
      "sha-bbb",
    );
    const res = await analyzeRequirements({ ...base, prUrl: PR_URL }, deps2);
    expect(res.cached).toBe(false);
    expect(res.complete).toBe(true);
    expect(deps2.modelCalls()).toBe(1);
  });

  it("degrades gracefully (no cache write) when GitHub isn't connected", async () => {
    const deps = makeDeps(REPORT_JSON);
    deps.getGitHubTokenImpl = async () => null;
    const res = await analyzeRequirements({ ...base, prUrl: PR_URL }, deps);
    expect(res.criteria).toEqual([]);
    expect(res.summary).toMatch(/couldn't analyze/i);
    expect(res.cached).toBe(false);
    expect(deps.modelCalls()).toBe(0);
  });
});
