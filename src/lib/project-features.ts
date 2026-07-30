/**
 * Single source of truth for the optional project features.
 *
 * These drive the board tabs (board-tabs.tsx), the PM Dashboard sub-tabs
 * (pm-dashboard/pm-nav.tsx) and the Intervals header button (project layout).
 * They are set three ways — the project settings PUT, the project Settings UI,
 * and the org template editor — and each of those used to carry its own copy of
 * the list.
 *
 * That drift is what produced the bug this file exists to prevent: the template
 * editor offered "risk", "decision" and "meeting_note", none of which are real
 * keys. The PUT filters anything outside TOGGLEABLE_FEATURES, so those flags
 * were written to the template, handed to every project created from it, and
 * silently did nothing. Six built-in sector templates shipped with them.
 *
 * Keep both lists here. The type wiring below makes divergence a compile error:
 * an unknown key fails on FEATURE_OPTIONS' element type, and a key with no label
 * fails on the exhaustiveness assertion.
 */

// The keys the project PUT will persist. Anything else is filtered out on save.
export const TOGGLEABLE_FEATURES = [
  "okr",
  "goal",
  "kpi",
  "milestone",
  "interval",
  "roadmap",
  "files",
  "pm-dashboard",
  // PM Dashboard register sub-tabs — each gated by its own flag (see
  // pm-dashboard/pm-nav.tsx). Reachable only when "pm-dashboard" is also on:
  // the dashboard tab is the sole nav entry into /pm-dashboard/*, so a register
  // enabled without it is a page with no way to click through to it.
  "risk-register",
  "change-log",
  "blocked-items",
  "schedule-variance",
  "deliverables-tracker",
  "vendors",
  "staffing",
  "clin-burn",
] as const;

export type ToggleableFeature = (typeof TOGGLEABLE_FEATURES)[number];

export type FeatureOption = {
  key: ToggleableFeature;
  label: string;
  description: string;
};

/** Labelled features for any UI that lets someone pick them. */
export const FEATURE_OPTIONS = [
  { key: "okr", label: "OKRs", description: "Objectives & key results board." },
  { key: "goal", label: "Goals", description: "Track project goals with rollup progress." },
  { key: "kpi", label: "KPIs", description: "Track metrics with targets and trend charts." },
  { key: "milestone", label: "Milestones", description: "Key dates on a delivery timeline." },
  { key: "interval", label: "Intervals / Sprints", description: "Time-boxed iterations of work." },
  { key: "roadmap", label: "Roadmap", description: "Navigable program roadmap (phases, LOEs, risks, decisions) that issues link to as source-of-truth." },
  { key: "files", label: "Files", description: "Upload & navigate project documents (docx/pdf/pptx/xlsx); convert them to items." },
  { key: "pm-dashboard", label: "PM Dashboard", description: "GovCon program-management suite: risk/change/blocked/schedule/deliverables/vendors/staffing/CLIN registers with drill-down, derived metrics & Excel export." },
  // PM Dashboard register sub-tabs (require PM Dashboard; each adds a sub-tab).
  { key: "risk-register", label: "PM · Risk Register", description: "Risk register sub-tab (likelihood × impact, mitigation, owner)." },
  { key: "change-log", label: "PM · Change Log", description: "Change-request register sub-tab (cost/schedule impact, approvals)." },
  { key: "blocked-items", label: "PM · Blocked Items", description: "Blocker register sub-tab (what unblocks, owner, escalation)." },
  { key: "schedule-variance", label: "PM · Schedule", description: "Schedule/milestone variance sub-tab (baseline vs projected vs actual)." },
  { key: "deliverables-tracker", label: "PM · Deliverables", description: "CDRL/deliverable tracker sub-tab (due dates, gov review, revisions)." },
  { key: "vendors", label: "PM · Vendors", description: "Vendor/subcontract register sub-tab (agreements, value, performance)." },
  { key: "staffing", label: "PM · Staffing", description: "Staffing & compliance sub-tab (allocation, CAC/NDA/training status)." },
  { key: "clin-burn", label: "PM · CLIN Burn", description: "CLIN funding/burn sub-tab (ceiling, funded, period of performance)." },
] as const satisfies readonly FeatureOption[];

/**
 * Compile-time guarantee that every toggleable key has a label. Adding a key to
 * TOGGLEABLE_FEATURES without adding it to FEATURE_OPTIONS makes this fail to
 * typecheck rather than quietly dropping a checkbox out of both pickers.
 */
type AssertNever<T extends never> = T;
export type _EveryFeatureIsLabelled = AssertNever<
  Exclude<ToggleableFeature, (typeof FEATURE_OPTIONS)[number]["key"]>
>;

/** Narrowing helper for the untrusted string arrays that arrive over the wire. */
export function isToggleableFeature(value: string): value is ToggleableFeature {
  return (TOGGLEABLE_FEATURES as readonly string[]).includes(value);
}
