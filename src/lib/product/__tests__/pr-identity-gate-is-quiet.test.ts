// The PR identity gate must not publish what it catches.
//
// cosmos-v2 is public, and so are its Actions logs and annotations. The gate
// used to print the matched term in both, and its workflow passed the PR body
// in as env, which every step prints in its log header. So each catch
// republished the name it was there to keep out, in a log that outlives the
// author's fix to the PR. In CI it now says where, never what. Run locally,
// it still shows the term.
//
// This file follows the same rule: every assertion reports a boolean or an
// exit status, never the gate's output. In CI the test reporter prints a
// failing assertion's values into the public log and an annotation.
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FORBIDDEN } from "../../../../scripts/client-identity.mjs";

// A real forbidden term, taken from the decoded pattern at run time so this
// file never contains one.
const term = FORBIDDEN.source
  .split("|")
  .map((alt) => alt.replace(/\\b/g, ""))
  .find((alt) => /^[A-Za-z0-9-]+$/.test(alt) && FORBIDDEN.test(alt))!;

const SCRIPT = resolve("scripts/check-pr-identity.mjs");
// Payloads and the scratch repo hold a real term; remove them afterwards.
const dir = mkdtempSync(join(tmpdir(), "pr-identity-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const gate = (env: Record<string, string>, cwd?: string) => {
  const r = spawnSync("node", [SCRIPT], {
    cwd,
    env: { PATH: process.env.PATH, ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  const out = r.stdout + r.stderr;
  // Predicates only: the output itself never reaches an assertion.
  return { status: r.status, says: (s: string) => out.includes(s), names: FORBIDDEN.test(out) };
};
let events = 0;
const inCi = (payload: unknown, env: Record<string, string> = {}, cwd?: string) => {
  const path = join(dir, `event-${events++}.json`);
  writeFileSync(path, typeof payload === "string" ? payload : JSON.stringify(payload));
  return gate({ GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: path, ...env }, cwd);
};
const pr = (over: object = {}) => ({
  pull_request: { number: 7, title: "fix: a thing", body: "Nothing to see.", head: { ref: "fix/a-thing" }, ...over },
});

describe("the PR identity gate", () => {
  it("has a term to test with", () => {
    expect(Boolean(term)).toBe(true);
  });

  it("passes a clean pull request", () => {
    const r = inCi(pr());
    expect(r.status).toBe(0);
    expect(r.says("no client identity"), "reports what it scanned").toBe(true);
  });

  it("fails on the body in CI, saying where but never what", () => {
    const r = inCi(pr({ body: `Intro.\n\nSee ${term} for details.` }));
    expect(r.status).toBe(1);
    expect(r.says("PR body, line 3"), "names the field and line").toBe(true);
    expect(r.names, "the output names the term it caught").toBe(false);
  });

  it("fails on the title, read from the event payload", () => {
    const r = inCi(pr({ title: `fix: ${term}` }));
    expect(r.status).toBe(1);
    expect(r.says("PR title, line 1"), "names the field and line").toBe(true);
    expect(r.names, "the output names the term it caught").toBe(false);
  });

  it("fails on the branch name", () => {
    const r = inCi(pr({ head: { ref: `feat/${term}` } }));
    expect(r.status).toBe(1);
    expect(r.says("branch name, line 1"), "names the field").toBe(true);
    expect(r.names, "the output names the term it caught").toBe(false);
  });

  it("fails on a commit message, saying which commit but never what", () => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("commit", "-q", "--allow-empty", "-m", `fix: a thing\n\nMentions ${term}.`);
    const head = git("rev-parse", "HEAD");
    const r = inCi(pr(), { BASE_SHA: base, HEAD_SHA: head }, repo);
    expect(r.status).toBe(1);
    expect(r.says(`commit ${head.slice(0, 8)}, line 3`), "names the commit and line").toBe(true);
    expect(r.names, "the output names the term it caught").toBe(false);
  });

  it("fails closed when CI gives it nothing to scan", () => {
    // Scanning an empty title and body would pass anything.
    // Each must be the gate's own refusal: a crash also exits 1, by accident.
    const refused = (r: ReturnType<typeof gate>) => [r.status, r.says("no pull request to scan")];
    expect(refused(inCi({ push: {} })), "no pull request in the payload").toEqual([1, true]);
    expect(refused(inCi({ pull_request: { body: "x" } })), "a pull request with no title").toEqual([1, true]);
    expect(refused(gate({ GITHUB_ACTIONS: "true" })), "no payload path").toEqual([1, true]);
    const r = inCi('{"pull_request": {"title": "MARKER-7f3a"');
    expect(refused(r), "a payload that does not parse").toEqual([1, true]);
    expect(r.says("MARKER-7f3a"), "a parse error quotes the payload").toBe(false);
  });

  it("shows the term when run locally, where the output is private", () => {
    const r = gate({ PR_TITLE: "fix: a thing", PR_BODY: `See ${term}.` });
    expect(r.status).toBe(1);
    expect(r.says(term), "shows the matched term").toBe(true);
  });

  it("is handed nothing from the event but the PR number and the two SHAs", () => {
    // Anything else in an expression lands in the step's env or name, which
    // the log prints: the title and body, or all of it through toJSON.
    const wf = readFileSync(".github/workflows/pr-identity.yml", "utf8");
    const used = [...wf.matchAll(/\$\{\{([^}]*)\}\}/g)].map((m) => m[1].trim());
    const allowed = [
      "github.workflow",
      "github.event.pull_request.number",
      "github.event.pull_request.base.sha",
      "github.event.pull_request.head.sha",
    ];
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((e) => !allowed.includes(e))).toEqual([]);
  });
});
