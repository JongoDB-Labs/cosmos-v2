// Foreman's checks runner: the gate between "agent finished" and "safe to
// ship". Runs the same checks CI would (tsc / eslint on changed files /
// vitest) inside the ticket's worktree, plus a numstat diff summary the risk
// classifier (src/lib/foreman/risk.ts) uses to decide auto-ship vs. gate.
import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";
import type { DiffSummary } from "@/lib/foreman/risk";

const exec = promisify(execFile);

async function run(cmd: string, args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await exec(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024 });
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
    .filter((f) => /\.(ts|tsx)$/.test(f));
  const lint = changed.length ? await run("npx", ["eslint", ...changed], dir) : { ok: true, out: "" };
  const vitest = await run("npx", ["vitest", "run"], dir);
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
