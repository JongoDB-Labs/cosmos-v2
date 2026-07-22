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
  /** Length (chars) of the ticket description — the always-available plan-time
   *  breadth proxy: a genuinely epic feature spells out a long, multi-deliverable
   *  brief, whereas a normal feature that merely enumerates a few criteria is short. */
  descriptionLength?: number;
}

/** The tag an epic carries once it has been decomposed. Its presence short-circuits
 *  any re-decomposition (COSMOS-128 AC3): if a human drags a decomposed epic back to
 *  the backlog it must NOT be split a second time into duplicate children. */
export const DECOMPOSED_TAG = "decomposed";

/** Re-decomposition guard (COSMOS-128 AC3): true once an epic has already been split,
 *  so the plan pass skips it even if a human moved it back into the build pool. */
export function alreadyDecomposed(tags: readonly string[]): boolean {
  return tags.includes(DECOMPOSED_TAG);
}

/** An epic-sized ticket needs enough acceptance criteria to split into ≥2 ordered
 *  phases; below this there's nothing to decompose (never a false split). */
export const EPIC_MIN_PHASES = 2;
/** Acceptance-criteria count required (necessary, but NOT sufficient on its own —
 *  see judgeScope) to consider a ticket epic-sized. */
export const EPIC_MIN_ACCEPTANCE_CRITERIA = 4;
/** Breadth (distinct touched areas) that qualifies as a real size signal. */
export const EPIC_MIN_TOUCHED_AREAS = 3;
/** Expected-diff size (lines) above which a ticket is epic-sized — the same
 *  >400-line boundary the build-time auto-park backstop uses. */
export const EPIC_DIFF_LINE_THRESHOLD = 400;
/** Description length (chars) that qualifies as a real breadth/size signal — a
 *  genuinely epic feature carries a long, multi-deliverable brief. */
export const EPIC_MIN_DESCRIPTION_CHARS = 600;

export interface ScopeVerdict {
  isEpic: boolean;
  /** How many ordered phases it would decompose into (0 when not an epic). */
  phaseCount: number;
  /** Human-readable rationale, surfaced in the plan-time log / epic comment. */
  reasons: string[];
}

/** Estimate whether a ticket is epic-sized and worth decomposing. Conservative by
 *  construction (AC1/AC2 — no false splits): it must have ≥ EPIC_MIN_PHASES
 *  acceptance criteria (so there are ordered phases to form) AND satisfy BOTH
 *  a criteria-COUNT signal (≥ EPIC_MIN_ACCEPTANCE_CRITERIA) AND at least one real
 *  breadth/size signal (touched-area breadth, expected diff, description length, or
 *  the auto-park backstop). Acceptance-criteria count ALONE is never enough — a
 *  normal small feature that merely enumerates 4+ criteria stays a single ticket.
 *  A narrow ticket — few criteria, or many criteria but no breadth — is not an epic. */
export function judgeScope(s: ScopeSignals): ScopeVerdict {
  const acCount = s.acceptanceCriteria.length;
  // Hard precondition: nothing to decompose without ≥2 phases' worth of criteria.
  if (acCount < EPIC_MIN_PHASES) {
    return { isEpic: false, phaseCount: 0, reasons: ["fewer than 2 acceptance criteria — not decomposable"] };
  }
  // A criteria-COUNT signal is NECESSARY but not sufficient: it must be corroborated
  // by a real breadth/size signal, or a normal feature that just lists 4+ criteria
  // would be falsely split (AC1).
  const hasCriteriaSignal = acCount >= EPIC_MIN_ACCEPTANCE_CRITERIA;
  const breadthReasons: string[] = [];
  if ((s.touchedAreas ?? 0) >= EPIC_MIN_TOUCHED_AREAS) breadthReasons.push(`${s.touchedAreas} touched areas`);
  if ((s.expectedDiffLines ?? 0) > EPIC_DIFF_LINE_THRESHOLD) breadthReasons.push(`~${s.expectedDiffLines}-line expected diff`);
  if ((s.descriptionLength ?? 0) >= EPIC_MIN_DESCRIPTION_CHARS) breadthReasons.push(`${s.descriptionLength}-char description`);
  if (s.oversizedBackstop) breadthReasons.push("oversize auto-park backstop tripped");
  const hasBreadthSignal = breadthReasons.length > 0;
  const isEpic = hasCriteriaSignal && hasBreadthSignal;
  if (!isEpic) {
    const why = !hasCriteriaSignal
      ? `only ${acCount} acceptance criteria (need ≥${EPIC_MIN_ACCEPTANCE_CRITERIA})`
      : "acceptance criteria alone — no breadth/size signal, not epic-sized";
    return { isEpic: false, phaseCount: 0, reasons: [why] };
  }
  return { isEpic: true, phaseCount: acCount, reasons: [`${acCount} acceptance criteria`, ...breadthReasons] };
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

/** The base branch a phase child is BUILT on under stacked coordinated builds (#1):
 *  phase 1 branches off `origin/main`; phase N branches off phase N-1's branch, so
 *  each later phase already contains every earlier phase's changes and same-file
 *  cross-phase conflicts vanish by construction. When the predecessor branch isn't
 *  known yet (not built), the caller falls back to `origin/main` and the sequential
 *  build gate holds phase N until N-1 exists. `phaseBranches` maps a 1-based phase
 *  index to its branch name (e.g. `auto/COSMOS-119`). Pure — the daemon supplies the
 *  live branch map and does the git checkout. */
export function stackedBase(phase: number, phaseBranches: ReadonlyMap<number, string>): string {
  if (phase <= 1) return "origin/main";
  return phaseBranches.get(phase - 1) ?? "origin/main";
}
