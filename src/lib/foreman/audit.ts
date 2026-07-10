// The audit trail Foreman writes onto a ticket at every resolution — the record a
// human (or Claude) reads to rework or roll back a change without spelunking git.
// Pure + deterministic (no IO, no clock — the comment's own createdAt timestamps
// it), so the exact wording is unit-tested and can't silently drift.

export type AuditOutcome =
  | "shipped" // merged, tagged, deployed, health-gated green
  | "review" // built but parked (failed checks or risk-gated) as a draft PR
  | "ship-failed" // failed BEFORE the merge (push/PR/merge threw); branch still open, main untouched
  | "merged-undeployed" // merged to main, but the tag/image build failed before any deploy; prod unchanged
  | "rolled-back" // merged + deployed, but the deploy failed its health gate → prod rolled back
  | "agent-failed"; // the coding agent never produced a usable build (timeout / non-zero exit)

export interface AuditRecord {
  key: string; // e.g. "COSMOS-12"
  outcome: AuditOutcome;
  summary?: string; // one-line description of the change (the agent's commit subject)
  version?: string; // the version shipped, or proposed by the parked build
  rollbackTo?: string | null; // the version to redeploy to undo this (shipped / rolled-back)
  branch?: string; // the auto/<KEY> branch the change lives on
  prUrl?: string; // the PR opened for the change
  commit?: string; // short SHA of the built HEAD
  reason?: string; // why it parked/failed (gate reason or error text)
  checkLog?: string; // tail of the failing check output, for a "checks failed" park
}

const LABEL: Record<AuditOutcome, string> = {
  shipped: "shipped ✅",
  review: "parked for review ⏸",
  "ship-failed": "ship failed before merge — parked ⚠️",
  "merged-undeployed": "merged but not deployed — parked ⚠️",
  "rolled-back": "deploy rolled back — parked ⚠️",
  "agent-failed": "parked for review ⏸",
};

/** A parked build whose branch is still open (rework by checking it out) vs. a
 *  landed one whose branch the squash-merge deleted (rework by branching off the
 *  merged commit). `ship-failed` is pre-merge, so its branch survives; the
 *  merged/deployed outcomes do not. */
function branchStillOpen(outcome: AuditOutcome): boolean {
  return outcome === "review" || outcome === "ship-failed" || outcome === "agent-failed";
}

function prSuffix(outcome: AuditOutcome): string {
  if (outcome === "shipped" || outcome === "rolled-back" || outcome === "merged-undeployed") return " (merged)";
  if (outcome === "review") return " (draft — approve to ship)";
  return " (draft)";
}

/** Keep only the LAST `max` chars of a check log (failures print last), with a
 *  leading ellipsis when truncated, so an audit comment stays readable. */
export function tailLog(log: string, max = 1400): string {
  const t = log.replace(/\s+$/, "");
  return t.length <= max ? t : "…\n" + t.slice(t.length - max);
}

/** The "what do I do now" lines, tailored to the outcome. Rework instructions
 *  depend on whether the branch is still open; rollback appears only when a
 *  version actually reached prod. */
function actions(r: AuditRecord): string[] {
  const out: string[] = [];
  if (branchStillOpen(r.outcome) && r.branch) {
    out.push(
      `_Rework:_ \`git fetch origin && git checkout ${r.branch}\`, fix, push — then approve the PR (or move the card to Approved) and Foreman ships it next pass.`,
    );
  } else if (r.outcome === "shipped") {
    if (r.commit) out.push(`_Rework:_ branch from \`${r.commit}\`${r.prUrl ? ` (merged via ${r.prUrl})` : ""} on main, change it, and let Foreman ship the next version.`);
    if (r.rollbackTo) out.push(`_Roll back:_ redeploy the prior release — \`.deploy/deploy-apponly.sh ${r.rollbackTo}\`.`);
  } else if (r.outcome === "merged-undeployed") {
    out.push(
      `_Status:_ merged to main${r.commit ? ` (\`${r.commit}\`)` : ""} but the release image${r.version ? ` for v${r.version}` : ""} didn't finish; prod is unchanged (nothing deployed).`,
    );
    const revert = r.commit ? ` — or \`git revert ${r.commit}\` to undo the merge` : "";
    out.push(`_Rework:_ once the${r.version ? ` v${r.version}` : ""} image is built, deploy it${r.version ? ` — \`.deploy/deploy-apponly.sh ${r.version}\`` : ""}${revert}.`);
  } else if (r.outcome === "rolled-back") {
    out.push(
      `_Status:_ merged to main${r.commit ? ` (\`${r.commit}\`)` : ""} but its deploy failed the health gate; prod was rolled back${r.rollbackTo ? ` to \`${r.rollbackTo}\`` : ""}.`,
    );
    if (r.commit) out.push(`_Rework:_ fix forward on \`${r.commit}\` (Foreman redeploys next pass), or \`git revert ${r.commit}\` to undo the merge.`);
  }
  return out;
}

/** Render an audit record as the markdown comment Foreman posts on the ticket. */
export function formatAudit(r: AuditRecord): string {
  const lines: string[] = [`**Foreman — ${LABEL[r.outcome]}**`, ""];

  if (r.summary) lines.push(`- **Change:** ${r.summary}`);
  if (r.reason) lines.push(`- **Reason:** ${r.reason}`);
  if (r.version) lines.push(`- **Version:** \`${r.version}\` (${r.outcome === "shipped" ? "shipped" : "proposed"})`);

  const id: string[] = [];
  if (r.prUrl) id.push(`**PR:** ${r.prUrl}${prSuffix(r.outcome)}`);
  if (r.branch) id.push(`**Branch:** \`${r.branch}\``);
  if (r.commit) id.push(`**Commit:** \`${r.commit}\``);
  if (id.length) lines.push(`- ${id.join(" · ")}`);

  if (r.checkLog && r.checkLog.trim()) {
    lines.push("", "check output (tail):", "```", tailLog(r.checkLog), "```");
  }

  const acts = actions(r);
  if (acts.length) lines.push("", ...acts);

  return lines.join("\n");
}
