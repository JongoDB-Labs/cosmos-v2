#!/usr/bin/env node
/**
 * Refuse a pull request whose title, body, or commit messages name a client or
 * private vertical.
 *
 * This is the CI half of the commit-message guard. The commit-msg hook catches
 * it earlier and more cheaply, but only for people who have run `npm install`
 * (husky's `prepare`), and `--no-verify` walks straight past it. CI is the part
 * nobody can skip.
 *
 * It also covers the surface the hook cannot see at all: the PR **title and
 * body**, which are written in the browser, never touch a git hook, and are the
 * other half of the gap the arch test records — "the customer's in commit
 * messages and PR descriptions this gate does not read".
 *
 * Same pattern as the arch test and the hook, imported rather than copied.
 *
 * Input arrives via the environment, never via workflow interpolation: a PR body
 * is attacker-controlled text, and `${{ github.event.pull_request.body }}`
 * substituted into a shell line would execute whatever `$(…)` it contains.
 */
import { execFileSync } from "node:child_process";
import { FORBIDDEN } from "./client-identity.mjs";

const { PR_TITLE = "", PR_BODY = "", BASE_SHA = "", HEAD_SHA = "" } = process.env;

/** Commit subjects+bodies in the PR range. Empty if the range is unavailable —
 *  a shallow checkout should degrade to scanning title/body, not hard-fail. */
function commitMessages() {
  if (!BASE_SHA || !HEAD_SHA) return [];
  try {
    return execFileSync("git", ["log", "--format=%H%x00%B%x00", `${BASE_SHA}..${HEAD_SHA}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0\n")
      .filter(Boolean)
      .map((chunk) => {
        const [sha, message] = chunk.split("\0");
        return { sha: (sha ?? "").trim().slice(0, 8), message: message ?? "" };
      });
  } catch {
    console.log("::notice::commit range unavailable — scanned title and body only");
    return [];
  }
}

const targets = [
  { what: "PR title", text: PR_TITLE },
  { what: "PR body", text: PR_BODY },
  ...commitMessages().map(({ sha, message }) => ({ what: `commit ${sha}`, message, text: message })),
];

const offenders = [];
for (const target of targets) {
  const match = target.text.match(FORBIDDEN);
  if (match) offenders.push({ ...target, matched: match[0] });
}

if (offenders.length > 0) {
  console.error("\n✖ This pull request names a client or private vertical.\n");
  for (const o of offenders) {
    console.error(`    ${o.what} — matched "${o.matched}"`);
    console.error(`::error::${o.what} names a client or private vertical ("${o.matched}")`);
  }
  console.error(
    "\n  cosmos-v2 is PUBLIC. A title or body can be edited in place; a commit\n" +
      "  message cannot — fixing that needs an amend or a rebase, and once merged,\n" +
      "  a history rewrite.\n" +
      "\n  Reword to the roadmap issue key (e.g. FND-4) or 'the private roadmap\n" +
      "  board'. Do not add an allowlist.\n",
  );
  process.exit(1);
}

console.log(`::notice::no client identity in the title, body, or ${targets.length - 2} commit message(s)`);
