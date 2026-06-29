/**
 * Govcon risk scoring — likelihood × impact on a 1-5 scale (score 1-25),
 * banded into the severity levels the Risk Register uses. Shared by the seed,
 * any write path, and the PM Dashboard so the derivation lives in one place.
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Risk score = likelihood × impact (each 1-5). */
export function computeRiskScore(likelihood: number, impact: number): number {
  return likelihood * impact;
}

/** Map a 1-25 score to its severity band. */
export function riskLevelFromScore(score: number): RiskLevel {
  if (score >= 20) return "CRITICAL";
  if (score >= 12) return "HIGH";
  if (score >= 6) return "MEDIUM";
  return "LOW";
}
