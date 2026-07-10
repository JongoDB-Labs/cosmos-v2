export interface DiffSummary {
  files: string[];
  additions: number;
  deletions: number;
}
export interface RiskResult {
  gated: boolean;
  reasons: string[];
}

const MIGRATION = [/^prisma\/migrations\//, /^prisma\/schema\.prisma$/];
const SENSITIVE = [
  /^src\/lib\/auth\//,
  /^src\/lib\/rbac\//,
  /\/abac\//,
  /^src\/lib\/ai\/egress\//,
  /^Dockerfile$/,
  /^next\.config\.ts$/,
  /^\.deploy\//,
  /^\.github\/workflows\//,
  // Foreman's own code + the risk/ship/agent logic: a self-modifying change must be
  // human-reviewed before it lands (never auto-ship a change to the thing doing the
  // auto-shipping, or it could silently weaken its own safety gates).
  /^scripts\/foreman\//,
  /^src\/lib\/foreman\//,
];

/** Decide whether a change may auto-ship (safe) or must park for approval (gated).
 *  Gated = touches schema/migrations, a sensitive path, or exceeds the size budget.
 *  Failing checks are gated by the orchestrator, not here. */
export function classifyRisk(
  diff: DiffSummary,
  opts: { maxFiles?: number; maxLines?: number } = {},
): RiskResult {
  const maxFiles = opts.maxFiles ?? 8;
  const maxLines = opts.maxLines ?? 400;
  const reasons: string[] = [];
  if (diff.files.some((f) => MIGRATION.some((re) => re.test(f))))
    reasons.push("schema / migration change");
  if (diff.files.some((f) => SENSITIVE.some((re) => re.test(f))))
    reasons.push("touches a sensitive path");
  if (diff.files.length > maxFiles)
    reasons.push(`${diff.files.length} files changed (> ${maxFiles})`);
  if (diff.additions + diff.deletions > maxLines)
    reasons.push(`${diff.additions + diff.deletions} lines changed (> ${maxLines})`);
  return { gated: reasons.length > 0, reasons };
}
