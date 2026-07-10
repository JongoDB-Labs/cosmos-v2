// Foreman's agent runner: spawns headless Claude Code (`claude -p`) inside a
// worktree to implement one ticket. Hard-gated to the Max subscription — see
// assertSubscription() — so metered API billing is structurally impossible,
// not just discouraged by convention.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildAgentEnv } from "@/lib/foreman/env";

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
/** Env vars that route `claude` to a METERED or cloud-billed path instead of the
 *  flat subscription — any of them present is a hard refuse. */
const METERED_ENV = [
  "ANTHROPIC_API_KEY", // pay-per-token API key
  "ANTHROPIC_AUTH_TOKEN", // bearer token → non-subscription API path
  "CLAUDE_CODE_USE_BEDROCK", // routes to AWS Bedrock (metered)
  "CLAUDE_CODE_USE_VERTEX", // routes to GCP Vertex (metered)
] as const;

export function assertSubscription(env: NodeJS.ProcessEnv): void {
  for (const v of METERED_ENV) {
    if (env[v]) {
      throw new Error(`${v} is set — refusing (routes to metered/cloud billing). Unset it.`);
    }
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
 *  though it's absent from `claude --help`'s listed options (verified live).
 *
 *  `opts.allowedTools` / `opts.permissionMode` let a caller narrow the agent's
 *  powers: the build agent keeps the full toolset in its own worktree, but the
 *  dedup/clarity judges pass a read-only `"Read,Grep,Glob"` (no Edit/Write/Bash)
 *  so a prompt-injected ticket can't get a shell or write the repo. */
export function runAgent(
  worktreeDir: string,
  prompt: string,
  opts: {
    maxTurns?: number;
    timeoutMs?: number;
    allowedTools?: string;
    permissionMode?: string;
  } = {},
): Promise<{ ok: boolean; log: string }> {
  const env = buildAgentEnv(process.env);
  assertSubscription(env);

  const args = [
    "-p", prompt,
    "--model", "opus",
    "--permission-mode", opts.permissionMode ?? "acceptEdits",
    "--allowedTools", opts.allowedTools ?? "Read,Grep,Glob,Edit,Write,Bash",
    "--max-turns", String(opts.maxTurns ?? 80),
  ];

  return new Promise((resolve) => {
    // detached:true makes the child its own process-group leader (pgid === pid),
    // so a timeout can signal the WHOLE group via `-pid` — a `claude` that traps
    // SIGTERM, or any grandchild it spawned, can't survive and wedge the daemon
    // while it still holds the lock.
    const child = spawn("claude", args, { cwd: worktreeDir, env, detached: true });
    let log = "";
    let killTimer: NodeJS.Timeout | undefined;
    const signalGroup = (signal: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid) {
        try {
          process.kill(-pid, signal); // negative pid → whole process group
          return;
        } catch {
          /* group already gone (or unsupported) — fall back to the child alone */
        }
      }
      try {
        child.kill(signal);
      } catch {
        /* already dead */
      }
    };
    const timer = setTimeout(() => {
      // Graceful first, then hard-kill the group after a short grace so a trapping
      // `claude` still dies and 'close' fires — the promise always resolves.
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), 10_000);
    }, opts.timeoutMs ?? 45 * 60_000);
    const clearTimers = (): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("close", (code) => {
      clearTimers();
      resolve({ ok: code === 0, log });
    });
    child.on("error", (e) => {
      clearTimers();
      resolve({ ok: false, log: log + "\n" + String(e) });
    });
  });
}
