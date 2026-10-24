import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * plugins.lock.json ships in the PUBLIC core, so it may only ever name the
 * public plugins. This drives the real script with a private plugin checked
 * out beside a public one — the shape of a dev box that holds both — and pins
 * that the private one is never written, and that a lock already naming one
 * fails the check.
 */

const LOCK_MJS = join(process.cwd(), "scripts", "plugins", "lock.mjs");
const GIT = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

let root;
let wbHead;
let privateHead;

function git(cwd, ...args) {
  return execFileSync("git", [...GIT, "-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function plugin(slug) {
  const dir = join(root, "plugins", slug);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", dir], { stdio: "ignore" });
  // The slug in the message: identical empty commits would share one SHA.
  git(dir, "commit", "--allow-empty", "-m", `${slug} one`);
  return git(dir, "rev-parse", "HEAD");
}

const lockPath = () => join(root, "plugins.lock.json");
const writeLock = (plugins) => writeFileSync(lockPath(), `${JSON.stringify({ plugins }, null, 2)}\n`);
const readLock = () => JSON.parse(readFileSync(lockPath(), "utf8")).plugins;
const run = (...args) => spawnSync("node", [LOCK_MJS, ...args], { cwd: root, encoding: "utf8" });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lock-public-"));
  wbHead = plugin("whiteboard");
  privateHead = plugin("acme-private");
  expect(privateHead).not.toBe(wbHead);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("lock.mjs and private plugins", () => {
  it("--write pins the public checkout and NEVER the private one beside it", () => {
    writeLock({});
    const r = run("--write");

    expect(r.status, r.stderr).toBe(0);
    // Positive control: the public plugin really was discovered and written.
    expect(readLock()).toEqual({ whiteboard: { ref: wbHead } });
    expect(readFileSync(lockPath(), "utf8")).not.toContain("acme-private");
    expect(readFileSync(lockPath(), "utf8")).not.toContain(privateHead);
    expect(r.stdout).toContain("acme-private: not a public plugin — never locked");
  });

  it("--write drops a private slug an older lock already carried", () => {
    writeLock({ whiteboard: { ref: wbHead }, "acme-private": { ref: privateHead } });
    const r = run("--write");

    expect(r.status, r.stderr).toBe(0);
    expect(Object.keys(readLock())).toEqual(["whiteboard"]);
  });

  it("verify FAILS on a lock that names a private plugin", () => {
    writeLock({ whiteboard: { ref: wbHead }, "acme-private": { ref: privateHead } });
    const r = run();

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("acme-private: not a public plugin");
  });

  it("verify passes with the private checkout present but unlocked", () => {
    writeLock({ whiteboard: { ref: wbHead } });
    const r = run();

    expect(r.status, r.stderr).toBe(0);
  });
});
