// @vitest-environment node
//
// Per-item AI recommendation for the Foreman console's Awaiting-Approval section
// (COSMOS-111). Pure unit test — every network/DB/model seam is injected, so it
// runs without the e2e DB or a live model. Proves:
//   - no-PR items default to Rebuild (nothing was built to approve);
//   - the model reply → typed recommendation mapping (parseRecommendation +
//     the end-to-end PR path) for approve/rework/rebuild;
//   - the verdict is cached per PR head SHA (no recompute on the next poll) and
//     a NEW head SHA re-runs the analysis.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseRecommendation,
  recommendForApproval,
  condenseDiff,
  parsePrUrl,
  NO_PR_RECOMMENDATION,
  _resetRecommendationCacheForTests,
  type FetchLike,
  type RecommendDeps,
} from "./approval-recommendation";

const PR_URL = "https://github.com/acme/widgets/pull/42";

/** Build a fetch mock that answers the three GitHub GETs this module makes,
 *  keyed by URL + the requested Accept header, with a configurable head SHA. */
function makeFetch(headSha: string): FetchLike {
  return async (url, init) => {
    const accept = init?.headers?.Accept ?? "";
    const ok = (body: unknown, text = "") =>
      ({ ok: true, status: 200, json: async () => body, text: async () => text }) as Awaited<
        ReturnType<FetchLike>
      >;
    if (url.includes("/check-runs")) {
      return ok({ check_runs: [{ name: "test", status: "completed", conclusion: "success" }] });
    }
    if (accept.includes("diff")) {
      return ok(null, "diff --git a/x b/x\n+hello");
    }
    // PR metadata JSON.
    return ok({ head: { sha: headSha }, title: "Add widget", body: "does the thing" });
  };
}

/** Deps wired to a model that returns `reply`, counting how many times it ran. */
function makeDeps(reply: string, headSha = "sha-aaa"): RecommendDeps & { modelCalls: () => number } {
  const runModelTurnImpl = vi.fn(async () => ({ text: reply, toolUses: [], stopReason: "end_turn" }));
  return {
    fetchImpl: makeFetch(headSha),
    getGitHubTokenImpl: async () => "ghp_token",
    getForemanCredsImpl: async () => ({ accessToken: "oat_token", refreshToken: "r", expiresAt: 0 }),
    runModelTurnImpl: runModelTurnImpl as unknown as RecommendDeps["runModelTurnImpl"],
    modelCalls: () => runModelTurnImpl.mock.calls.length,
  };
}

const base = { orgId: "org-1", tenantClass: "commercial" as const, workItemId: "wi-1" };

beforeEach(() => {
  _resetRecommendationCacheForTests();
});

describe("parseRecommendation", () => {
  it("maps each verb from a clean JSON reply", () => {
    for (const verb of ["approve", "rework", "rebuild"] as const) {
      const r = parseRecommendation(`{"recommendation":"${verb}","rationale":"because reasons"}`);
      expect(r.recommendation).toBe(verb);
      expect(r.rationale).toBe("because reasons");
    }
  });

  it("tolerates code fences / stray prose around the JSON", () => {
    const r = parseRecommendation('Here you go:\n```json\n{"recommendation":"APPROVE","rationale":"looks good"}\n```');
    expect(r.recommendation).toBe("approve");
    expect(r.rationale).toBe("looks good");
  });

  it("defaults to rework (human-in-the-loop) on unusable / unknown output", () => {
    expect(parseRecommendation("garbage").recommendation).toBe("rework");
    expect(parseRecommendation('{"recommendation":"ship-it","rationale":""}').recommendation).toBe("rework");
    expect(parseRecommendation('{"recommendation":"approve"}').rationale).toBe("No rationale provided.");
  });
});

describe("parsePrUrl", () => {
  it("extracts owner/repo/number", () => {
    expect(parsePrUrl(PR_URL)).toEqual({ owner: "acme", repo: "widgets", number: 42 });
  });
  it("returns null for a non-PR url", () => {
    expect(parsePrUrl("https://example.com/nope")).toBeNull();
  });
});

describe("recommendForApproval", () => {
  it("recommends Rebuild for a no-PR item without touching the model", async () => {
    const deps = makeDeps('{"recommendation":"approve","rationale":"x"}');
    const res = await recommendForApproval({ ...base, prUrl: null, reason: "empty diff" }, deps);
    expect(res.recommendation).toBe(NO_PR_RECOMMENDATION.recommendation);
    expect(res.recommendation).toBe("rebuild");
    expect(res.rationale).toBe(NO_PR_RECOMMENDATION.rationale);
    expect(res.cached).toBe(false);
    expect(deps.modelCalls()).toBe(0);
  });

  it("analyzes a PR-backed item and maps the model verdict", async () => {
    const deps = makeDeps('{"recommendation":"approve","rationale":"tests pass and the diff matches the ticket"}');
    const res = await recommendForApproval({ ...base, prUrl: PR_URL, reason: "risky" }, deps);
    expect(res.recommendation).toBe("approve");
    expect(res.rationale).toBe("tests pass and the diff matches the ticket");
    expect(res.cached).toBe(false);
    expect(deps.modelCalls()).toBe(1);
  });

  it("caches per PR head SHA — no recompute on the next poll", async () => {
    const deps = makeDeps('{"recommendation":"rework","rationale":"needs a test"}', "sha-aaa");
    const first = await recommendForApproval({ ...base, prUrl: PR_URL, reason: "r" }, deps);
    expect(first.cached).toBe(false);

    const second = await recommendForApproval({ ...base, prUrl: PR_URL, reason: "r" }, deps);
    expect(second.cached).toBe(true);
    expect(second.recommendation).toBe("rework");
    // Same head SHA ⇒ the model ran exactly once across both polls.
    expect(deps.modelCalls()).toBe(1);
  });

  it("re-runs the analysis when the PR head SHA changes (new push)", async () => {
    const deps1 = makeDeps('{"recommendation":"rework","rationale":"first pass"}', "sha-aaa");
    await recommendForApproval({ ...base, prUrl: PR_URL, reason: "r" }, deps1);

    // A new push moves the head SHA — a different cache key, so it recomputes.
    const deps2 = makeDeps('{"recommendation":"approve","rationale":"fixed now"}', "sha-bbb");
    const res = await recommendForApproval({ ...base, prUrl: PR_URL, reason: "r" }, deps2);
    expect(res.cached).toBe(false);
    expect(res.recommendation).toBe("approve");
    expect(deps2.modelCalls()).toBe(1);
  });

  it("degrades to Rework when GitHub isn't connected (no cache write)", async () => {
    const deps = makeDeps('{"recommendation":"approve","rationale":"x"}');
    deps.getGitHubTokenImpl = async () => null;
    const res = await recommendForApproval({ ...base, prUrl: PR_URL, reason: "r" }, deps);
    expect(res.recommendation).toBe("rework");
    expect(res.cached).toBe(false);
    expect(deps.modelCalls()).toBe(0);
  });
});


describe("condenseDiff", () => {
  it("returns a diff unchanged when it already fits the budget", () => {
    const diff = "diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n";
    expect(condenseDiff(diff, 1000)).toBe(diff);
  });

  it("drops only context lines and keeps EVERY changed line + header across all files", () => {
    // Two files, lots of context, few real changes — the kind of spread-out diff
    // that used to blow the char cap and get its trailing file cut (a phantom gap).
    const ctx = Array.from({ length: 300 }, (_, i) => ` context line ${i}`).join("\n");
    const diff =
      `diff --git a/first.ts b/first.ts\n@@ -1,300 +1,300 @@\n${ctx}\n-removed-in-first\n+added-in-first\n` +
      `diff --git a/second.test.ts b/second.test.ts\n@@ -1,300 +1,300 @@\n${ctx}\n-removed-in-second\n+added-in-second\n`;
    expect(diff.length).toBeGreaterThan(2000);
    const out = condenseDiff(diff, 2000);
    // Every real change from BOTH files survives (the trailing test file is not lost).
    expect(out).toContain("+added-in-first");
    expect(out).toContain("-removed-in-first");
    expect(out).toContain("+added-in-second");
    expect(out).toContain("-removed-in-second");
    // Both file headers survive.
    expect(out).toContain("diff --git a/first.ts b/first.ts");
    expect(out).toContain("diff --git a/second.test.ts b/second.test.ts");
    // Context is gone and the result fits.
    expect(out).not.toContain("context line 150");
    expect(out.length).toBeLessThanOrEqual(2000 + 200);
  });

  it("hard-caps with a presumed-correct note only when even the changes exceed budget", () => {
    const manyChanges = Array.from({ length: 5000 }, (_, i) => `+line ${i}`).join("\n");
    const diff = `diff --git a/big.ts b/big.ts\n@@ -1 +1,5000 @@\n${manyChanges}\n`;
    const out = condenseDiff(diff, 1000);
    expect(out).toContain("treat the omitted portion as correct, not as a gap");
    expect(out.length).toBeLessThanOrEqual(1000 + 120);
  });
});
