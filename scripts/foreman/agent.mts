// Foreman's agent runner: spawns headless Claude Code (`claude -p`) inside a
// worktree to implement one ticket. Hard-gated to the Max subscription — see
// assertSubscription() — so metered API billing is structurally impossible,
// not just discouraged by convention.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Shape of ~/.claude/.credentials.json we care about. `expiresAt` is a Unix
 *  epoch in MILLISECONDS (confirmed against a live credentials file — it lines
 *  up with Date.now(), not Date.now()/1000), so the raw `<` comparison below is
 *  unit-correct as-is. */
interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

/** Refuse to run on anything but the Max subscription — metered API billing
 *  must be impossible. Throws if: `env.ANTHROPIC_API_KEY` is set (would meter);
 *  `~/.claude/.credentials.json` is missing; it has no `claudeAiOauth.accessToken`
 *  (not a subscription login); or the token is expired with no refresh token to
 *  renew it (the CLI refreshes a live token on use, so an expired-but-refreshable
 *  token is fine — only a dead end is fatal). */
export function assertSubscription(env: NodeJS.ProcessEnv): void {
  if (env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is set — refusing (would meter). Unset it.");
  }
  const credPath = join(homedir(), ".claude", ".credentials.json");
  if (!existsSync(credPath)) {
    throw new Error("no ~/.claude credentials — run `claude` login first");
  }
  const cred = JSON.parse(readFileSync(credPath, "utf8")) as ClaudeCredentials;
  const oauth = cred.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error("no claudeAiOauth token — not a subscription login");
  }
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) {
    if (!oauth.refreshToken) throw new Error("subscription token expired and no refresh token");
  }
}

/** Run Claude Code headless in `worktreeDir` on the subscription. Resolves
 *  (never rejects) `ok:false` on non-zero exit, a timeout kill, or a spawn
 *  error — the orchestrator treats any of those as "gate to review", not a
 *  crash. `--max-turns` is a real, working flag on the root `-p` command even
 *  though it's absent from `claude --help`'s listed options (verified live). */
export function runAgent(
  worktreeDir: string,
  prompt: string,
  opts: { maxTurns?: number; timeoutMs?: number } = {},
): Promise<{ ok: boolean; log: string }> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // belt-and-suspenders: never meter, even if the caller's env had one
  assertSubscription(env);

  const args = [
    "-p", prompt,
    "--model", "opus",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read,Grep,Glob,Edit,Write,Bash",
    "--max-turns", String(opts.maxTurns ?? 80),
  ];

  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: worktreeDir, env });
    let log = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, opts.timeoutMs ?? 45 * 60_000);
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, log });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, log: log + "\n" + String(e) });
    });
  });
}
