#!/usr/bin/env node
/**
 * Refuse to commit unresolved merge-conflict markers.
 *
 * `git add <file>` on a CONFLICTED file stages whatever is in it — markers
 * included. That is easy to do during a rebase when several files conflict and
 * only some need real attention: the ones you meant to resolve later get staged
 * with `<<<<<<<` still in them.
 *
 * It happened to `package.json` and `package-lock.json`, which lint-staged does
 * not cover (it runs eslint over `*.{ts,tsx,js,jsx}` only). CI does catch it —
 * an unparseable package.json fails everything — but a full pipeline is an
 * expensive way to learn you typed `git add` one file too early.
 *
 * Scans STAGED CONTENT, not the working tree: what is committed is what matters,
 * and the two differ constantly here because `release:bump` deliberately leaves
 * the index and the working tree disagreeing.
 */
import { execFileSync } from "node:child_process";

/** Anchored to line starts: these appear mid-line in legitimate content
 *  (regexes, docs about conflicts, base64), and a false positive that blocks
 *  commits is worse than the bug this prevents. */
const MARKER = /^(<{7}|={7}|>{7})(\s|$)/m;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const staged = git(["diff", "--cached", "--name-only", "--diff-filter=ACM"])
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean);

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
  if (MARKER.test(content)) offenders.push(file);
}

if (offenders.length > 0) {
  console.error("\n✖ Unresolved merge-conflict markers in staged files:\n");
  for (const f of offenders) console.error(`    ${f}`);
  console.error(
    "\n  Resolve them, `git add` again, and re-commit.\n" +
      "  (`git add` on a conflicted file stages the markers with it.)\n",
  );
  process.exit(1);
}
