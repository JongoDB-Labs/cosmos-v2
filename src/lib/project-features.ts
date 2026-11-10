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
  "program-calendar",
] as const;

export type ToggleableFeature = (typeof TOGGLEABLE_FEATURES)[number];

export type FeatureOption = {
  key: ToggleableFeature;
  label: string;
  description: string;
  /**
   * RETIRED: still honoured on projects that already have it, never offered
   * to anyone new.
   *
   * This is deliberately not a deletion. Removing a key from
   * TOGGLEABLE_FEATURES makes the project PUT filter it out, so the next save
   * of a project's settings -- for any unrelated reason -- would silently
   * strip the flag and take the tab away from a project mid-flight. Keeping
   * the key and hiding the checkbox retires the feature without touching
   * anyone's data.
   *
   * See PICKABLE_FEATURE_OPTIONS below, which is what every picker renders.
   */
  retired?: boolean;
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
  // ── RETIRED: the PM Dashboard suite ───────────────────────────────────
  // Superseded by the org-level Program Management page (/program-management),
  // which answers the same questions across the portfolio with a project
  // picker instead of one tab per project. These stay honoured for projects
  // that already have them -- see `retired` above for why they are not simply
  // deleted -- and are offered to nobody new.
  { key: "pm-dashboard", label: "PM Dashboard", retired: true, description: "Retired — superseded by the Program Management page. Projects that already use it keep it." },
  { key: "risk-register", label: "PM · Risk Register", retired: true, description: "Risk register sub-tab (likelihood × impact, mitigation, owner)." },
  { key: "change-log", label: "PM · Change Log", retired: true, description: "Change-request register sub-tab (cost/schedule impact, approvals)." },
  { key: "blocked-items", label: "PM · Blocked Items", retired: true, description: "Blocker register sub-tab (what unblocks, owner, escalation)." },
  { key: "schedule-variance", label: "PM · Schedule", retired: true, description: "Schedule/milestone variance sub-tab (baseline vs projected vs actual)." },
  { key: "deliverables-tracker", label: "PM · Deliverables", retired: true, description: "CDRL/deliverable tracker sub-tab (due dates, gov review, revisions)." },
  { key: "vendors", label: "PM · Vendors", retired: true, description: "Vendor/subcontract register sub-tab (agreements, value, performance)." },
  { key: "staffing", label: "PM · Staffing", retired: true, description: "Staffing & compliance sub-tab (allocation, CAC/NDA/training status)." },
  { key: "clin-burn", label: "PM · CLIN Burn", retired: true, description: "CLIN funding/burn sub-tab (ceiling, funded, period of performance)." },
  { key: "program-calendar", label: "PM · Program Calendar", retired: true, description: "Program events, engagements and milestones on a month/week/day calendar, with category and owner overlays." },
] as const satisfies readonly FeatureOption[];

/**
 * What a picker should actually render: everything except the retired keys.
 *
 * Every UI that offers features to a human reads THIS. FEATURE_OPTIONS stays
 * complete so the exhaustiveness check below still covers every toggleable
 * key, and so a project holding a retired flag can still be shown a label for
 * it rather than a raw key.
 */
const RETIRED_FEATURES: ReadonlySet<string> = new Set(
  FEATURE_OPTIONS.filter((f) => "retired" in f && f.retired).map((f) => f.key),
);

/** Is this key retired — honoured where already set, offered to nobody new? */
export function isRetiredFeature(key: string): boolean {
  return RETIRED_FEATURES.has(key);
}

export const PICKABLE_FEATURE_OPTIONS: readonly FeatureOption[] =
  FEATURE_OPTIONS.filter((f) => !RETIRED_FEATURES.has(f.key));

/** The label for any key, retired or not — for rendering what a project HAS. */
export function featureLabel(key: string): string {
  return FEATURE_OPTIONS.find((f) => f.key === key)?.label ?? key;
}

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
