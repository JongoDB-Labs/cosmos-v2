// Foreman's checks runner: the gate between "agent finished" and "safe to
// ship". Runs the same checks CI would (tsc / eslint on changed files /
// vitest) inside the ticket's worktree, plus a numstat diff summary the risk
// classifier (src/lib/foreman/risk.ts) uses to decide auto-ship vs. gate.
import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";
import type { DiffSummary } from "@/lib/foreman/risk";
import { testDatabaseUrl } from "@/lib/foreman/test-db";
import { checkEnv } from "@/lib/foreman/env";

const exec = promisify(execFile);

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      env: checkEnv(extraEnv),
    });
    return { ok: true, out: stdout + stderr };
  } catch (e) {
    const err = e as ExecFileException;
    return { ok: false, out: (err.stdout ?? "") + (err.stderr ?? "") + String(err.message ?? "") };
  }
}

/** tsc + eslint(changed files) + vitest, in the worktree. Any failure → ok:false.
 *  "Changed" is measured against origin/main so this only lints what the ticket
 *  actually touched, not the whole tree. */
export async function runChecks(dir: string): Promise<{ ok: boolean; log: string }> {
  const tsc = await run("npx", ["tsc", "--noEmit"], dir);
  const changed = (await exec("git", ["diff", "--name-only", "origin/main...HEAD"], { cwd: dir })).stdout
    .split("\n")
    .filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));
  const lint = changed.length ? await run("npx", ["eslint", ...changed], dir) : { ok: true, out: "" };
  // The default vitest suite includes DB-integration tests (ingest/files/…) that
  // read seeded fixtures. Point them at the e2e TEST database, never the daemon's
  // live DATABASE_URL — otherwise every ticket gates on `test-org`-not-found and,
  // worse, the integration tests would run against prod. testDatabaseUrl() throws
  // if the test URL ever resolves to the live one.
  // The vitest suite is heavy (DB fixtures + ML libs) and occasionally flakes under
  // the daemon's concurrent load — a false failure would gate a good change. Retry
  // ONCE on failure: a transient flake passes the second time, a real failure fails
  // twice. tsc/eslint are fast + deterministic, so they aren't retried.
  let vitest = await run("npx", ["vitest", "run"], dir, { DATABASE_URL: testDatabaseUrl() });
  if (!vitest.ok) {
    const retry = await run("npx", ["vitest", "run"], dir, { DATABASE_URL: testDatabaseUrl() });
    vitest = retry.ok
      ? { ok: true, out: vitest.out + "\n--- vitest RETRY (first run flaked) ---\n" + retry.out }
      : { ok: false, out: vitest.out + "\n--- vitest RETRY (still failing) ---\n" + retry.out };
  }
  const ok = tsc.ok && lint.ok && vitest.ok;
  return { ok, log: [tsc, lint, vitest].map((r) => r.out).join("\n---\n") };
}

/** Files + line counts changed vs. base, for the risk classifier. */
export async function diffSummary(dir: string, base = "origin/main"): Promise<DiffSummary> {
  const { stdout } = await exec("git", ["diff", "--numstat", `${base}...HEAD`], { cwd: dir });
  const files: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    files.push(m[3]);
    additions += m[1] === "-" ? 0 : Number(m[1]);
    deletions += m[2] === "-" ? 0 : Number(m[2]);
  }
  return { files, additions, deletions };
}
