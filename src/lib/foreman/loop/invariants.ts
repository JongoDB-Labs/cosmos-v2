import { classifyRisk, type DiffSummary } from "@/lib/foreman/risk";
import { shouldDenyCommit } from "@/lib/foreman/harness";
import type { Action, InvariantResult, LoopState } from "./state";

export interface InvariantContext {
  state: LoopState;
  action: Action;
  diff?: DiffSummary;
  commit?: { command: string; pkgVersion: string; changelogTopVersion: string };
}

export interface Invariant {
  id: string;
  check(ctx: InvariantContext): InvariantResult;
}

/** Unified named guardrail set. Each entry WRAPS an existing pure check and
 *  carries a remediation — every invariant self-heals or escalates, never just
 *  fails. Do not reimplement risk/changelog logic here. */
export const INVARIANTS: Invariant[] = [
  {
    id: "changelog-required",
    check({ commit }) {
      if (!commit) return { id: "changelog-required", ok: true, detail: "no commit this transition", remediation: null };
      const deny = shouldDenyCommit(commit.command, commit.pkgVersion, commit.changelogTopVersion);
      return deny
        ? { id: "changelog-required", ok: false, detail: `version bump to ${commit.pkgVersion} without a matching changelog entry`, remediation: `Add a CHANGELOG entry for ${commit.pkgVersion} before committing.` }
        : { id: "changelog-required", ok: true, detail: "changelog matches package version", remediation: null };
    },
  },
  {
    id: "sensitive-path-review",
    check({ action, diff }) {
      if (action.kind !== "ship" || !diff) return { id: "sensitive-path-review", ok: true, detail: "not auto-shipping / no diff", remediation: null };
      const r = classifyRisk(diff);
      return r.gated
        ? { id: "sensitive-path-review", ok: false, detail: r.reasons.join("; "), remediation: "Park for human approval instead of auto-shipping." }
        : { id: "sensitive-path-review", ok: true, detail: "diff is auto-ship-safe", remediation: null };
    },
  },
];

export function enforce(ctx: InvariantContext): InvariantResult[] {
  return INVARIANTS.map((inv) => inv.check(ctx));
}
