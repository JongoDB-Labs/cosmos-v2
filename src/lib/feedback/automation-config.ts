/**
 * The single place that normalizes an org's `Organization.settings` JSON
 * (an untrusted, unknown shape) into the automation config the feedback
 * pipeline runs on, prunes project ids that no longer belong to the org
 * (moved/deleted), gates "enabled without a valid project scope," and decides
 * whether a change widens what the automation reaches.
 *
 * Pure — no DB, no imports. Shared by the config route, triage, and Foreman,
 * so every consumer reads/validates the same normalized shape rather than
 * re-deriving it (and re-diverging) per call site.
 */

export interface AutoRemediationCfg {
  enabled: boolean;
  projectIds: string[];
  defaultProjectId: string | null;
}

export interface AutonomousDeliveryCfg {
  enabled: boolean;
  projectIds: string[];
  /** Owner notifications for delivery outcomes. Absent (legacy configs) = both
   *  ON — the loop acting silently is the surprising behavior, not the ping. */
  notify: { parked: boolean; shipped: boolean };
  /** Concurrent build workers (1-3, default 2). Each worker is a full coding
   *  session + test-suite run; ship stays serialized regardless, so >3 is all
   *  cost and no throughput. The daemon re-reads this live — no restart. */
  workers: number;
}

export const MAX_DELIVERY_WORKERS = 3;
export const DEFAULT_DELIVERY_WORKERS = 2;

function clampWorkers(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULT_DELIVERY_WORKERS;
  return Math.min(MAX_DELIVERY_WORKERS, Math.max(1, n));
}

export interface AutomationConfig {
  autoRemediation: AutoRemediationCfg;
  autonomousDelivery: AutonomousDeliveryCfg;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `null` when `value` isn't an array at all; otherwise the array with any
 *  non-string entries dropped (defensive against untrusted JSON). */
function toStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function readAutoRemediation(raw: unknown): AutoRemediationCfg {
  const cfg = isRecord(raw) ? raw : {};
  const enabled = cfg.enabled === true;

  const projectIds = toStringArray(cfg.projectIds);
  if (projectIds !== null) {
    return {
      enabled,
      projectIds,
      defaultProjectId: typeof cfg.defaultProjectId === "string" ? cfg.defaultProjectId : null,
    };
  }

  // Legacy back-compat: pre-multi-project configs stored a single
  // `targetProjectId` instead of `projectIds` + `defaultProjectId`.
  if (typeof cfg.targetProjectId === "string") {
    return { enabled, projectIds: [cfg.targetProjectId], defaultProjectId: cfg.targetProjectId };
  }

  return { enabled, projectIds: [], defaultProjectId: null };
}

function readAutonomousDelivery(raw: unknown): AutonomousDeliveryCfg {
  const cfg = isRecord(raw) ? raw : {};
  const notify = isRecord(cfg.notify) ? cfg.notify : {};
  return {
    enabled: cfg.enabled === true,
    projectIds: toStringArray(cfg.projectIds) ?? [],
    // Default ON: only an explicit `false` silences an event.
    notify: { parked: notify.parked !== false, shipped: notify.shipped !== false },
    workers: clampWorkers(cfg.workers),
  };
}

/** Normalize an org's `settings` JSON (unknown shape) into AutomationConfig, with
 *  back-compat for the legacy single-project auto-remediation config. */
export function readAutomationConfig(settings: unknown): AutomationConfig {
  const root = isRecord(settings) ? settings : {};
  return {
    autoRemediation: readAutoRemediation(root.autoRemediation),
    autonomousDelivery: readAutonomousDelivery(root.autonomousDelivery),
  };
}

/** Drop any project id no longer present in the org (moved/deleted), so a stale
 *  config never wedges the settings form. defaultProjectId is cleared if it's not
 *  in the pruned projectIds. If pruning empties a block's scope, that block is also
 *  DISABLED — an automation with no projects can't run, and leaving it `enabled`
 *  but empty is an invalid state that fails the enable-gate and blocks every save
 *  (including edits to the OTHER card, which share one PUT). */
export function pruneToProjects(config: AutomationConfig, validProjectIds: Set<string>): AutomationConfig {
  const autoRemediationProjectIds = config.autoRemediation.projectIds.filter((id) => validProjectIds.has(id));
  const defaultProjectId =
    config.autoRemediation.defaultProjectId !== null &&
    autoRemediationProjectIds.includes(config.autoRemediation.defaultProjectId)
      ? config.autoRemediation.defaultProjectId
      : null;
  const autonomousDeliveryProjectIds = config.autonomousDelivery.projectIds.filter((id) =>
    validProjectIds.has(id),
  );

  return {
    autoRemediation: {
      enabled: config.autoRemediation.enabled && autoRemediationProjectIds.length > 0,
      projectIds: autoRemediationProjectIds,
      defaultProjectId,
    },
    autonomousDelivery: {
      enabled: config.autonomousDelivery.enabled && autonomousDeliveryProjectIds.length > 0,
      projectIds: autonomousDeliveryProjectIds,
      notify: config.autonomousDelivery.notify,
      workers: config.autonomousDelivery.workers,
    },
  };
}

/** Shown to anyone who tries to widen automation without being the instance
 *  operator. Shared by the server's refusal and the settings form. */
export const OPERATOR_ONLY_MESSAGE = "Only the instance operator can turn on automated delivery or add build workers.";

/** How far `after` reaches beyond `before`, as flags and counts (never which
 *  projects): either automation turning on, projects joining either list, and
 *  the parallel build workers before and after. */
export interface AutomationWidening {
  turnsOnAutoTriage: boolean;
  turnsOnDelivery: boolean;
  autoTriageProjectsAdded: number;
  deliveryProjectsAdded: number;
  workersBefore: number;
  workersAfter: number;
}

export function automationWidening(before: AutomationConfig, after: AutomationConfig): AutomationWidening {
  const added = (from: string[], to: string[]) => new Set(to.filter((id) => !from.includes(id))).size;
  return {
    turnsOnAutoTriage: after.autoRemediation.enabled && !before.autoRemediation.enabled,
    turnsOnDelivery: after.autonomousDelivery.enabled && !before.autonomousDelivery.enabled,
    autoTriageProjectsAdded: added(before.autoRemediation.projectIds, after.autoRemediation.projectIds),
    deliveryProjectsAdded: added(before.autonomousDelivery.projectIds, after.autonomousDelivery.projectIds),
    workersBefore: before.autonomousDelivery.workers,
    workersAfter: after.autonomousDelivery.workers,
  };
}

/** True when `after` reaches further than `before`: either automation turns on,
 *  either project list gains a project, or the parallel build workers go up.
 *  Turning off, removing projects, fewer workers, notify and the default
 *  project never widen.
 *
 *  Widening puts more of an org's work into the deployment's shared build pool
 *  (the pool runs the highest worker count any enabled org asks for), so it is
 *  the instance operator's call; callers compare against the STORED config,
 *  never against what the client last saw. */
export function widensAutomation(before: AutomationConfig, after: AutomationConfig): boolean {
  const w = automationWidening(before, after);
  return (
    w.turnsOnAutoTriage ||
    w.turnsOnDelivery ||
    w.autoTriageProjectsAdded > 0 ||
    w.deliveryProjectsAdded > 0 ||
    w.workersAfter > w.workersBefore
  );
}

/** Audit metadata for a change to either enabled flag, either project list or
 *  the worker count, or null when none of those moved. Counts only, never
 *  which projects. */
export function automationAuditDelta(
  before: AutomationConfig,
  after: AutomationConfig,
): Record<string, boolean | number> | null {
  const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));
  const moved =
    before.autoRemediation.enabled !== after.autoRemediation.enabled ||
    before.autonomousDelivery.enabled !== after.autonomousDelivery.enabled ||
    !sameIds(before.autoRemediation.projectIds, after.autoRemediation.projectIds) ||
    !sameIds(before.autonomousDelivery.projectIds, after.autonomousDelivery.projectIds) ||
    before.autonomousDelivery.workers !== after.autonomousDelivery.workers;
  if (!moved) return null;
  return {
    autoTriageEnabledBefore: before.autoRemediation.enabled,
    autoTriageEnabledAfter: after.autoRemediation.enabled,
    autoTriageProjectsBefore: new Set(before.autoRemediation.projectIds).size,
    autoTriageProjectsAfter: new Set(after.autoRemediation.projectIds).size,
    deliveryEnabledBefore: before.autonomousDelivery.enabled,
    deliveryEnabledAfter: after.autonomousDelivery.enabled,
    deliveryProjectsBefore: new Set(before.autonomousDelivery.projectIds).size,
    deliveryProjectsAfter: new Set(after.autonomousDelivery.projectIds).size,
    workersBefore: before.autonomousDelivery.workers,
    workersAfter: after.autonomousDelivery.workers,
  };
}

/** Returns a human-readable reason a config CANNOT be saved as-is, or null if OK.
 *  Enforces: you can't enable an automation without a valid project scope. */
export function validateEnableGate(cfg: AutomationConfig): string | null {
  const { autoRemediation, autonomousDelivery } = cfg;

  if (autoRemediation.enabled && autoRemediation.projectIds.length === 0) {
    return "Select at least one project to receive triaged feedback before enabling auto-triage.";
  }

  if (
    autoRemediation.enabled &&
    (autoRemediation.defaultProjectId === null || !autoRemediation.projectIds.includes(autoRemediation.defaultProjectId))
  ) {
    return "Choose a default project (one of the selected projects) before enabling auto-triage.";
  }

  if (autonomousDelivery.enabled && autonomousDelivery.projectIds.length === 0) {
    return "Select at least one project before enabling autonomous delivery.";
  }

  return null;
}
