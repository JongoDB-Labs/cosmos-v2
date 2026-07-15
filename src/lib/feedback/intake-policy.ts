/**
 * Org-level feedback INTAKE POLICY (COSMOS-121, Phase 3c).
 *
 * A single, normalized view over the four intake knobs an org may tune, each
 * built on the earlier phases and each with a SAFE DEFAULT so an org that never
 * touches the setting gets sensible, secure behaviour:
 *
 *   - `rateLimits`       — per-user / per-org / queue-depth / build-budget caps
 *                          + flood throttle (Phase 3a, `rate-limits.ts`).
 *   - `autoTriggerRoles` — which submitter roles may auto-trigger a build vs.
 *                          route to human triage (Phase 3b, `role-gating.ts`).
 *   - `classifier`       — the security-judge confidence threshold at which a
 *                          would-be "allow" is raised to a hold (`security-judge.ts`).
 *   - `highRiskZones`    — which advisory high-risk touch zones park an item at
 *                          intake (`guardrails.ts`); the security-critical
 *                          categories are NOT tunable.
 *
 * Pure — no DB, no I/O. Each field delegates to the phase module that owns it,
 * so there is exactly one normalization rule per knob and every consumer (the
 * config route, the settings form, the remediation loop) reads the same shape.
 *
 * The policy is persisted back into `Organization.settings` under the same keys
 * the phase readers already consume (`intakeLimits`, `autoTriggerRoles`, plus
 * the new `classifierPolicy` + `highRiskZones`), so writing a policy and reading
 * it back round-trips, AND a saved change immediately takes effect in the loop
 * (which reads those very keys).
 */

import type { OrgRole } from "@prisma/client";
import { DEFAULT_INTAKE_LIMITS, readIntakeLimits, type IntakeLimits } from "./rate-limits";
import {
  DEFAULT_AUTO_TRIGGER_ROLES,
  ORG_ROLES,
  readRoleGateConfig,
} from "./role-gating";
import { HIGH_RISK_ZONE_KEYS } from "./guardrails";
import { DEFAULT_JUDGE_MIN_CONFIDENCE, type JudgeConfidence } from "./security-judge";

export interface IntakeClassifierPolicy {
  /** Minimum security-judge confidence that raises a would-be "allow" to a hold. */
  judgeMinConfidence: JudgeConfidence;
}

export interface IntakePolicy {
  rateLimits: IntakeLimits;
  autoTriggerRoles: OrgRole[];
  classifier: IntakeClassifierPolicy;
  /** Active high-risk-zone keys (subset of `HIGH_RISK_ZONE_KEYS`), canonically
   *  ordered + de-duped. Default: all zones on. */
  highRiskZones: string[];
}

/** The safe default policy — a fresh org's behaviour before any edit. */
export const DEFAULT_INTAKE_POLICY: IntakePolicy = {
  rateLimits: { ...DEFAULT_INTAKE_LIMITS },
  autoTriggerRoles: [...DEFAULT_AUTO_TRIGGER_ROLES],
  classifier: { judgeMinConfidence: DEFAULT_JUDGE_MIN_CONFIDENCE },
  highRiskZones: [...HIGH_RISK_ZONE_KEYS],
};

const CONFIDENCE_VALUES = new Set<JudgeConfidence>(["low", "medium", "high"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize the classifier block from untrusted settings JSON. */
function readClassifier(settings: unknown): IntakeClassifierPolicy {
  const root = isRecord(settings) ? settings : {};
  const raw = isRecord(root.classifierPolicy) ? root.classifierPolicy : {};
  const conf = raw.judgeMinConfidence;
  return {
    judgeMinConfidence: CONFIDENCE_VALUES.has(conf as JudgeConfidence)
      ? (conf as JudgeConfidence)
      : DEFAULT_JUDGE_MIN_CONFIDENCE,
  };
}

const ZONE_KEY_SET = new Set<string>(HIGH_RISK_ZONE_KEYS);

/** Normalize the active high-risk-zone list: keep only real keys, de-dupe, and
 *  return them in canonical order. Absent / malformed ⇒ all zones on. An
 *  explicit empty array is honoured (an org may turn every advisory zone off). */
function readHighRiskZones(settings: unknown): string[] {
  const root = isRecord(settings) ? settings : {};
  const raw = root.highRiskZones;
  if (!Array.isArray(raw)) return [...HIGH_RISK_ZONE_KEYS];
  const seen = new Set(raw.filter((k): k is string => typeof k === "string" && ZONE_KEY_SET.has(k)));
  return HIGH_RISK_ZONE_KEYS.filter((k) => seen.has(k));
}

/**
 * Normalize an org's `settings` JSON (untrusted, unknown shape) into a validated
 * IntakePolicy. Every field falls back to its safe default, so a fresh or
 * malformed config yields exactly `DEFAULT_INTAKE_POLICY`.
 */
export function readIntakePolicy(settings: unknown): IntakePolicy {
  return {
    rateLimits: readIntakeLimits(settings),
    autoTriggerRoles: readRoleGateConfig(settings).autoTriggerRoles,
    classifier: readClassifier(settings),
    highRiskZones: readHighRiskZones(settings),
  };
}

/**
 * Serialize a policy into the partial `settings` shape to merge into
 * `Organization.settings`. Uses the same keys the phase readers consume, so
 * `readIntakePolicy(serializeIntakePolicy(p))` round-trips a normalized policy.
 */
export function serializeIntakePolicy(policy: IntakePolicy): {
  intakeLimits: IntakeLimits;
  autoTriggerRoles: OrgRole[];
  classifierPolicy: IntakeClassifierPolicy;
  highRiskZones: string[];
} {
  return {
    intakeLimits: policy.rateLimits,
    autoTriggerRoles: policy.autoTriggerRoles,
    classifierPolicy: policy.classifier,
    highRiskZones: policy.highRiskZones,
  };
}

const ROLE_SET = new Set<string>(ORG_ROLES);

/** Coerce an untrusted policy payload (e.g. from the settings form) into a fully
 *  normalized IntakePolicy, clamping every field to its validated range. Unknown
 *  / malformed fields fall back to the safe default — never throws. */
export function normalizeIntakePolicyInput(input: unknown): IntakePolicy {
  const root = isRecord(input) ? input : {};
  // rate-limits + classifier + high-risk zones already read from a settings-shaped
  // blob; re-key the incoming fields onto that shape and reuse the same readers.
  const rateLimits = readIntakeLimits({ intakeLimits: root.rateLimits });
  const classifier = readClassifier({ classifierPolicy: root.classifier });
  const highRiskZones = readHighRiskZones({ highRiskZones: root.highRiskZones });

  const rolesRaw = Array.isArray(root.autoTriggerRoles) ? root.autoTriggerRoles : null;
  const validRoles = rolesRaw
    ? new Set(rolesRaw.filter((r): r is OrgRole => typeof r === "string" && ROLE_SET.has(r)))
    : null;
  const autoTriggerRoles =
    validRoles && validRoles.size > 0
      ? ORG_ROLES.filter((r) => validRoles.has(r))
      : [...DEFAULT_AUTO_TRIGGER_ROLES];

  return { rateLimits, autoTriggerRoles, classifier, highRiskZones };
}
