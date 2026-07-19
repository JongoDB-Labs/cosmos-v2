// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseGroomingReply } from "./supervisor";
import { isRequeueEligible, KNOWN_TRANSIENT_SIGNATURES } from "./supervisor";
import { isHumanSuppressed } from "./supervisor";
import { decideVerdict, DEFAULT_CONFIG, type SupervisorFacts } from "./supervisor";
import { selectWithinCap, type GroomingVerdict } from "./supervisor";
const mkV = (kind: GroomingVerdict["kind"]): GroomingVerdict => ({ kind, confidence: 1, evidence: "" });

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

describe("isHumanSuppressed", () => {
  const base = { lastGroomedAtMs: 1000, updatedAtMs: 900, lastCommentAtMs: null, lastHumanMoveAtMs: null };
  it("not suppressed when nothing changed since the last groom", () => {
    expect(isHumanSuppressed(base)).toBe(false);
  });
  it("suppressed when a human edited after the last groom", () => {
    expect(isHumanSuppressed({ ...base, updatedAtMs: 2000 })).toBe(true);
  });
  it("suppressed when a human commented after the last groom", () => {
    expect(isHumanSuppressed({ ...base, lastCommentAtMs: 1500 })).toBe(true);
  });
  it("suppressed when a human moved the card after the last groom", () => {
    expect(isHumanSuppressed({ ...base, lastHumanMoveAtMs: 1500 })).toBe(true);
  });
  it("never suppressed when the ticket has never been groomed", () => {
    expect(isHumanSuppressed({ ...base, lastGroomedAtMs: null, updatedAtMs: 9e9 })).toBe(false);
  });
});

const facts = (over: Partial<SupervisorFacts> = {}): SupervisorFacts => ({
  hasPr: true,
  judgment: { delivered: false, deliveredConfidence: 0, dupOf: null, dupConfidence: 0, evidence: "" },
  requeue: {
    parkReason: "checks failed", checkLog: "must_change_password does not exist",
    parkedAtMs: 1000, lastInfraFixAtMs: 2000, currentMainSha: "abc",
    lastRequeuedSha: null, isScopeOrSensitiveGate: false,
  },
  touchesSensitiveForemanPath: false,
  agentAskedForInput: false,
  ...over,
});

describe("decideVerdict", () => {
  it("deliver-close when delivered above threshold", () => {
    const v = decideVerdict(facts({ judgment: { delivered: true, deliveredConfidence: 0.95, dupOf: null, dupConfidence: 0, evidence: "on main" } }), DEFAULT_CONFIG);
    expect(v.kind).toBe("deliver-close");
    expect(v.evidence).toBe("on main");
  });
  it("escalates instead of deliver-close when delivered but below threshold", () => {
    const v = decideVerdict(facts({ judgment: { delivered: true, deliveredConfidence: 0.5, dupOf: null, dupConfidence: 0, evidence: "maybe" } }), DEFAULT_CONFIG);
    expect(v.kind).toBe("escalate");
  });
  it("dedup-consolidate when a confident duplicate is found (and not delivered)", () => {
    const v = decideVerdict(facts({ judgment: { delivered: false, deliveredConfidence: 0, dupOf: "COSMOS-105", dupConfidence: 0.9, evidence: "same as 105" } }), DEFAULT_CONFIG);
    expect(v.kind).toBe("dedup-consolidate");
    expect(v.dupOf).toBe("COSMOS-105");
  });
  it("requeue when not delivered/dup but re-queue-eligible", () => {
    const v = decideVerdict(facts(), DEFAULT_CONFIG);
    expect(v.kind).toBe("requeue");
  });
  it("escalates when the build agent explicitly asked for input", () => {
    const v = decideVerdict(facts({ agentAskedForInput: true, requeue: { ...facts().requeue, isScopeOrSensitiveGate: true } }), DEFAULT_CONFIG);
    expect(v.kind).toBe("escalate");
  });
  it("leaves a scope-gated ticket with nothing actionable", () => {
    const v = decideVerdict(facts({ requeue: { ...facts().requeue, isScopeOrSensitiveGate: true, checkLog: "" } }), DEFAULT_CONFIG);
    expect(v.kind).toBe("leave");
  });
  it("escalates (not deliver-close) a sensitive foreman-path ticket even when confident", () => {
    const v = decideVerdict(facts({ touchesSensitiveForemanPath: true, judgment: { delivered: true, deliveredConfidence: 0.99, dupOf: null, dupConfidence: 0, evidence: "on main" } }), DEFAULT_CONFIG);
    expect(v.kind).toBe("escalate");
  });
  it("respects a disabled behavior (deliver-close off => escalate)", () => {
    const cfg = { ...DEFAULT_CONFIG, deliverClose: false };
    const v = decideVerdict(facts({ judgment: { delivered: true, deliveredConfidence: 0.99, dupOf: null, dupConfidence: 0, evidence: "on main" } }), cfg);
    expect(v.kind).toBe("escalate");
  });
  it("escalates a confident 'delivered' with no draft PR (surfaced, never silently dropped)", () => {
    const v = decideVerdict(facts({ hasPr: false, judgment: { delivered: true, deliveredConfidence: 0.99, dupOf: null, dupConfidence: 0, evidence: "on main, no draft" }, requeue: { ...facts().requeue, isScopeOrSensitiveGate: true, checkLog: "" } }), DEFAULT_CONFIG);
    expect(v.kind).toBe("escalate");
  });
});

describe("selectWithinCap", () => {
  it("escalate + leave never count against the cap; only mutating verdicts do", () => {
    const items = [
      { verdict: mkV("escalate"), item: 1 }, { verdict: mkV("leave"), item: 2 },
      { verdict: mkV("deliver-close"), item: 3 }, { verdict: mkV("requeue"), item: 4 },
      { verdict: mkV("dedup-consolidate"), item: 5 },
    ];
    const { act, deferred } = selectWithinCap(items, 2);
    // both non-mutating pass through in `act`; only 2 of the 3 mutating ones act
    expect(act.filter((a) => a.verdict.kind === "escalate" || a.verdict.kind === "leave")).toHaveLength(2);
    expect(act.filter((a) => ["deliver-close", "requeue", "dedup-consolidate"].includes(a.verdict.kind))).toHaveLength(2);
    expect(deferred).toHaveLength(1);
  });
});
