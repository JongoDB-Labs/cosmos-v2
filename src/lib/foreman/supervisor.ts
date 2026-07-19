/**
 * Pure decision core for Foreman's outcome-grooming "supervisor" (sibling to
 * planner.ts). No I/O — the daemon (scripts/foreman/run.mts) gathers the facts and
 * executes the verdict; this module only decides. Unit-tested in isolation.
 */

/** The one action the supervisor takes on a parked ticket. */
export type GroomingKind = "deliver-close" | "requeue" | "dedup-consolidate" | "escalate" | "leave";

/** The composed decision for one ticket. */
export interface GroomingVerdict {
  kind: GroomingKind;
  confidence: number; // 0..1
  evidence: string; // one concise line, shown in the event + UI
  dupOf?: string | null; // canonical ticket key when kind === "dedup-consolidate"
}

/** The model's raw grooming judgment for one ticket (parsed, pre-composition). */
export interface GroomingJudgment {
  delivered: boolean;
  deliveredConfidence: number;
  dupOf: string | null;
  dupConfidence: number;
  evidence: string;
}

const clamp01 = (n: unknown): number => {
  const x = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
};

/** Parse the grooming model reply (tolerating stray prose / code fences) into a
 *  typed judgment. Safe defaults: not-delivered, no-dup, zero confidence. */
export function parseGroomingReply(raw: string): GroomingJudgment {
  const text = (raw ?? "").trim();
  let o: Record<string, unknown> = {};
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      if (parsed && typeof parsed === "object") o = parsed as Record<string, unknown>;
    } catch {
      o = {};
    }
  }
  const dupRaw = typeof o.dupOf === "string" ? o.dupOf.trim() : "";
  let evidence = typeof o.evidence === "string" ? o.evidence.trim().replace(/\s+/g, " ") : "";
  if (evidence.length > 240) evidence = `${evidence.slice(0, 239).trimEnd()}…`;
  return {
    delivered: o.delivered === true,
    deliveredConfidence: clamp01(o.deliveredConfidence),
    dupOf: dupRaw.length > 0 ? dupRaw : null,
    dupConfidence: clamp01(o.dupConfidence),
    evidence,
  };
}

/** Substrings that, when found in a parked build's check log / error, mean the
 *  park was caused by a since-FIXED transient (infra), not by the change itself —
 *  so a fresh rebuild against current main should now pass. Keep this list in sync
 *  as infra bugs are fixed and retired. */
export const KNOWN_TRANSIENT_SIGNATURES: readonly string[] = [
  "must_change_password does not exist", // #367 stale e2e template DB
  "already exists", // #342 C124 "a pull request for branch … already exists"
  "No conversation found with session ID", // #368 shared-HOME resume bug
  "reviewer agent failed twice", // reviewer infra flake
  "did not complete in 1 second", // repair/resume infra failure
];

export interface RequeueFacts {
  parkReason: string;
  checkLog: string;
  parkedAtMs: number;
  /** ms timestamp of the most recent infra fix relevant to builds, or null. */
  lastInfraFixAtMs: number | null;
  currentMainSha: string;
  /** The main SHA at which THIS ticket was last re-queued, or null if never. */
  lastRequeuedSha: string | null;
  /** True when the park was a scope/sensitive risk-gate, not a failure. */
  isScopeOrSensitiveGate: boolean;
}

/** A parked ticket is re-queue-eligible when it parked on a FAILURE (not a
 *  scope/sensitive gate), we have not already re-queued it at the current main SHA
 *  (loop guard), and EITHER its log matches a known-transient signature OR the park
 *  predates a since-shipped infra fix (so main has advanced past the cause). */
export function isRequeueEligible(f: RequeueFacts): boolean {
  if (f.isScopeOrSensitiveGate) return false;
  if (f.lastRequeuedSha !== null && f.lastRequeuedSha === f.currentMainSha) return false;
  const hay = `${f.parkReason}\n${f.checkLog}`;
  if (KNOWN_TRANSIENT_SIGNATURES.some((sig) => hay.includes(sig))) return true;
  if (f.lastInfraFixAtMs !== null && f.lastInfraFixAtMs > f.parkedAtMs) return true;
  return false;
}

/** A ticket must NOT be re-groomed while a human has acted on it since Foreman's
 *  last grooming action — mirrors planner.isStandingDemotion. Only meaningful once
 *  the ticket has been groomed at least once (lastGroomedAtMs set); a never-groomed
 *  ticket is always eligible. Any edit/comment/human-move after the last groom
 *  hands control back to the human. */
export function isHumanSuppressed(f: {
  lastGroomedAtMs: number | null;
  updatedAtMs: number;
  lastCommentAtMs: number | null;
  lastHumanMoveAtMs: number | null;
}): boolean {
  if (f.lastGroomedAtMs === null) return false;
  const g = f.lastGroomedAtMs;
  if (f.updatedAtMs > g) return true;
  if (f.lastCommentAtMs !== null && f.lastCommentAtMs > g) return true;
  if (f.lastHumanMoveAtMs !== null && f.lastHumanMoveAtMs > g) return true;
  return false;
}

export interface SupervisorConfig {
  deliverClose: boolean;
  requeue: boolean;
  dedup: boolean;
  escalate: boolean;
  /** Confidence at/above which deliver-close and dedup act autonomously. */
  confidenceThreshold: number;
  /** Max autonomous mutations executed per pass. */
  perPassCap: number;
}

export const DEFAULT_CONFIG: SupervisorConfig = {
  deliverClose: true,
  requeue: true,
  dedup: true,
  escalate: true,
  confidenceThreshold: 0.8,
  perPassCap: 5,
};

export interface SupervisorFacts {
  hasPr: boolean;
  judgment: GroomingJudgment;
  requeue: RequeueFacts;
  touchesSensitiveForemanPath: boolean;
  agentAskedForInput: boolean;
}

/** Compose the single grooming verdict for one parked ticket. Precedence:
 *  agent-asked-for-input => escalate; then deliver-close (confident, has a PR, not a
 *  sensitive foreman-path change); then dedup; then requeue; else leave. A confident
 *  deliver-close/dedup on a DISABLED behavior, below threshold, or on a sensitive
 *  foreman path downgrades to escalate (never a silent wrong close). */
export function decideVerdict(f: SupervisorFacts, cfg: SupervisorConfig): GroomingVerdict {
  const j = f.judgment;
  const esc = (evidence: string): GroomingVerdict => ({ kind: "escalate", confidence: 1, evidence });

  if (f.agentAskedForInput) return cfg.escalate ? esc(j.evidence || "build agent asked for input") : { kind: "leave", confidence: 1, evidence: "" };

  // deliver-close
  if (f.hasPr && j.delivered) {
    const confident = j.deliveredConfidence >= cfg.confidenceThreshold;
    if (confident && cfg.deliverClose && !f.touchesSensitiveForemanPath) {
      return { kind: "deliver-close", confidence: j.deliveredConfidence, evidence: j.evidence };
    }
    if (cfg.escalate) return esc(j.evidence || "possibly already delivered — confirm");
  }

  // dedup
  if (j.dupOf && j.dupConfidence >= cfg.confidenceThreshold) {
    if (cfg.dedup && f.hasPr) return { kind: "dedup-consolidate", confidence: j.dupConfidence, evidence: j.evidence, dupOf: j.dupOf };
    if (cfg.escalate) return esc(j.evidence || `possible duplicate of ${j.dupOf}`);
  }

  // requeue
  if (isRequeueEligible(f.requeue)) {
    if (cfg.requeue) return { kind: "requeue", confidence: 1, evidence: `re-queue: ${f.requeue.parkReason}`.slice(0, 240) };
    if (cfg.escalate) return esc(`would re-queue: ${f.requeue.parkReason}`);
  }

  return { kind: "leave", confidence: 1, evidence: "" };
}
