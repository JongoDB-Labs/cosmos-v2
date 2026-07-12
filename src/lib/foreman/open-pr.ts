// Pure fallback logic for the daemon's PR-open helper (see scripts/foreman/ship.mts
// `openPr`). Rebuilding a ticket whose prior draft PR on `auto/<KEY>` is still OPEN
// makes `gh pr create` exit non-zero with GitHub's "a pull request for branch …
// already exists" — which, unguarded, throws and wedges the park path for that
// build. `openPr` catches that one failure and resolves the existing PR via
// `gh pr view <branch> --json url,state`. These two helpers are the pure halves of
// that fallback — error classification and JSON-output parsing — kept in src/lib so
// vitest can exercise them without shelling out to `gh` (the .mts wrapper owns the
// real git/gh I/O, exactly as backfill-park-prurls.{mts,ts} are split).

/** True when a `gh pr create` failure is the benign "an open PR already exists on
 *  this head branch" case — the ONLY create failure `openPr` should recover from
 *  (every other failure — auth, no commits, missing base — must still surface).
 *  Reads both `stderr` (where `gh` writes the message) and `message` off the
 *  rejected execFile error, since Node populates them inconsistently. */
export function isPrAlreadyExistsError(err: unknown): boolean {
  const e = err as { stderr?: unknown; message?: unknown } | null | undefined;
  const text = [
    typeof e?.stderr === "string" ? e.stderr : "",
    typeof e?.message === "string" ? e.message : "",
  ].join("\n");
  return /already exists/i.test(text);
}

export type ExistingPrResolution =
  // PR is usable as-is (OPEN/MERGED/unknown state) — the force-push in pushBranch
  // already updated its head, so reuse the same URL.
  | { kind: "reuse"; url: string }
  // PR was CLOSED without merge — reopen it, then reuse the same URL/branch.
  | { kind: "reopen"; url: string }
  // No PR URL resolvable — caller should re-throw the original create error.
  | { kind: "none" };

/** Parse the stdout of `gh pr view <branch> --json url,state` and decide how
 *  `openPr` should recover. Only an explicit CLOSED state asks for a reopen;
 *  everything else that carries a URL is reused — this fails toward NOT throwing
 *  (reusing an existing PR URL is always safe, and a spurious `gh pr reopen` on a
 *  non-closed PR is exactly what we avoid). Reopen — not a suffixed branch — is the
 *  CLOSED strategy on purpose: it keeps the single-writer `auto/<KEY>` branch and
 *  the PR URL the console's Approve gate reads, both of which a fresh suffixed
 *  branch would orphan. Malformed/empty JSON, a non-object payload, or a blank url
 *  all yield `none`. */
export function resolveExistingPr(ghPrViewJson: string): ExistingPrResolution {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ghPrViewJson);
  } catch {
    return { kind: "none" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "none" };
  }
  const { url, state } = parsed as { url?: unknown; state?: unknown };
  const resolvedUrl = typeof url === "string" ? url.trim() : "";
  if (resolvedUrl.length === 0) return { kind: "none" };
  const normalizedState = typeof state === "string" ? state.toUpperCase() : "";
  if (normalizedState === "CLOSED") return { kind: "reopen", url: resolvedUrl };
  return { kind: "reuse", url: resolvedUrl };
}
