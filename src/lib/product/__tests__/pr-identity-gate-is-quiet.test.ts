// The PR identity gate must not publish what it catches.
//
// cosmos-v2 is public, and so are its Actions logs and annotations. The gate
// used to print the matched term in both, and its workflow passed the PR body
// in as env, which every step prints in its log header. So each catch
// republished the name it was there to keep out, in a log that outlives the
// author's fix to the PR. In CI it now says where, never what. Run locally,
// it still shows the term.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORBIDDEN } from "../../../../scripts/client-identity.mjs";

// A real forbidden term, taken from the decoded pattern at run time so this
// file never contains one.
const term = FORBIDDEN.source
  .split("|")
  .map((alt) => alt.replace(/\\b/g, ""))
  .find((alt) => /^[A-Za-z0-9-]+$/.test(alt) && FORBIDDEN.test(alt))!;

const gate = (env: Record<string, string>) => {
  const r = spawnSync("node", ["scripts/check-pr-identity.mjs"], {
    env: { PATH: process.env.PATH, ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout + r.stderr };
};
const inCi = (pr: { title: string; body: string }) => {
  const path = join(mkdtempSync(join(tmpdir(), "pr-identity-")), "event.json");
  writeFileSync(path, JSON.stringify({ pull_request: pr }));
  return gate({ GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: path });
};

describe("the PR identity gate", () => {
  it("has a term to test with", () => {
    expect(term).toBeTruthy();
  });

  it("fails in CI, saying where the term is but never what it is", () => {
    const r = inCi({ title: "fix: a thing", body: `Intro.\n\nSee ${term} for details.` });
    expect(r.status).toBe(1);
    expect(r.out).toContain("PR body, line 3");
    expect(FORBIDDEN.test(r.out), "the log names the term it caught").toBe(false);
  });

  it("reads the title and body from the event payload in CI", () => {
    const r = inCi({ title: `fix: ${term}`, body: "" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("PR title, line 1");
    expect(FORBIDDEN.test(r.out)).toBe(false);
  });

  it("fails closed when the event carries no pull request", () => {
    // Scanning an empty title and body would pass anything.
    const path = join(mkdtempSync(join(tmpdir(), "pr-identity-")), "event.json");
    writeFileSync(path, JSON.stringify({ push: {} }));
    const r = gate({ GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: path });
    expect(r.status).toBe(1);
    expect(r.out).toContain("no pull request");
  });

  it("passes a clean pull request", () => {
    expect(inCi({ title: "fix: a thing", body: "Nothing to see." }).status).toBe(0);
  });

  it("shows the term when run locally, where the output is private", () => {
    const r = gate({ PR_TITLE: "fix: a thing", PR_BODY: `See ${term}.` });
    expect(r.status).toBe(1);
    expect(r.out).toContain(term);
  });

  it("is not handed the title or body as env, which the log header prints", () => {
    const wf = readFileSync(".github/workflows/pr-identity.yml", "utf8");
    expect(wf).not.toMatch(/github\.event\.pull_request\.(title|body)/);
  });
});
