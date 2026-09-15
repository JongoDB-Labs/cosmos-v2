import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The rule, exercised through the real script against real git repositories.
 *
 * lock-direction.test.mjs pins the DECISION. This pins that lock.mjs actually
 * asks — that the verdict is computed from the checkout on disk, that a refusal
 * exits non-zero, and above all that the lockfile is left UNTOUCHED when it
 * does. A pure rule nothing calls is the failure mode this file exists to rule
 * out; so is a guard that reports a problem and writes the bad file anyway.
 */

const LOCK_MJS = join(process.cwd(), "scripts", "plugins", "lock.mjs");

/** Deterministic commits: no signing, no ambient identity, no ambient config. */
const GIT = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

let root; // a throwaway "core" checkout
let first; // commit 1 in plugins/alpha
let second; // commit 2, a descendant of first

function git(cwd, ...args) {
  return execFileSync("git", [...GIT, "-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function writeLock(ref) {
  writeFileSync(join(root, "plugins.lock.json"), `${JSON.stringify({ plugins: { alpha: { ref } } }, null, 2)}\n`);
}

function readLockRef() {
  return JSON.parse(readFileSync(join(root, "plugins.lock.json"), "utf8")).plugins.alpha.ref;
}

function runLock(...extraArgs) {
  return spawnSync("node", [LOCK_MJS, "--write", ...extraArgs], {
    cwd: root,
    encoding: "utf8",
  });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lock-direction-"));
  const plugin = join(root, "plugins", "alpha");
  mkdirSync(plugin, { recursive: true });

  execFileSync("git", ["-c", "init.defaultBranch=main", "init", plugin], { stdio: "ignore" });
  git(plugin, "commit", "--allow-empty", "-m", "one");
  first = git(plugin, "rev-parse", "HEAD");
  git(plugin, "commit", "--allow-empty", "-m", "two");
  second = git(plugin, "rev-parse", "HEAD");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("lock.mjs --write", () => {
  it("advances a pin to a descendant, and says so", () => {
    // POSITIVE CONTROL. Without this, every refusal below could be the script
    // failing for some unrelated reason and the test would not notice.
    writeLock(first);
    git(join(root, "plugins", "alpha"), "checkout", "-q", second);

    const r = runLock();
    expect(r.status, r.stderr).toBe(0);
    expect(readLockRef()).toBe(second);
    expect(r.stdout).toContain(`${first.slice(0, 9)} → ${second.slice(0, 9)}`);
  });

  it("REFUSES to roll a pin back, and leaves the lockfile untouched", () => {
    // The stale-checkout case: the lock is ahead, the checkout is behind.
    writeLock(second);
    git(join(root, "plugins", "alpha"), "checkout", "-q", first);
    const before = readFileSync(join(root, "plugins.lock.json"), "utf8");

    const r = runLock();

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ROLLS THE PIN BACK");
    expect(r.stderr).toContain("NOT written");
    // The part that matters: refusing has to mean refusing. Reporting the
    // problem and writing the file anyway would be worse than silence, because
    // the message makes it look handled.
    expect(readFileSync(join(root, "plugins.lock.json"), "utf8")).toBe(before);
    expect(readLockRef()).toBe(second);
  });

  it("writes the rollback when --allow-rollback is passed", () => {
    // The escape hatch has to work, or the guard turns a deliberate revert into
    // an unsolvable problem and someone edits the lockfile by hand instead.
    writeLock(second);
    git(join(root, "plugins", "alpha"), "checkout", "-q", first);

    const r = runLock("--allow-rollback");

    expect(r.status, r.stderr).toBe(0);
    expect(readLockRef()).toBe(first);
    expect(r.stderr).toContain("--allow-rollback: writing anyway");
  });

  it("REFUSES when the checkout does not contain the pin it would replace", () => {
    // A pin from a repository this checkout has never seen — the shape of a
    // clone made before the current pin existed. git cannot compare them, and
    // "cannot compare" must not resolve to "go ahead".
    writeLock("0".repeat(40));
    git(join(root, "plugins", "alpha"), "checkout", "-q", second);

    const r = runLock();

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("cannot verify");
    expect(readLockRef()).toBe("0".repeat(40));
  });
});
