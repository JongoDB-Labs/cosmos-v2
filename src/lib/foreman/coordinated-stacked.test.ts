// End-to-end GIT-MECHANICS verification of the stacked coordinated-release core
// (#1), the risky new logic in scripts/foreman/run.mts's shipCoordinatedBatch and
// the stacked build base. Hermetic: builds a disposable git repo in a temp dir and
// exercises the real `git` the daemon runs — NO Postgres, GitHub, or ship pipeline
// (those have prod side effects). The daemon's DECISIONS live in the pure cores
// (release-gate / intent / decompose / ship-rebase) and are unit-tested separately;
// this proves the git-level invariants those decisions rely on:
//   (1) two phases editing the SAME file, built STACKED, merge onto main as one
//       conflict-free step with BOTH edits present (the same-file autonomy fix);
//   (2) stack integrity holds (predecessor tip is an ancestor of successor tip);
//   (3) a real stack-vs-main drift on the shared file IS detected as a conflict
//       (→ the daemon routes it to the gated AI fallback, never a silent ship).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

let repo: string;
const git = (args: string[], cwd = repo) => exec("git", ["-C", cwd, ...args]);
const board = (l2: string, l3: string) => `line1\n${l2}\n${l3}\nline4\n`;

async function isAncestor(a: string, b: string): Promise<boolean> {
  return git(["merge-base", "--is-ancestor", a, b]).then(() => true).catch(() => false);
}
async function mergeConflicts(branch: string): Promise<string[]> {
  try {
    await git(["merge", "--no-edit", branch]);
    return [];
  } catch {
    const { stdout } = await git(["diff", "--name-only", "--diff-filter=U"]);
    await git(["merge", "--abort"]).catch(() => undefined);
    return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  }
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "coord-stacked-"));
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "t@t.t"]);
  await git(["config", "user.name", "t"]);
  const file = join(repo, "sprint-board.tsx");
  writeFileSync(file, board("line2", "line3"));
  await git(["add", "-A"]);
  await git(["commit", "-qm", "main: sprint-board"]);

  // Phase 1 off main — edits line2 of the SHARED file.
  await git(["checkout", "-q", "-b", "auto/COSMOS-P1", "main"]);
  writeFileSync(file, board("line2-phaseA", "line3"));
  await git(["commit", "-aqm", "phase1: featureA"]);

  // Phase 2 STACKED off phase 1 — edits line3 of the SAME shared file.
  await git(["checkout", "-q", "-b", "auto/COSMOS-P2", "auto/COSMOS-P1"]);
  writeFileSync(file, board("line2-phaseA", "line3-phaseB"));
  await git(["commit", "-aqm", "phase2: featureB"]);
  await git(["checkout", "-q", "main"]);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("stacked coordinated release — git mechanics (#1)", () => {
  it("(1) the tip phase branch already contains BOTH same-file edits", async () => {
    const { stdout } = await git(["show", "auto/COSMOS-P2:sprint-board.tsx"]);
    expect(stdout).toContain("line2-phaseA");
    expect(stdout).toContain("line3-phaseB");
  });

  it("(2) stack integrity holds — phase1 tip is an ancestor of phase2 tip", async () => {
    expect(await isAncestor("auto/COSMOS-P1", "auto/COSMOS-P2")).toBe(true);
  });

  it("(1) merging the TIP onto unchanged main is conflict-free and lands both edits", async () => {
    await git(["checkout", "-q", "-B", "integ", "main"]);
    const conflicts = await mergeConflicts("auto/COSMOS-P2");
    expect(conflicts).toEqual([]); // no abort — same-file phases ship as one
    const { stdout } = await git(["show", "integ:sprint-board.tsx"]);
    expect(stdout).toContain("line2-phaseA");
    expect(stdout).toContain("line3-phaseB");
    await git(["checkout", "-q", "main"]);
  });

  it("(3) a real stack-vs-main drift on the shared file IS detected as a conflict", async () => {
    // main advances with an OVERLAPPING edit to the same line phase1 changed.
    await git(["checkout", "-q", "-B", "main-drift", "main"]);
    writeFileSync(join(repo, "sprint-board.tsx"), board("line2-mainDrift", "line3"));
    await git(["commit", "-aqm", "main: drift on line2"]);
    const conflicts = await mergeConflicts("auto/COSMOS-P2");
    expect(conflicts).toContain("sprint-board.tsx"); // → routes to the gated AI fallback
    await git(["checkout", "-q", "main"]);
  });

  it("(4) merging the stack tip from a LINKED WORKTREE uses a SHA, not FETCH_HEAD", async () => {
    // Regression for the prod bug: shipCoordinatedBatch merges in a linked worktree
    // `wt`, but the tip was fetched into REPO, so `git -C wt merge FETCH_HEAD` reads
    // the worktree's OWN (absent) FETCH_HEAD and dies with "could not open ...
    // FETCH_HEAD". The fix resolves the tip to a SHA in REPO (worktrees share the
    // object store) and merges THAT.
    const wt = mkdtempSync(join(tmpdir(), "coord-wt-"));
    try {
      await git(["worktree", "add", "-q", "-B", "integ-wt", wt, "main"]);
      const tipSha = (await git(["rev-parse", "auto/COSMOS-P2"])).stdout.trim();
      // OLD path — merge FETCH_HEAD in the worktree — fails (no FETCH_HEAD there).
      await expect(git(["merge", "--no-edit", "FETCH_HEAD"], wt)).rejects.toThrow();
      // FIX — merge the SHA — composes both same-file edits.
      await git(["merge", "--no-edit", tipSha], wt);
      const { stdout } = await git(["show", "integ-wt:sprint-board.tsx"], wt);
      expect(stdout).toContain("line2-phaseA");
      expect(stdout).toContain("line3-phaseB");
    } finally {
      await git(["worktree", "remove", "--force", wt]).catch(() => undefined);
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
