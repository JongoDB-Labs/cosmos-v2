/**
 * Surfacing intake decisions (COSMOS-121, Phase 3c).
 *
 * The remediation loop records every intake outcome on a feedback item's
 * `triage` JSON (see `remediate.ts`):
 *   - a delivered item carries the full AI `Triage` (classification/severity/…),
 *   - a guardrail park carries `triage.guardrail` (hold/reject + score + reason),
 *   - a role-gate park carries `triage.roleGate`,
 *   - a rate-limit throttle carries `triage.throttle`.
 *
 * This pure mapper turns that stored shape into ONE normalized, display-ready
 * descriptor — accepted / held / rejected / throttled / gated, each with a
 * human reason and (where the gate produced one) a 0..1 score — so the Feedback
 * board and the Foreman console render the same decision without either
 * re-deriving it from the raw JSON. No DB, no I/O.
 */

import { throttleMessage, type ThrottleReason } from "./rate-limits";

export type IntakeState = "accepted" | "held" | "rejected" | "throttled" | "gated";

export interface IntakeDecision {
  state: IntakeState;
  /** Short badge label. */
  label: string;
  /** One-line human explanation, safe to show (never echoes raw feedback text). */
  reason: string;
  /** 0..1 guardrail severity when the decision came from the scanner, else null. */
  score: number | null;
  /** Guardrail categories that fired, when applicable. */
  categories?: string[];
}

const STATE_LABEL: Record<IntakeState, string> = {
  accepted: "Accepted",
  held: "Held for review",
  rejected: "Rejected",
  throttled: "Queued",
  gated: "Needs human review",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function decision(state: IntakeState, reason: string, score: number | null, categories?: string[]): IntakeDecision {
  return { state, label: STATE_LABEL[state], reason, score, ...(categories ? { categories } : {}) };
}

/**
 * Map a feedback item's stored triage + delivery marker into an IntakeDecision,
 * or `null` when the item hasn't been through intake yet (a fresh OPEN item with
 * no recorded outcome). Deterministic + pure.
 */
export function describeIntakeDecision(item: {
  triage: unknown;
  deliveredAt?: Date | string | null;
}): IntakeDecision | null {
  const triage = isRecord(item.triage) ? item.triage : null;

  // 1) Guardrail park (security gate) — authoritative, carries a score.
  const guardrail = triage && isRecord(triage.guardrail) ? triage.guardrail : null;
  if (guardrail) {
    const rejected = guardrail.decision === "reject";
    const score = typeof guardrail.score === "number" ? guardrail.score : null;
    const categories = Array.isArray(guardrail.categories)
      ? guardrail.categories.filter((c): c is string => typeof c === "string")
      : undefined;
    const reason =
      asString(guardrail.reason) ??
      (rejected ? "Declined by the content-safety check." : "Held for human review by the intake safety check.");
    return decision(rejected ? "rejected" : "held", reason, score, categories);
  }

  // 2) Role-gate park (trust decision about the submitter).
  const roleGate = triage && isRecord(triage.roleGate) ? triage.roleGate : null;
  if (roleGate) {
    const reason = asString(roleGate.reason) ?? "Routed to a teammate for review before any automated work.";
    return decision("gated", reason, null);
  }

  // 3) Rate-limit throttle (queued for a later run; not a safety/terminal call).
  const throttle = triage && isRecord(triage.throttle) ? triage.throttle : null;
  if (throttle) {
    const reason = asString(throttle.reason)
      ? `Queued — ${throttleMessage(throttle.reason as ThrottleReason)}.`
      : "Queued — will be picked up automatically once capacity frees.";
    return decision("throttled", reason, null);
  }

  // 4) Delivered/accepted — the full AI triage lives directly on `triage`.
  const classification = triage ? asString(triage.classification) : null;
  if (classification || item.deliveredAt) {
    const severity = (triage && asString(triage.severity)) || null;
    const reason = classification
      ? `Accepted and triaged as ${classification}${severity ? ` · severity ${severity}` : ""}.`
      : "Accepted and delivered into the backlog.";
    return decision("accepted", reason, null);
  }

  // 5) No recorded intake outcome yet.
  return null;
}
