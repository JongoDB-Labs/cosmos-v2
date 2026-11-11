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
 * In CI the title and body come from the event payload file, never from workflow
 * interpolation (a PR body is attacker-controlled text, and
 * `${{ github.event.pull_request.body }}` substituted into a shell line would
 * execute whatever `$(…)` it contains) and never from `env:` either: a step
 * prints its env at the top of its log, and this repository's logs are public,
 * so every run published the body whole, including the runs that caught a name.
 * For the same reason CI output says where a match is, never what it is. Run
 * locally (PR_TITLE / PR_BODY in the environment), it shows the term.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { FORBIDDEN } from "./client-identity.mjs";

const { BASE_SHA = "", HEAD_SHA = "", GITHUB_EVENT_PATH = "" } = process.env;
const IN_CI = process.env.GITHUB_ACTIONS === "true";

/** The pull request to scan. In CI it must come from the event payload, and
 *  the gate fails closed without one: scanning an empty title and body would
 *  pass anything. Locally, PR_TITLE and PR_BODY stand in for it. */
function pullRequest() {
  if (!IN_CI && !GITHUB_EVENT_PATH) {
    return { title: process.env.PR_TITLE ?? "", body: process.env.PR_BODY ?? "" };
  }
  let pr;
  try {
    pr = JSON.parse(readFileSync(GITHUB_EVENT_PATH, "utf8")).pull_request;
  } catch {
    // Swallowed on purpose: a parse error quotes the payload line it failed on.
  }
  // GitHub requires a title, so a real pull request always has one.
  if (typeof pr?.title !== "string") {
    console.error("::error::the event payload has no pull request to scan");
    process.exit(1);
  }
  return pr;
}
const pr = pullRequest();

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

const commits = commitMessages();
const targets = [
  { what: "PR title", text: pr.title },
  { what: "PR body", text: pr.body ?? "" },
  { what: "branch name", text: pr.head?.ref ?? "" },
  ...commits.map(({ sha, message }) => ({ what: `commit ${sha}`, sha, text: message })),
];

const offenders = [];
for (const target of targets) {
  const match = target.text.match(FORBIDDEN);
  if (match) {
    const line = target.text.slice(0, match.index).split("\n").length;
    offenders.push({ ...target, where: `${target.what}, line ${line}`, matched: match[0] });
  }
}

if (offenders.length > 0) {
  console.error("\n✖ This pull request names a client or private vertical.\n");
  for (const o of offenders) {
    console.error(`    ${o.where}${IN_CI ? "" : ` — matched "${o.matched}"`}`);
    console.error(`::error::${o.where} names a client or private vertical`);
  }
  if (IN_CI) {
    const n = pr.number ?? "<n>";
    const local = offenders.map((o) =>
      o.sha
        ? `    git show -s --format=%B ${o.sha}`
        : `    gh pr view ${n} --json title,body,headRefName`,
    );
    console.error(
      "\n  The term is not printed: this log is public. To see it, look locally:\n" +
        [...new Set(local)].join("\n") +
        "\n",
    );
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

console.log(`::notice::no client identity in the title, body, branch name, or ${commits.length} commit message(s)`);
