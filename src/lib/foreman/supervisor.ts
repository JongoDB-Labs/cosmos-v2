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
