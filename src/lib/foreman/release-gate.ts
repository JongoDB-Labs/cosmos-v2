// Release coordination for epic phase children (COSMOS-118) — the companion to
// COSMOS-115's epic decomposition. COSMOS-115 splits an epic into sibling "phase"
// children; this module decides WHEN those children may ship. A pure core with no
// I/O — like reconcile.ts and ship-rebase.ts, so it unit-tests directly and the
// daemon (run.mts) just calls it.
//
// The bug this prevents: an epic shipping as N separate version patches (one per
// child) instead of ONE coordinated version. When an epic is marked "coordinated",
// each green+approved child is HELD until every sibling phase is green+approved,
// then they merge in dependency order and ship as one tag/deploy/changelog entry.
// Non-epic tickets and "incremental" epics ship per-ticket exactly as today — the
// safe default. Coordination is opt-in and never forced.

/** How an epic releases its phase children. `incremental` = ship each child as it
 *  becomes green+approved (today's behaviour); `coordinated` = batch them into one
 *  version once every sibling is ready. */
export type CoordinationMode = "incremental" | "coordinated";

/** Safe default (AC4): absent an explicit opt-in, an epic ships per-ticket. Many
 *  features are legitimately incrementally shippable — never force coordination. */
export const DEFAULT_COORDINATION_MODE: CoordinationMode = "incremental";

/** The tag an epic carries to opt into coordinated release. Configurable per epic
 *  and migration-free — WorkItem.tags already exists. Any other tag set (or none)
 *  leaves the epic on the safe `incremental` default. */
export const COORDINATED_RELEASE_TAG = "coordinated-release";

/** Marker tags a coordinated PHASE CHILD carries to record its delivery state
 *  WITHOUT a schema migration (WorkItem.tags already exists). The readiness fix
 *  COSMOS-118 needs: a green+approved coordinated child is HELD in `review` (never
 *  `done`), so its board column alone can never read `ready`. The approve path
 *  stamps COORDINATED_READY_TAG instead — an "approved-but-held" marker the gate
 *  reads as `ready`. COORDINATED_FAILED_TAG marks a child that terminally gave up
 *  (blocks a hold-all release, AC3/AC5). */
export const COORDINATED_READY_TAG = "coordinated-ready";
export const COORDINATED_FAILED_TAG = "coordinated-failed";

/** Tag prefix encoding a phase child's 1-based position in its epic's ordered
 *  decomposition (COSMOS-115). This is the migration-free dependency edge: the gate
 *  turns it into Sibling.dependsOn (phase N depends on phase N-1) so the batch
 *  merges in dependency order. */
export const COORDINATED_PHASE_TAG_PREFIX = "coordinated-phase-";

/** Map a phase child's board column + tags to its release readiness (the COSMOS-118
 *  fix). `done` (merged/shipped) OR the approved-but-held marker → `ready`; the
 *  terminal-failure marker → `failed`; anything else is still in flight → `pending`.
 *  Failed wins over ready so a child that failed after being marked ready still
 *  blocks a hold-all release. */
export function childReadiness(columnKey: string, tags: readonly string[]): SiblingReadiness {
  if (tags.includes(COORDINATED_FAILED_TAG)) return "failed";
  if (columnKey === "done" || tags.includes(COORDINATED_READY_TAG)) return "ready";
  return "pending";
}

/** The 1-based phase index encoded in a child's tags, or null when unphased (a
 *  child that predates decomposition, or a hand-added one). Deterministic — the
 *  first well-formed phase tag wins. */
export function phaseIndexFromTags(tags: readonly string[]): number | null {
  for (const t of tags) {
    if (t.startsWith(COORDINATED_PHASE_TAG_PREFIX)) {
      const n = Number.parseInt(t.slice(COORDINATED_PHASE_TAG_PREFIX.length), 10);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  return null;
}

/** Partial-failure policy (AC3). `hold-all` (default) never ships a coordinated
 *  release while any sibling has terminally failed — no silent half-release.
 *  `ship-ready-subset` opts into shipping only the green+approved subset, still
 *  clearly surfaced. */
export type PartialFailurePolicy = "hold-all" | "ship-ready-subset";
export const DEFAULT_PARTIAL_FAILURE_POLICY: PartialFailurePolicy = "hold-all";

/** A phase child's delivery readiness within its epic:
 *  - `ready`   — green + approved (built, checks passed, reviewer/human approved),
 *                mergeable now;
 *  - `pending` — still in flight / not yet green+approved;
 *  - `failed`  — terminally cannot complete (gave up / hard failure). Blocks a
 *                `hold-all` coordinated release. */
export type SiblingReadiness = "ready" | "pending" | "failed";

export interface Sibling {
  /** Ticket ref, e.g. "COSMOS-119". */
  key: string;
  readiness: SiblingReadiness;
  /** Sibling refs this child must merge AFTER (its dependencies), from COSMOS-115's
   *  decomposition output. Empty/unknown → batch order falls back to a stable key
   *  sort. Deps outside the batch are ignored. */
  dependsOn?: string[];
}

/** What the gate decides for a coordinated epic. */
export type GateAction =
  /** Not everyone is ready yet — hold every ready child, ship nothing. */
  | "hold"
  /** All (or the allowed subset) are ready — merge `batch` in order as ONE version. */
  | "release"
  /** A sibling failed under `hold-all` — the coordinated release cannot ship. */
  | "abort";

export interface GateDecision {
  action: GateAction;
  /** Refs to merge, in dependency order, when `action === "release"`. Empty
   *  otherwise. */
  batch: string[];
  /** Human-readable rationale, surfaced on the ticket / console — never a silent
   *  half-release (AC3). */
  reason: string;
}

/** Resolve an epic's coordination mode from its tags. The safe default applies to
 *  every epic that hasn't opted in. */
export function coordinationModeFromTags(tags: readonly string[]): CoordinationMode {
  return tags.includes(COORDINATED_RELEASE_TAG) ? "coordinated" : DEFAULT_COORDINATION_MODE;
}

/** Dependency-ordered merge sequence for a batch of siblings (AC1: "in dependency
 *  order"). Topological sort — a child's `dependsOn` refs come before it — with a
 *  stable key sort as the tie-break so the order is deterministic. Cycle-safe: a
 *  dependency cycle can't hang or drop a node; the stable base order still covers
 *  every key. Deps referencing keys outside this batch are ignored. */
export function batchMergeOrder(siblings: readonly Sibling[]): string[] {
  const byKey = new Map(siblings.map((s) => [s.key, s]));
  // Deterministic base order — also the fallback when deps are unknown or cyclic.
  const stable = siblings.map((s) => s.key).sort();
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const order: string[] = [];
  const visit = (key: string): void => {
    if (visited.has(key)) return;
    if (inStack.has(key)) return; // back-edge (cycle) — break it; stable order still lists the node
    inStack.add(key);
    const node = byKey.get(key);
    if (node) {
      for (const dep of [...(node.dependsOn ?? [])].sort()) {
        if (byKey.has(dep)) visit(dep); // only order against deps inside the batch
      }
    }
    inStack.delete(key);
    visited.add(key);
    order.push(key);
  };
  for (const key of stable) visit(key);
  return order;
}

/** The coordinated-release decision (AC1 hold/release, AC3 partial-failure). Given
 *  the epic's mode, its siblings' readiness, and the partial-failure policy, returns
 *  whether to hold, release (with the ordered batch), or abort — always with a
 *  reason. Incremental mode (and the safe default) releases the ready set per-ticket,
 *  so non-coordinated work is untouched (AC2). */
export function decideRelease(input: {
  mode: CoordinationMode;
  siblings: readonly Sibling[];
  policy?: PartialFailurePolicy;
}): GateDecision {
  const { mode, siblings } = input;
  const policy = input.policy ?? DEFAULT_PARTIAL_FAILURE_POLICY;
  const ready = siblings.filter((s) => s.readiness === "ready");
  const pending = siblings.filter((s) => s.readiness === "pending");
  const failed = siblings.filter((s) => s.readiness === "failed");

  // Incremental / safe default: ship whatever is green+approved, per-ticket — no
  // coordination. Non-epic tickets flow through here too (a solo child ships alone).
  if (mode === "incremental") {
    return { action: "release", batch: batchMergeOrder(ready), reason: "incremental — ship per ticket" };
  }

  // Partial failure: a sibling can't complete. Never a silent half-release (AC3).
  if (failed.length > 0) {
    const failedKeys = failed.map((f) => f.key).join(", ");
    if (policy === "ship-ready-subset") {
      return ready.length > 0
        ? {
            action: "release",
            batch: batchMergeOrder(ready),
            reason: `partial failure — shipping ${ready.length} ready phase(s), skipping failed: ${failedKeys}`,
          }
        : { action: "abort", batch: [], reason: `partial failure — no phase ready to ship (failed: ${failedKeys})` };
    }
    // hold-all (default): any failure holds the entire coordinated release.
    return {
      action: "abort",
      batch: [],
      reason: `partial failure — coordinated release held (hold-all); cannot complete: ${failedKeys}`,
    };
  }

  // Still waiting on some siblings → hold every ready child.
  if (pending.length > 0) {
    return {
      action: "hold",
      batch: [],
      reason: `holding coordinated release — ${ready.length}/${siblings.length} phase(s) ready, waiting on ${pending.map((p) => p.key).join(", ")}`,
    };
  }

  // Every phase is green+approved → ship them as ONE coordinated version (AC1).
  return {
    action: "release",
    batch: batchMergeOrder(ready),
    reason: `all ${siblings.length} phase(s) green+approved — shipping as one coordinated release`,
  };
}

/** Aggregate readiness of an epic's phases, for the Foreman console and the hold
 *  note on a held child. `status` mirrors what the gate would do; `label` is a
 *  one-line summary safe to show a maintainer. */
export interface ReadinessSummary {
  mode: CoordinationMode;
  total: number;
  ready: number;
  pending: number;
  failed: number;
  status: "incremental" | "shipping" | "holding" | "blocked";
  label: string;
}

export function aggregateReadiness(mode: CoordinationMode, siblings: readonly Sibling[]): ReadinessSummary {
  const total = siblings.length;
  const ready = siblings.filter((s) => s.readiness === "ready").length;
  const pending = siblings.filter((s) => s.readiness === "pending").length;
  const failed = siblings.filter((s) => s.readiness === "failed").length;
  const base = { mode, total, ready, pending, failed };
  if (mode === "incremental") {
    return { ...base, status: "incremental", label: "incremental — phases ship per ticket" };
  }
  if (failed > 0) {
    return { ...base, status: "blocked", label: `blocked — ${failed}/${total} phase(s) failed, ${ready} ready` };
  }
  if (pending > 0) {
    return { ...base, status: "holding", label: `holding — ${ready}/${total} phase(s) ready, ${pending} pending` };
  }
  return { ...base, status: "shipping", label: `ready — all ${total} phase(s) green+approved` };
}
