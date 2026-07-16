// Epic decomposition core (COSMOS-115) — the companion to COSMOS-118's
// release-gate. At plan time Foreman estimates a ticket's scope; an epic-sized
// FEATURE is split into ORDERED phase children (one per acceptance criterion),
// each depending on the previous phase, so they can batch into ONE coordinated
// release (see release-gate.ts). A pure core with no I/O — like reconcile.ts and
// release-gate.ts — so it unit-tests directly and the daemon (run.mts) just calls
// it, then writes the children via db.decomposeEpic.
//
// The bug this prevents (its two failure modes):
//   - a genuinely epic feature built as one sprawling >400-line diff that always
//     auto-parks and never ships incrementally; and
//   - FALSE SPLITS — a small/incremental ticket must NOT be decomposed (AC2/AC6).
// The judge is deliberately conservative: decomposition needs BOTH a real size
// signal AND enough acceptance criteria to form ≥2 ordered phases.

import type { BumpKind } from "./ship-rebase";

/** Plan-time scope signals for a ticket. `acceptanceCriteria` is always known;
 *  `touchedAreas` / `expectedDiffLines` are best-effort estimates (undefined when
 *  unavailable at plan time); `oversizedBackstop` is the existing >400-line
 *  auto-park signal, threaded in as a backstop when it has already tripped. */
export interface ScopeSignals {
  classification: "BUG" | "FEATURE";
  acceptanceCriteria: string[];
  /** Distinct product/system areas the ticket appears to touch (breadth). */
  touchedAreas?: number;
  /** Rough expected diff size in lines, when estimable at plan time. */
  expectedDiffLines?: number;
  /** The >400-line auto-park backstop has already tripped for this ticket. */
  oversizedBackstop?: boolean;
}

/** An epic-sized ticket needs enough acceptance criteria to split into ≥2 ordered
 *  phases; below this there's nothing to decompose (never a false split). */
export const EPIC_MIN_PHASES = 2;
/** Acceptance-criteria count that on its own marks a ticket epic-sized. */
export const EPIC_MIN_ACCEPTANCE_CRITERIA = 4;
/** Breadth (distinct touched areas) that on its own marks a ticket epic-sized. */
export const EPIC_MIN_TOUCHED_AREAS = 3;
/** Expected-diff size (lines) above which a ticket is epic-sized — the same
 *  >400-line boundary the build-time auto-park backstop uses. */
export const EPIC_DIFF_LINE_THRESHOLD = 400;

export interface ScopeVerdict {
  isEpic: boolean;
  /** How many ordered phases it would decompose into (0 when not an epic). */
  phaseCount: number;
  /** Human-readable rationale, surfaced in the plan-time log / epic comment. */
  reasons: string[];
}

/** Estimate whether a ticket is epic-sized and worth decomposing. Conservative by
 *  construction (AC2/AC6 — no false splits): it must have ≥ EPIC_MIN_PHASES
 *  acceptance criteria (so there are ordered phases to form) AND cross at least one
 *  size threshold (AC count, breadth, expected diff, or the auto-park backstop). A
 *  small/incremental ticket — few criteria, narrow, small diff — is never an epic. */
export function judgeScope(s: ScopeSignals): ScopeVerdict {
  const acCount = s.acceptanceCriteria.length;
  const reasons: string[] = [];
  // Hard precondition: nothing to decompose without ≥2 phases' worth of criteria.
  if (acCount < EPIC_MIN_PHASES) {
    return { isEpic: false, phaseCount: 0, reasons: ["fewer than 2 acceptance criteria — not decomposable"] };
  }
  if (acCount >= EPIC_MIN_ACCEPTANCE_CRITERIA) reasons.push(`${acCount} acceptance criteria`);
  if ((s.touchedAreas ?? 0) >= EPIC_MIN_TOUCHED_AREAS) reasons.push(`${s.touchedAreas} touched areas`);
  if ((s.expectedDiffLines ?? 0) > EPIC_DIFF_LINE_THRESHOLD) reasons.push(`~${s.expectedDiffLines}-line expected diff`);
  if (s.oversizedBackstop) reasons.push("oversize auto-park backstop tripped");
  const isEpic = reasons.length > 0;
  return { isEpic, phaseCount: isEpic ? acCount : 0, reasons };
}

/** One ordered phase child of a decomposed epic. */
export interface PhasePlan {
  /** 1-based position in the ordered decomposition. */
  phase: number;
  /** This phase's acceptance criteria (one criterion per phase). */
  acceptanceCriteria: string[];
  /** The phase this one must ship AFTER — its predecessor, or null for phase 1.
   *  Becomes the release-gate's Sibling.dependsOn edge (dependency-ordered merge). */
  dependsOnPhase: number | null;
}

export interface DecompositionPlan {
  phases: PhasePlan[];
  /** Tag the parent epic with COORDINATED_RELEASE_TAG so its phases batch into one
   *  version — only for a true multi-phase FEATURE epic; never force coordination
   *  on incremental/bug work (COSMOS-118's safe default). */
  coordinate: boolean;
  /** Children ship as this classification → drives the coordinated SemVer bump
   *  (FEATURE→minor, BUG→patch — part C). */
  childClassification: "BUG" | "FEATURE";
  /** The single coordinated release's SemVer bump kind. */
  bumpKind: BumpKind;
}

/** Turn an epic-sized FEATURE ticket into an ordered phase decomposition, or null
 *  when the ticket isn't an epic (ship it as one, unchanged — AC2/AC6). Only
 *  FEATURE epics are auto-decomposed: a bug is shipped as a single fix rather than
 *  split into phases (a bug epic can still be coordinated manually via its tag).
 *  Each acceptance criterion becomes one phase; phase N depends on phase N-1, so
 *  the release gate merges them in dependency order as one coordinated version. */
export function planDecomposition(s: ScopeSignals): DecompositionPlan | null {
  if (s.classification !== "FEATURE") return null;
  const verdict = judgeScope(s);
  if (!verdict.isEpic) return null;
  const phases: PhasePlan[] = s.acceptanceCriteria.map((c, i) => ({
    phase: i + 1,
    acceptanceCriteria: [c],
    dependsOnPhase: i === 0 ? null : i,
  }));
  return {
    phases,
    coordinate: phases.length >= EPIC_MIN_PHASES,
    childClassification: "FEATURE",
    bumpKind: "minor",
  };
}
