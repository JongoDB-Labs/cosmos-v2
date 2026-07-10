// Foreman's agent runner, on the Claude Agent SDK: runs the coding agent (and the
// read-only judges/reviewer) inside a worktree. Hard-gated to the Max subscription
// — see assertSubscription() — so metered API billing is structurally impossible,
// not just discouraged by convention. Verified empirically: the SDK authenticates
// via ~/.claude/.credentials.json (subscription OAuth) when no API key is present,
// and fails "Not logged in" without those creds — same auth source as `claude -p`.
// The SDK also bundles its own Claude Code runtime, so daemon behavior no longer
// changes when the interactive `claude` binary upgrades.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
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

/** Env vars that route the agent to a METERED or cloud-billed path instead of the
 *  flat subscription — any of them present is a hard refuse. */
const METERED_ENV = [
  "ANTHROPIC_API_KEY", // pay-per-token API key
  "ANTHROPIC_AUTH_TOKEN", // bearer token → non-subscription API path
  "CLAUDE_CODE_USE_BEDROCK", // routes to AWS Bedrock (metered)
  "CLAUDE_CODE_USE_VERTEX", // routes to GCP Vertex (metered)
] as const;

/** Refuse to run on anything but the Max subscription — metered API billing
 *  must be impossible. Throws if: a metered/cloud var is in the (allowlisted)
 *  child env; `~/.claude/.credentials.json` is missing; it has no
 *  `claudeAiOauth.accessToken` (not a subscription login); or the token is
 *  expired with no refresh token to renew it (the runtime refreshes a live
 *  token on use, so expired-but-refreshable is fine — only a dead end is fatal). */
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

export interface AgentResult {
  ok: boolean;
  log: string;
  /** SDK session id — pass back as `opts.resume` to continue THIS agent's
   *  conversation (the repair loop uses it so the agent keeps its own context). */
  sessionId: string | null;
}

/** Run an agent turn in `worktreeDir` on the subscription. Resolves (never
 *  rejects) `ok:false` on an error result, a timeout, or an SDK/spawn error —
 *  the orchestrator treats any of those as "gate to review", not a crash.
 *
 *  `opts.allowedTools` / `opts.permissionMode` narrow the agent's powers: the
 *  build agent keeps the full toolset in its own worktree, but the dedup/clarity
 *  judges and the pre-ship reviewer pass a read-only `"Read,Grep,Glob"` (no
 *  Edit/Write/Bash) so a prompt-injected ticket can't get a shell or write the
 *  repo. `opts.resume` continues a prior session (same context) — the repair
 *  loop resumes the build agent with the failing check output.
 *
 *  The child env is ALLOWLISTED via buildAgentEnv (PATH/HOME/TERM/locale +
 *  NODE_ENV=test + the e2e DATABASE_URL — never GH tokens, the live DB URL, or
 *  billing vars); the feasibility test's empty-HOME run proved the SDK's `env`
 *  option REPLACES the child env rather than merging, so the allowlist is
 *  authoritative. Filesystem settings are NOT loaded (SDK default) — the agent
 *  sees only its prompt, the worktree, and the tools listed here. */
export function runAgent(
  worktreeDir: string,
  prompt: string,
  opts: {
    maxTurns?: number;
    timeoutMs?: number;
    allowedTools?: string;
    permissionMode?: string;
    resume?: string;
  } = {},
): Promise<AgentResult> {
  const env = buildAgentEnv(process.env);
  assertSubscription(env);

  return (async (): Promise<AgentResult> => {
    let log = "";
    let sessionId: string | null = null;
    let ok = false;
    // Timeout via AbortController: the SDK tears down its subprocess on abort, so
    // a wedged agent can't hold the daemon (the old spawn path needed process-group
    // SIGKILL gymnastics for this; abort is the SDK-native equivalent).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 45 * 60_000);
    try {
      const q = query({
        prompt,
        options: {
          cwd: worktreeDir,
          model: "opus",
          maxTurns: opts.maxTurns ?? 80,
          permissionMode: (opts.permissionMode ?? "acceptEdits") as "acceptEdits",
          allowedTools: (opts.allowedTools ?? "Read,Grep,Glob,Edit,Write,Bash").split(","),
          env,
          abortController: ctrl,
          ...(opts.resume ? { resume: opts.resume } : {}),
        },
      });
      for await (const msg of q) {
        if ("session_id" in msg && typeof msg.session_id === "string") sessionId = msg.session_id;
        // Accumulate assistant text so verdict parsers ("DUP …" / "APPROVE: …")
        // and audit log-tails see the full transcript, last line winning.
        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text") log += block.text + "\n";
          }
        } else if (msg.type === "result") {
          ok = msg.subtype === "success";
          if (msg.subtype === "success") log += msg.result + "\n";
          else log += `\n[agent result: ${msg.subtype}]\n`;
        }
      }
    } catch (e) {
      // SDK throws on some error results and on abort — both are "gate", never a crash.
      ok = false;
      log += `\n${ctrl.signal.aborted ? "[agent timeout — aborted]" : String(e)}\n`;
    } finally {
      clearTimeout(timer);
    }
    return { ok, log, sessionId };
  })();
}
