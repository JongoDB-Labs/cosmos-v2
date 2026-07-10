// Foreman's ship module: glue around git/gh/the deploy scripts that turns a
// built, checks-passed branch into a running prod release. The flow is
// merge -> tag -> wait for the signed image (release.yml builds it) -> run
// the deploy script (which IS the health gate) -> on failure, rollback
// re-pins the prior compose override and redeploys. Every git/gh/docker call
// here shells out against the real REPO checkout — there is no dry-run mode;
// Task 12's orchestrator gates when these run for real.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const exec = promisify(execFile);
const REPO = "/home/defcon/cosmos-v2";

export function readVersion(dir: string): string {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
}

/** Squash-merge a fully-built branch into main and push. `git merge --squash`
 *  applies the diff and stages it into the index by itself — no working
 *  commit is created — so `commit --no-edit` commits exactly what the squash
 *  staged, with no `git add` step at all and certainly no `-A`. Assumes
 *  `branch` is already a clean, checks-passed commit. */
export async function mergeBranch(branch: string): Promise<void> {
  await exec("git", ["-C", REPO, "checkout", "main"]);
  await exec("git", ["-C", REPO, "merge", "--squash", branch]);
  await exec("git", ["-C", REPO, "commit", "--no-edit"]);
  await exec("git", ["-C", REPO, "push", "origin", "main"]);
}

/** Push the built branch to origin so a PR can open against it. `--force` because
 *  `auto/<KEY>` is reused across attempts (worktree `add -B` resets it), and Foreman
 *  is the only writer of `auto/*` branches. */
export async function pushBranch(branch: string): Promise<void> {
  await exec("git", ["-C", REPO, "push", "--force", "origin", branch]);
}

/** Open a PR for the built branch; returns its URL. `draft=true` leaves it for a
 *  human to review + merge (the risky path); `draft=false` is a PR Foreman will
 *  immediately auto-merge (the safe/delivery path) — so EVERY change gets a PR trail. */
export async function openPr(branch: string, title: string, body: string, draft: boolean): Promise<string> {
  const args = ["pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", body];
  if (draft) args.push("--draft");
  const { stdout } = await exec("gh", args, { cwd: REPO });
  // gh prints the created PR's URL on its own line.
  const url = stdout.trim().split(/\s+/).filter((t) => t.startsWith("https://")).pop();
  return url ?? stdout.trim();
}

/** Squash-merge an open (non-draft) PR into main, delete its branch, and hard-sync
 *  the local checkout to the merged commit so a subsequent `tagAndPush` tags exactly
 *  the shipped commit. Admin-merge bypasses required reviews (Foreman is the approver
 *  for its own auto-shipped, checks-passed changes). */
export async function mergePr(branch: string): Promise<void> {
  await exec("gh", ["pr", "merge", branch, "--squash", "--admin", "--delete-branch"], { cwd: REPO });
  await exec("git", ["-C", REPO, "checkout", "main"]);
  await exec("git", ["-C", REPO, "fetch", "origin", "main"]);
  await exec("git", ["-C", REPO, "reset", "--hard", "origin/main"]);
}

/** Tag the just-merged main at `vVERSION` and push the tag — this is what
 *  triggers release.yml's `push: tags: ["v*"]` build. */
export async function tagAndPush(version: string): Promise<void> {
  await exec("git", ["-C", REPO, "tag", `v${version}`]);
  await exec("git", ["-C", REPO, "push", "origin", `v${version}`]);
}

/**
 * Poll the release workflow for this version's tagged run until it
 * completes.
 *
 * Matches on BOTH `headBranch` (exact `v<version>`) and `displayTitle`
 * (substring), not `displayTitle` alone. Confirmed live against this repo's
 * actual release runs (`gh api repos/{owner}/{repo}/actions/runs/<id>`):
 * GitHub hard-truncates `display_title` to ~70 chars + "…", and for a
 * long commit subject that truncation lands INSIDE the trailing "(vX.Y.Z)" —
 * e.g. the real v2.154.0 release run's displayTitle is
 * `"feat(timeline): Gantt baseline slippage + Business/Enabler lenses (v2…"`,
 * so `.includes("2.154.0")` is false on it even though that run is the exact
 * one we're looking for. `headBranch` is the untruncated tag ref GitHub
 * reports for a tag-push-triggered run, so it's checked first; `displayTitle`
 * stays as a fallback for short subjects / any run shape where headBranch
 * doesn't come back as expected.
 */
export async function waitForImage(version: string, timeoutMs = 25 * 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { stdout } = await exec(
      "gh",
      ["run", "list", "--workflow=release.yml", "--limit", "5", "--json", "headBranch,status,conclusion,displayTitle"],
      { cwd: REPO },
    );
    const runs = JSON.parse(stdout) as Array<{
      headBranch: string;
      status: string;
      conclusion: string | null;
      displayTitle: string;
    }>;
    // Primary: the exact tag ref (untruncated, unambiguous). Only if no run
    // carries it do we fall back to the (truncatable, substring-collidable)
    // displayTitle — a true primary→fallback, not an OR that could return a
    // newer unrelated run whose title merely contains the version.
    const mine =
      runs.find((r) => r.headBranch === `v${version}`) ??
      runs.find((r) => r.displayTitle.includes(version));
    if (mine?.status === "completed") return mine.conclusion === "success";
    await new Promise((r) => setTimeout(r, 20_000));
  }
  return false;
}

/** Run the appropriate deploy script; its exit code IS the health-gate
 *  result (non-zero exit → rejected exec → caught below → false). Both
 *  scripts are provisioned into `.deploy/` separately at arm-time (they pin
 *  prod digests and are gitignored, not part of this task) — this only ever
 *  invokes them by path. */
export async function deploy(version: string, hasMigration: boolean): Promise<boolean> {
  const script = hasMigration ? ".deploy/deploy-migrate.sh" : ".deploy/deploy-apponly.sh";
  try {
    await exec("bash", [join(REPO, script), version], { cwd: REPO, maxBuffer: 32 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

/** Roll back the release we JUST deployed — takes the version just shipped, NOT a
 *  `prevVersion` derived from Foreman's ledger (which is empty on the very first
 *  ship and can carry a stale digest). The deploy scripts snapshot
 *  `docker-compose.override.yml` to `.bak-<version>` (bare SemVer, no `v` prefix —
 *  matches `readVersion`'s output) at the START of deploying `<version>`, so
 *  `.bak-<version>` IS the exact pre-deploy override — the state to roll back TO.
 *  Copy it back over the live override and re-up the two services whose
 *  images/digests it pins. If the snapshot is missing (e.g. the deploy died before
 *  taking it), log and skip rather than throw — the caller still gates the ticket
 *  and counts the circuit breaker regardless. */
export async function rollback(version: string): Promise<void> {
  const bak = join(REPO, `docker-compose.override.yml.bak-${version}`);
  if (!existsSync(bak)) {
    process.stdout.write(
      `${new Date().toISOString()} rollback: no ${bak} snapshot — cannot restore pre-deploy override; skipping\n`,
    );
    return;
  }
  await exec("cp", [bak, join(REPO, "docker-compose.override.yml")], { cwd: REPO });
  await exec("sudo", ["docker", "compose", "up", "-d", "cosmos", "reverse-proxy"], {
    cwd: REPO,
    maxBuffer: 32 * 1024 * 1024,
  });
}
