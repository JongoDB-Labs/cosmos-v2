#!/usr/bin/env node
/**
 * Refuse to commit staged content that names a client or private vertical.
 *
 * Three checks already guard this repo's identity rule, and between them they
 * leave one gap:
 *
 *   - the arch test scans TRACKED file content, in CI;
 *   - check-commit-msg-identity scans the COMMIT MESSAGE, at commit time;
 *   - check-pr-identity scans the PR TITLE AND BODY, in CI.
 *
 * The arch test enumerates files with `git ls-files`, which lists tracked files
 * only. A NEW file is invisible to it until its first commit — so running the
 * suite locally before `git add` returns a confident pass, and the leak is
 * caught in CI on a branch that has already been pushed to a public repo.
 *
 * That is not theoretical: it is how a private plugin slug reached this repo
 * twice in one session, both times in a newly added file whose author had run
 * the gate beforehand. By the time CI speaks, the only remedies are a
 * force-push, if nobody has pulled, or a history rewrite.
 *
 * This closes the gap at the same moment the message check does — before the
 * commit exists, when the fix is free.
 *
 * Scans STAGED CONTENT, not the working tree, for the same reason
 * check-conflict-markers does: what is committed is what matters, and the two
 * differ constantly here because `release:bump` deliberately leaves the index
 * and the working tree disagreeing.
 *
 * Same pattern as the other three, imported rather than copied — two lists would
 * drift, and the one that drifts is the one nobody is watching.
 */
import { execFileSync } from "node:child_process";
import { FORBIDDEN, PATTERN_FILES } from "./client-identity.mjs";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const staged = git(["diff", "--cached", "--name-only", "--diff-filter=ACM"])
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean)
  // The pattern machinery itself: excluded for the same reason the arch test
  // excludes it, so that stays true if anyone adds an illustrative literal.
  .filter((f) => !PATTERN_FILES.includes(f));

const offenders = [];
for (const file of staged) {
  let content;
  try {
    // The staged blob, not the file on disk.
    content = git(["show", `:${file}`]);
  } catch {
    continue; // deleted, or not a regular blob
  }
  // Binary files come back with NULs; skip rather than scan them.
  if (content.includes("\0")) continue;
  if (FORBIDDEN.test(content)) offenders.push(file);
}

if (offenders.length > 0) {
  console.error("\n✖ Staged content names a client or private vertical:\n");
  for (const f of offenders) console.error(`    ${f}`);
  console.error(
    "\n  cosmos-v2 is PUBLIC. Neutralize the wording — describe the shape, not\n" +
      "  the plugin — and `git add` again. Do NOT add an allowlist.\n" +
      "\n  Test fixtures rarely need a real slug: `alpha`/`beta` read better and\n" +
      "  cannot leak.\n",
  );
  process.exit(1);
}
