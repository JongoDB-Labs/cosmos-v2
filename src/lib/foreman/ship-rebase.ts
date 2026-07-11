// Ship-time rebase helpers for PARALLEL builds. With N workers building
// concurrently, every branch races main on exactly two files — package.json's
// version line and the changelog's newest entry — because each build bumps
// from the main it branched off. The ship worker rebases each built branch
// onto CURRENT main and resolves those two files mechanically: take main's
// copies, re-bump to the next version AFTER main, and re-prepend the build's
// changelog entry with the corrected version. (This automates the manual
// resolution performed repeatedly during interactive version races.) PURE
// text helpers here, fully unit-tested; the orchestrator owns git.

export type BumpKind = "minor" | "patch";

/** The next SemVer after `version` for the ticket's bump kind — the same rule
 *  the build agent applies (FEATURE→minor, BUG→patch). */
export function nextVersion(version: string, bump: BumpKind): string {
  const [maj = 0, min = 0, pat = 0] = version.split(".").map((n) => parseInt(n, 10) || 0);
  return bump === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}

/** Extract the newest changelog entry (the first `{ ... },` object literal
 *  after the CHANGELOG array opener) from a changelog.ts source. Returns the
 *  exact entry text (including trailing comma) and its version, or null when
 *  the build added no entry (internal-only change). */
export function extractTopChangelogEntry(source: string): { entry: string; version: string } | null {
  const anchor = "export const CHANGELOG: Release[] = [";
  const start = source.indexOf(anchor);
  if (start === -1) return null;
  const i = source.indexOf("{", start + anchor.length);
  if (i === -1) return null;
  // Balance braces to find the end of the first entry object.
  let depth = 0;
  let end = -1;
  for (let j = i; j < source.length; j++) {
    const ch = source[j];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = j;
        break;
      }
    }
  }
  if (end === -1) return null;
  // Include the trailing comma if present.
  let tail = end + 1;
  if (source[tail] === ",") tail++;
  const entry = source.slice(i, tail);
  const version = entry.match(/version:\s*"([^"]+)"/)?.[1];
  if (!version) return null;
  return { entry, version };
}

/** Prepend a (previously extracted) entry to a changelog source, rewriting its
 *  version to `newVersion`. Idempotent-ish: if the target changelog's top entry
 *  already carries `newVersion`, the source is returned unchanged (a retried
 *  ship must not double-insert). */
export function prependChangelogEntry(source: string, entry: string, newVersion: string): string {
  const existing = extractTopChangelogEntry(source);
  if (existing?.version === newVersion) return source;
  const anchor = "export const CHANGELOG: Release[] = [";
  const at = source.indexOf(anchor);
  if (at === -1) return source;
  const rewritten = entry.replace(/version:\s*"[^"]+"/, `version: "${newVersion}"`);
  const insertAt = at + anchor.length;
  const withComma = rewritten.trimEnd().endsWith(",") ? rewritten : `${rewritten},`;
  return `${source.slice(0, insertAt)}\n  ${withComma.trim()}${source.slice(insertAt)}`;
}

/** True when every conflicted path is one the ship worker knows how to resolve
 *  mechanically (the version-race trio). Anything else must abort → park. */
export function conflictsAreMechanical(conflictedPaths: string[]): boolean {
  const known = new Set(["package.json", "package-lock.json", "src/lib/changelog.ts"]);
  return conflictedPaths.length > 0 && conflictedPaths.every((p) => known.has(p));
}
