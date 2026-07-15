/**
 * Intake rate-limits + abuse throttling (COSMOS-119, Phase 3a).
 *
 * The autonomous build path is a shared, finite resource: a single coding
 * session + full test-suite run per delivered item, across a small worker fleet.
 * Left ungated, one noisy user (or a near-duplicate flood) could turn every OPEN
 * feedback item into a work item in a single run and starve everyone else's
 * requests of build capacity. This module is the deterministic, PURE planner
 * that decides — before any (expensive) triage / security-judge model call —
 * which of a run's candidate items may be admitted into the build backlog and
 * which are throttled (left OPEN, re-evaluated on a later run once capacity
 * frees). No DB, no imports, so it's exhaustively unit-testable and holds even
 * when the model is down.
 *
 * Four independent caps, mirroring the ticket:
 *   - per-user   — one submitter can't admit more than N items in a single run
 *   - per-org    — an org can't admit more than N items in a single run
 *   - queue-depth — total in-flight build queue (existing + this run) is capped,
 *                   so the fleet is never asked to chew through more than it can
 *   - build-budget — a cost budget (features cost more to build than bugs), so a
 *                    run of large items exhausts capacity before a run of small ones
 *
 * Plus a near-duplicate FLOOD throttle: only the first item of each normalized
 * signature is admitted per run; resubmissions / copy-paste brigades of the same
 * text are throttled, so re-filing the same request can't exhaust the fleet.
 */

/** Throttle reasons, in the order they're evaluated. Surfaced to the submitter
 *  as a clear "queued" message and audit-logged. */
export type ThrottleReason =
  | "duplicate-flood"
  | "per-org-cap"
  | "per-user-cap"
  | "queue-depth"
  | "build-budget";

export interface IntakeLimits {
  /** Max items one submitter may admit into the backlog per run. */
  perUserPerRun: number;
  /** Max items the org may admit into the backlog per run. */
  perOrgPerRun: number;
  /** Max TOTAL in-flight build queue (already-delivered-and-not-done + this
   *  run's admits). availableSlots = max(0, maxQueueDepth - currentDepth). */
  maxQueueDepth: number;
  /** Per-run build-cost budget (see `estimateBuildCost`). */
  buildBudget: number;
}

/** Permissive defaults — the caps are always present but only bite once an org
 *  configures tighter limits (mirrors auto-remediation being opt-in). A fresh
 *  org's ordinary intake is never throttled; abuse-scale volume is. Kept at or
 *  below the per-run scan ceiling so defaults never throttle a normal run. */
export const DEFAULT_INTAKE_LIMITS: IntakeLimits = {
  perUserPerRun: 10,
  perOrgPerRun: 50,
  maxQueueDepth: 100,
  buildBudget: 100,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Clamp an untrusted settings value to a non-negative integer, else the default. */
function clampCap(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.round(value));
}

/**
 * Normalize an org's `settings.intakeLimits` (untrusted, unknown shape) into a
 * validated IntakeLimits. Absent / malformed fields fall back to the permissive
 * defaults, so an org that has never touched the setting is unaffected. Pure.
 */
export function readIntakeLimits(settings: unknown): IntakeLimits {
  const root = isRecord(settings) ? settings : {};
  const raw = isRecord(root.intakeLimits) ? root.intakeLimits : {};
  return {
    perUserPerRun: clampCap(raw.perUserPerRun, DEFAULT_INTAKE_LIMITS.perUserPerRun),
    perOrgPerRun: clampCap(raw.perOrgPerRun, DEFAULT_INTAKE_LIMITS.perOrgPerRun),
    maxQueueDepth: clampCap(raw.maxQueueDepth, DEFAULT_INTAKE_LIMITS.maxQueueDepth),
    buildBudget: clampCap(raw.buildBudget, DEFAULT_INTAKE_LIMITS.buildBudget),
  };
}

/** Rough build-cost estimate available BEFORE triage (which is itself part of
 *  the cost we're rationing). A FEATURE is a larger build than a BUG fix, so it
 *  spends more of the run's budget. Kept coarse on purpose — the exact number
 *  matters less than "big items exhaust capacity faster than small ones". */
export function estimateBuildCost(item: { type: "BUG" | "FEATURE" }): number {
  return item.type === "FEATURE" ? 2 : 1;
}

/** Normalized signature for near-duplicate detection: lowercase, alphanumerics
 *  only, collapsed whitespace, over title + description. Two items with the same
 *  signature are treated as the same request (a resubmission / copy-paste). */
export function duplicateSignature(item: { title: string; description: string }): string {
  return `${item.title}\n${item.description}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export interface IntakeCandidate {
  id: string;
  authorId: string;
  type: "BUG" | "FEATURE";
  title: string;
  description: string;
}

export interface IntakePlan {
  /** Feedback ids cleared to proceed through triage → delivery, in input order. */
  admit: string[];
  /** Feedback ids held back this run, each with the first cap it tripped. */
  throttled: { id: string; reason: ThrottleReason }[];
}

/**
 * Decide which candidates a single run may admit. Candidates should be passed in
 * the run's priority order (the remediation loop sorts by votes desc, age asc),
 * so under contention the highest-signal items win the scarce capacity.
 *
 * Pure and deterministic: same inputs → same plan. Checks run in a fixed order
 * so the reported reason is stable (duplicate-flood → per-org → per-user →
 * queue-depth → build-budget).
 */
export function planIntake(
  candidates: IntakeCandidate[],
  state: { queueDepth: number },
  limits: IntakeLimits,
): IntakePlan {
  const availableSlots = Math.max(0, limits.maxQueueDepth - Math.max(0, state.queueDepth));

  const admit: string[] = [];
  const throttled: { id: string; reason: ThrottleReason }[] = [];

  const seenSignatures = new Set<string>();
  const perUser = new Map<string, number>();
  let orgAdmitted = 0;
  let budgetSpent = 0;

  for (const item of candidates) {
    // 1) Near-duplicate flood: only the first item of each signature is a
    //    candidate this run; every resubmission after it is throttled. Registered
    //    on first sight regardless of that item's own outcome, so a flood whose
    //    lead item is itself capped still can't slip its copies through.
    const signature = duplicateSignature(item);
    if (seenSignatures.has(signature)) {
      throttled.push({ id: item.id, reason: "duplicate-flood" });
      continue;
    }
    seenSignatures.add(signature);

    // 2) Per-org run cap.
    if (orgAdmitted >= limits.perOrgPerRun) {
      throttled.push({ id: item.id, reason: "per-org-cap" });
      continue;
    }

    // 3) Per-user run cap.
    const userCount = perUser.get(item.authorId) ?? 0;
    if (userCount >= limits.perUserPerRun) {
      throttled.push({ id: item.id, reason: "per-user-cap" });
      continue;
    }

    // 4) Queue-depth: don't push the in-flight build queue past its ceiling.
    if (admit.length >= availableSlots) {
      throttled.push({ id: item.id, reason: "queue-depth" });
      continue;
    }

    // 5) Build-cost budget for the run.
    const cost = estimateBuildCost(item);
    if (budgetSpent + cost > limits.buildBudget) {
      throttled.push({ id: item.id, reason: "build-budget" });
      continue;
    }

    admit.push(item.id);
    orgAdmitted += 1;
    perUser.set(item.authorId, userCount + 1);
    budgetSpent += cost;
  }

  return { admit, throttled };
}

/** A short, submitter-facing explanation of why their request is queued rather
 *  than picked up yet — no internal cap numbers, just the reassurance that it's
 *  queued and will be handled automatically. */
export function throttleMessage(reason: ThrottleReason): string {
  if (reason === "duplicate-flood") {
    return "looks like a duplicate of a request we're already handling, so it's linked to that queue";
  }
  return "we're handling a high volume of requests right now, so it's queued and will be picked up automatically";
}
