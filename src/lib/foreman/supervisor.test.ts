// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseGroomingReply } from "./supervisor";
import { isRequeueEligible, KNOWN_TRANSIENT_SIGNATURES } from "./supervisor";

describe("parseGroomingReply", () => {
  it("extracts a delivered judgment from a JSON reply with stray prose", () => {
    const raw =
      'Here is my analysis:\n{"delivered":true,"deliveredConfidence":0.9,' +
      '"evidence":"main sprint-board.tsx scopes to active sprint","dupOf":null,"dupConfidence":0}';
    const j = parseGroomingReply(raw);
    expect(j.delivered).toBe(true);
    expect(j.deliveredConfidence).toBeCloseTo(0.9);
    expect(j.evidence).toContain("sprint-board");
    expect(j.dupOf).toBeNull();
  });

  it("defaults to a safe non-delivered judgment when JSON is absent/garbage", () => {
    const j = parseGroomingReply("model refused");
    expect(j.delivered).toBe(false);
    expect(j.deliveredConfidence).toBe(0);
    expect(j.dupOf).toBeNull();
    expect(j.evidence).toBe("");
  });

  it("clamps confidence to [0,1] and trims a duplicate key", () => {
    const j = parseGroomingReply('{"delivered":false,"deliveredConfidence":5,"dupOf":"  COSMOS-105  ","dupConfidence":0.8}');
    expect(j.deliveredConfidence).toBe(1);
    expect(j.dupOf).toBe("COSMOS-105");
    expect(j.dupConfidence).toBeCloseTo(0.8);
  });
});

describe("isRequeueEligible", () => {
  const base = {
    parkReason: "checks failed",
    checkLog: "",
    parkedAtMs: 1000,
    lastInfraFixAtMs: 2000, // a fix shipped AFTER the park
    currentMainSha: "abc",
    lastRequeuedSha: null as string | null,
    isScopeOrSensitiveGate: false,
  };

  it("re-queues a failure park whose log matches a known-transient signature", () => {
    expect(isRequeueEligible({ ...base, checkLog: "column users.must_change_password does not exist" })).toBe(true);
  });

  it("re-queues a failure park that predates a since-shipped infra fix", () => {
    expect(isRequeueEligible({ ...base, checkLog: "some unrelated failure" })).toBe(true);
  });

  it("does NOT re-queue a scope/sensitive gate (not a failure)", () => {
    expect(isRequeueEligible({ ...base, isScopeOrSensitiveGate: true, parkReason: "9 files changed (> 8)" })).toBe(false);
  });

  it("does NOT re-queue twice at the same main SHA (loop guard)", () => {
    expect(isRequeueEligible({ ...base, lastRequeuedSha: "abc" })).toBe(false);
  });

  it("does NOT re-queue when no signature matches and the park is newer than the last fix", () => {
    expect(isRequeueEligible({ ...base, checkLog: "genuine test failure", lastInfraFixAtMs: 500 })).toBe(false);
  });

  it("exposes the stale-DB and PR-exists signatures", () => {
    expect(KNOWN_TRANSIENT_SIGNATURES.some((s) => "column users.must_change_password does not exist".includes(s))).toBe(true);
    expect(KNOWN_TRANSIENT_SIGNATURES.some((s) => 'a pull request for branch "x" already exists'.includes(s))).toBe(true);
  });
});
