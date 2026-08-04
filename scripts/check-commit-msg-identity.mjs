#!/usr/bin/env node
/**
 * Refuse to commit a message that names a client or private vertical.
 *
 * The arch test scans tracked FILE content, which leaves commit messages
 * unguarded — a gap its own comments record ("the customer's in commit messages
 * and PR descriptions this gate does not read"). It has bitten more than once,
 * most recently a message referencing a private plugin repo by name, pushed to
 * this public repo before anyone noticed. By then the only fixes are a
 * force-push, if nobody has pulled, or a history rewrite.
 *
 * Same pattern as the arch test, imported rather than copied — two lists would
 * drift, and the one that drifts is the one nobody is watching.
 *
 * Runs from the commit-msg hook, which passes the message file as $1.
 */
import { readFileSync } from "node:fs";
import { FORBIDDEN } from "./client-identity.mjs";

const path = process.argv[2];
if (!path) {
  console.error("check-commit-msg-identity: expected a commit-message file path");
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(path, "utf8");
} catch (err) {
  console.error(`check-commit-msg-identity: cannot read ${path}: ${err.message}`);
  process.exit(1);
}

// Scan only what becomes the message. Comment lines are stripped by git and
// include the branch name and the status block, so a branch legitimately named
// after a vertical would otherwise block every commit on it. `git commit
// --verbose` also appends the whole staged diff below a scissors line; that is
// file content the arch test already covers, and scanning it here would double-
// report while making the failure confusing.
const body = raw
  .split(/^# ------------------------ >8 ------------------------$/m)[0]
  .split("\n")
  .filter((line) => !line.startsWith("#"))
  .join("\n");

const match = body.match(FORBIDDEN);
if (match) {
  console.error(
    "\n✖ Commit message names a client or private vertical.\n" +
      `\n    matched: "${match[0]}"\n` +
      "\n  cosmos-v2 is PUBLIC, and a commit message is permanent in a way a file is\n" +
      "  not — it survives the file being fixed, and nothing in CI scans it.\n" +
      "\n  Reword it. Refer to the roadmap issue key (e.g. FND-4) or 'the private\n" +
      "  roadmap board' rather than naming the repo, the vertical, or the client.\n" +
      "\n  Then: git commit --amend\n",
  );
  process.exit(1);
}
