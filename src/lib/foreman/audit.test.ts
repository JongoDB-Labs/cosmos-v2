import { describe, it, expect } from "vitest";
import { formatAudit, tailLog, type AuditRecord } from "./audit";

describe("formatAudit", () => {
  const shipped: AuditRecord = {
    key: "COSMOS-15",
    outcome: "shipped",
    summary: "scope the sprint board to the selected sprint",
    version: "2.161.1",
    rollbackTo: "2.161.0",
    branch: "auto/COSMOS-15",
    prUrl: "https://github.com/x/y/pull/201",
    commit: "abc1234",
  };

  it("shipped: surfaces version, PR/branch/commit, and the exact rollback command", () => {
    const c = formatAudit(shipped);
    expect(c).toContain("shipped");
    expect(c).toContain("`2.161.1`");
    expect(c).toContain("https://github.com/x/y/pull/201");
    expect(c).toContain("`abc1234`");
    // the rollback target becomes a runnable command
    expect(c).toContain(".deploy/deploy-apponly.sh 2.161.0");
    // a merged change has no open branch to check out
    expect(c).not.toContain("git checkout auto/COSMOS-15");
  });

  it("review (checks failed): includes the reason, the check-log tail, and a rework path — but no rollback", () => {
    const c = formatAudit({
      key: "COSMOS-12",
      outcome: "review",
      summary: "x",
      reason: "checks failed",
      version: "2.161.1",
      branch: "auto/COSMOS-12",
      prUrl: "https://github.com/x/y/pull/200",
      commit: "def5678",
      checkLog: "FAIL src/foo.test.ts\n  Expected 1, received 2",
    });
    expect(c).toContain("checks failed");
    expect(c).toContain("Expected 1, received 2"); // the WHY is captured, not lost
    expect(c).toContain("git checkout auto/COSMOS-12");
    expect(c).not.toContain("deploy-apponly.sh"); // nothing deployed → nothing to roll back
  });

  it("review (risk-gated): no check-log block when checks actually passed", () => {
    const c = formatAudit({ key: "COSMOS-1", outcome: "review", reason: "touches a sensitive path", branch: "auto/COSMOS-1" });
    expect(c).toContain("sensitive path");
    expect(c).not.toContain("check output");
  });

  it("merged-undeployed: does NOT tell you to check out the deleted branch; offers finish-or-revert on the merged commit", () => {
    const c = formatAudit({
      key: "COSMOS-42",
      outcome: "merged-undeployed",
      summary: "y",
      reason: "image build failed",
      version: "2.162.0",
      branch: "auto/COSMOS-42",
      prUrl: "https://github.com/x/y/pull/210",
      commit: "main5678", // the squash commit on main, not the deleted branch tip
    });
    expect(c).toContain("merged to main");
    expect(c).toContain("prod is unchanged");
    expect(c).not.toContain("git checkout auto/COSMOS-42"); // branch was deleted by the squash-merge
    expect(c).toContain(".deploy/deploy-apponly.sh 2.162.0"); // finish the release
    expect(c).toContain("git revert main5678"); // or undo the merge
  });

  it("rolled-back: states prod was restored and offers a revert", () => {
    const c = formatAudit({
      key: "COSMOS-9",
      outcome: "rolled-back",
      version: "2.162.0",
      rollbackTo: "2.161.1",
      commit: "aaa1111",
      reason: "deploy health-gate failed",
    });
    expect(c).toContain("rolled back");
    expect(c).toContain("`2.161.1`");
    expect(c).toContain("git revert aaa1111");
  });

  it("never leaks 'undefined' for absent fields", () => {
    const c = formatAudit({ key: "COSMOS-3", outcome: "agent-failed", reason: "agent did not complete" });
    expect(c).not.toContain("undefined");
    expect(c).toContain("agent did not complete");
  });
});

describe("tailLog", () => {
  it("returns a short log unchanged", () => {
    expect(tailLog("small output")).toBe("small output");
  });

  it("keeps the tail (failures print last) with a leading ellipsis when truncated", () => {
    const long = "A".repeat(60) + "FAIL_AT_END";
    const out = tailLog(long, 20);
    expect(out.startsWith("…")).toBe(true);
    expect(out).toContain("FAIL_AT_END");
    expect(out.length).toBeLessThan(long.length);
  });
});
