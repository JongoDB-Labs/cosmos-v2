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
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
// Repo root derived from this module's location (scripts/foreman/ship.mts →
// ../..) so the daemon is portable across hosts/users (was hardcoded).
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readVersion(dir: string): string {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
}

/** The audit identity of a built branch's HEAD: its short commit SHA and subject
 *  line. Recorded on the ticket so a human (or Claude) can `git checkout` exactly
 *  what was built to rework it, and read a one-line summary of the change without
 *  opening the diff. Best-effort — a git hiccup yields empty strings, never throws. */
export async function headInfo(dir: string): Promise<{ commit: string; subject: string }> {
  try {
    const commit = (await exec("git", ["-C", dir, "rev-parse", "--short", "HEAD"])).stdout.trim();
    const subject = (await exec("git", ["-C", dir, "log", "-1", "--format=%s"])).stdout.trim();
    return { commit, subject };
  } catch {
    return { commit: "", subject: "" };
  }
}

/** The version prod is serving RIGHT NOW, read from the internal health endpoint —
 *  captured just before a deploy so the audit trail can name the exact rollback
 *  target (`deploy-apponly.sh <thisVersion>` restores it). Null if unreachable, in
 *  which case the audit falls back to "the prior release". */
export async function currentProdVersion(): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch("http://127.0.0.1:8090/api/health", { signal: ctrl.signal });
    clearTimeout(t);
    const body = (await res.json()) as { version?: string };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
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

/** Squash-merge an open (non-draft) PR into main and hard-sync the local checkout
 *  to the merged commit so a subsequent `tagAndPush` tags exactly the shipped
 *  commit. Admin-merge bypasses required reviews (Foreman is the approver for its
 *  own auto-shipped, checks-passed changes).
 *
 *  NO `--delete-branch`: the local `auto/<KEY>` branch is checked out in the
 *  ticket's live worktree, so gh's local-delete step fails ("cannot delete branch
 *  … used by worktree") AFTER the GitHub merge succeeded — a non-zero exit that
 *  made every safe ship look failed and detour through review→reconcile (observed
 *  on COSMOS-23/62/65). Instead, delete only the REMOTE branch via the API
 *  (best-effort — pure hygiene, and it can never touch the worktree); the local
 *  branch is reset by the next `worktree add -B` anyway. */
export async function mergePr(branch: string): Promise<void> {
  await exec("gh", ["pr", "merge", branch, "--squash", "--admin"], { cwd: REPO });
  await exec("git", ["-C", REPO, "checkout", "main"]);
  await exec("git", ["-C", REPO, "fetch", "origin", "main"]);
  await exec("git", ["-C", REPO, "reset", "--hard", "origin/main"]);
  await exec(
    "gh",
    ["api", "-X", "DELETE", `repos/{owner}/{repo}/git/refs/heads/${branch}`],
    { cwd: REPO },
  ).catch(() => undefined);
}

/** Tag the just-merged main at `vVERSION` and push the tag — this is what
 *  triggers release.yml's `push: tags: ["v*"]` build. */
export async function tagAndPush(version: string): Promise<void> {
  await exec("git", ["-C", REPO, "tag", `v${version}`]);
  await exec("git", ["-C", REPO, "push", "origin", `v${version}`]);
}

/** One release-workflow run as reported by `gh run list --json`. */
export interface ReleaseRun {
  headBranch: string;
  status: string;
  conclusion: string | null;
  displayTitle: string;
}

/**
 * Pick THIS version's release run out of the recent list.
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
export function selectReleaseRun(runs: ReleaseRun[], version: string): ReleaseRun | undefined {
  // Primary: the exact tag ref (untruncated, unambiguous). Only if no run
  // carries it do we fall back to the (truncatable, substring-collidable)
  // displayTitle — a true primary→fallback, not an OR that could return a
  // newer unrelated run whose title merely contains the version.
  return (
    runs.find((r) => r.headBranch === `v${version}`) ??
    runs.find((r) => r.displayTitle.includes(version))
  );
}

/**
 * The deploy gate keys on the IMAGE, not on the whole release run's conclusion.
 *
 * release.yml builds + signs the app image in its `build`/`merge` jobs, then a
 * NON-ESSENTIAL downstream `chart` job publishes the Helm OCI artifact. If only
 * the chart job fails, the run reports `failure` even though the app image is
 * built, pushed, and cosign-signed in GHCR. Keying the gate on the run
 * conclusion (the old bug) treated that image as "not ready" and retried the
 * deploy forever. So:
 *
 *   - a signed image present in GHCR ⇒ `ready` (deploy it, whatever the run said),
 *   - else a completed+`success` run ⇒ `ready` (the merge job's verify-after-sign
 *     gate guarantees the image is present+signed on success, no registry hit),
 *   - else a completed run without a signed image ⇒ `not-ready` (a genuine
 *     build/sign failure — nothing deployable was produced),
 *   - else ⇒ `pending` (still building; keep polling).
 */
export function imageGate(
  run: ReleaseRun | undefined,
  imageSigned: boolean,
): "ready" | "not-ready" | "pending" {
  if (imageSigned) return "ready";
  if (!run || run.status !== "completed") return "pending";
  return run.conclusion === "success" ? "ready" : "not-ready";
}

/** `owner/repo` for the checkout (e.g. `JongoDB-Labs/cosmos-v2`), via gh. */
async function repoSlug(): Promise<string> {
  const { stdout } = await exec("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
    cwd: REPO,
  });
  return stdout.trim();
}

/**
 * True iff the app image for `version` is present in GHCR AND carries a
 * verifiable keyless (OIDC → Fulcio/Rekor) cosign signature — the exact
 * contract release.yml's own "Verify signatures landed" gate enforces. `cosign
 * verify` exits non-zero when the tag is absent OR unsigned, so a single call
 * answers "built + signed?" and any failure (including cosign not installed)
 * degrades to `false` — never throws, never falsely reports ready.
 */
export async function imageSignedInGhcr(version: string): Promise<boolean> {
  try {
    const slug = await repoSlug(); // JongoDB-Labs/cosmos-v2
    const owner = slug.split("/")[0].toLowerCase(); // GHCR repo names are lowercase
    const image = `ghcr.io/${owner}/cosmos-v2:${version}`;
    await exec(
      "cosign",
      [
        "verify",
        "--certificate-identity-regexp",
        `^https://github.com/${slug}/`,
        "--certificate-oidc-issuer",
        "https://token.actions.githubusercontent.com",
        image,
      ],
      { cwd: REPO },
    );
    return true;
  } catch {
    return false;
  }
}

/** Injectable I/O for {@link waitForImage} so the gate logic is unit-testable
 *  without shelling out to `gh`/`cosign`. Defaults hit the real tools. */
export interface WaitForImageDeps {
  listReleaseRuns: () => Promise<ReleaseRun[]>;
  imageSignedInGhcr: (version: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultWaitDeps: WaitForImageDeps = {
  listReleaseRuns: async () => {
    const { stdout } = await exec(
      "gh",
      ["run", "list", "--workflow=release.yml", "--limit", "5", "--json", "headBranch,status,conclusion,displayTitle"],
      { cwd: REPO },
    );
    return JSON.parse(stdout) as ReleaseRun[];
  },
  imageSignedInGhcr,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

/**
 * Poll release.yml until this version's app image is deployable, gating on the
 * signed IMAGE (see {@link imageGate}) rather than the run conclusion — so a
 * failed non-essential job (e.g. the Helm chart-publish) can't block a deploy
 * of an image that actually built + got signed. Returns `false` only on a real
 * build/sign failure or timeout.
 */
export async function waitForImage(
  version: string,
  timeoutMs = 25 * 60_000,
  deps: WaitForImageDeps = defaultWaitDeps,
): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    const run = selectReleaseRun(await deps.listReleaseRuns(), version);
    // Only hit the registry when the run has finished WITHOUT a green
    // conclusion — the happy path (success) needs no extra call, and a
    // still-running build is simply `pending`.
    const needRegistry = run?.status === "completed" && run.conclusion !== "success";
    const imageSigned = needRegistry ? await deps.imageSignedInGhcr(version) : false;
    const verdict = imageGate(run, imageSigned);
    if (verdict === "ready") {
      if (needRegistry && imageSigned) {
        // Surfaced-but-non-blocking: the run failed, yet the signed image is
        // present — an unrelated downstream job (chart-publish) failed. Deploy.
        console.warn(
          `[foreman] release run for v${version} concluded '${run?.conclusion}' but the signed app image is present in GHCR — deploying it; the failed non-essential job (e.g. Helm chart-publish) does not gate the app deploy.`,
        );
      }
      return true;
    }
    if (verdict === "not-ready") return false;
    await deps.sleep(20_000); // pending — keep polling
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
