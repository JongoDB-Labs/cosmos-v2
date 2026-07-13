// Foreman's agent runner, on the Claude Agent SDK: runs the coding agent (and the
// read-only judges/reviewer) inside a worktree. Hard-gated to a Claude SUBSCRIPTION
// — see assertSubscription() — so metered API billing is structurally impossible,
// not just discouraged by convention. The subscription is Foreman's OWN per-org
// connection (ForemanAiSettings, via getForemanClaudeCreds): runAgent resolves that
// org's OAuth creds, writes them to a throwaway HOME's .claude/.credentials.json,
// and points HOME there — the SDK's native auth path — so the agent authenticates
// as the org's Claude subscription, NEVER the deploy box's ~/.claude. This is
// STRICT: an org with no Foreman connection throws NoForemanCredentialError (the
// orchestrator parks/idles that org's work) rather than silently falling back to
// any ambient credentials. The SDK bundles its own Claude Code runtime, so daemon
// behavior no longer changes when the interactive `claude` binary upgrades.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildAgentEnv } from "@/lib/foreman/env";
import {
  materializeForemanHome,
  cleanupForemanHome,
  type ForemanClaudeCreds,
} from "@/lib/foreman/foreman-creds";
import { getForemanClaudeCreds, persistForemanClaudeCreds } from "@/lib/ai/foreman-claude-subscription";

/** Thrown when an org has no connected Foreman Claude subscription, so no agent
 *  can run for it. The orchestrator catches this and parks/idles that org's work
 *  with a clear "connect it on the Foreman page" reason — it must NEVER crash the
 *  daemon or fall back to ambient credentials. */
export class NoForemanCredentialError extends Error {
  constructor(public orgId: string) {
    super(`no Foreman Claude connection for org ${orgId}`);
    this.name = "NoForemanCredentialError";
  }
}

/** Env vars that route the agent to a METERED or cloud-billed path instead of the
 *  flat subscription — any of them present is a hard refuse. */
const METERED_ENV = [
  "ANTHROPIC_API_KEY", // pay-per-token API key
  "ANTHROPIC_AUTH_TOKEN", // bearer token → non-subscription API path
  "CLAUDE_CODE_USE_BEDROCK", // routes to AWS Bedrock (metered)
  "CLAUDE_CODE_USE_VERTEX", // routes to GCP Vertex (metered)
] as const;

/** Refuse to run on anything but a Claude subscription — metered API billing must
 *  be impossible. Throws if any metered/cloud var is in the (allowlisted) child
 *  env. The subscription credentials themselves are NOT checked here anymore: the
 *  auth source is the per-org Foreman token, resolved (and asserted present) in
 *  runAgent via getForemanClaudeCreds + the `!creds → NoForemanCredentialError`
 *  throw — so a missing/invalid connection can never silently reach a metered
 *  path, and this stays a pure env guard over buildAgentEnv's allowlisted result. */
export function assertSubscription(env: NodeJS.ProcessEnv): void {
  for (const v of METERED_ENV) {
    if (env[v]) {
      throw new Error(`${v} is set — refusing (routes to metered/cloud billing). Unset it.`);
    }
  }
}

/** After a run, compare what's now in `home`'s materialized `.credentials.json`
 *  against the `injected` triple runAgent wrote there before the run: the Agent
 *  SDK refreshes its own OAuth token in place when it goes near expiry mid-run,
 *  and that fresh token would otherwise be silently discarded along with the
 *  throwaway HOME on cleanup — letting the DB's refresh token go stale over
 *  time. When the on-disk access token differs from what we injected, the SDK
 *  rotated it, so write the rotated triple back onto the org's
 *  ForemanAiSettings row via {@link persistForemanClaudeCreds}. A no-op (most
 *  runs) when the token never needed refreshing.
 *
 *  Exported so it's directly testable as its own unit — real e2e DB, no SDK
 *  call needed. Best-effort BY DESIGN: any failure (file gone, malformed JSON,
 *  a DB write error, ...) is swallowed so a write-back failure can never break
 *  — or even affect the result of — the run itself. */
export async function persistRotatedCredsIfChanged(
  orgId: string,
  home: string,
  injected: ForemanClaudeCreds,
): Promise<void> {
  try {
    const raw = readFileSync(join(home, ".claude", ".credentials.json"), "utf8");
    const oauth = JSON.parse(raw)?.claudeAiOauth as
      | { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown }
      | undefined;
    if (
      oauth &&
      typeof oauth.accessToken === "string" &&
      oauth.accessToken !== injected.accessToken
    ) {
      await persistForemanClaudeCreds(orgId, {
        accessToken: oauth.accessToken,
        refreshToken: typeof oauth.refreshToken === "string" ? oauth.refreshToken : null,
        expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : injected.expiresAt,
      });
    }
  } catch {
    // Best-effort — see the doc comment: never let this break the run.
  }
}

export interface AgentResult {
  ok: boolean;
  log: string;
  /** SDK session id — pass back as `opts.resume` to continue THIS agent's
   *  conversation (the repair loop uses it so the agent keeps its own context). */
  sessionId: string | null;
}

/** Run an agent turn in `worktreeDir` on the org's Foreman subscription. Resolves
 *  (never rejects) `ok:false` on an error result, a timeout, or an SDK/spawn error
 *  — the orchestrator treats any of those as "gate to review", not a crash. The
 *  ONE exception is a missing Foreman connection: `getForemanClaudeCreds(orgId)`
 *  returning null throws NoForemanCredentialError (before any SDK call), which the
 *  orchestrator catches to park/idle that org's work.
 *
 *  `opts.orgId` (REQUIRED) selects whose Foreman Claude subscription authenticates
 *  the run: its creds are written to a throwaway HOME and torn down in the finally.
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
 *  billing vars), with HOME overridden to the per-org creds dir; the feasibility
 *  test's empty-HOME run proved the SDK's `env` option REPLACES the child env
 *  rather than merging, so the allowlist is authoritative. Filesystem settings are
 *  NOT loaded (SDK default) — the agent sees only its prompt, the worktree, and the
 *  tools listed here. */
export async function runAgent(
  worktreeDir: string,
  prompt: string,
  opts: {
    orgId: string;
    maxTurns?: number;
    timeoutMs?: number;
    allowedTools?: string;
    permissionMode?: string;
    resume?: string;
    /** Per-worker e2e database for the agent's own npm test (parallel builds
     *  must not share one test DB — the racy specs collide cross-process). */
    testDbUrl?: string;
  },
): Promise<AgentResult> {
  // STRICT: resolve the org's Foreman subscription creds up front. No connection →
  // throw (the orchestrator parks/idles); there is NO fallback to ambient creds.
  const creds = await getForemanClaudeCreds(opts.orgId);
  if (!creds) throw new NoForemanCredentialError(opts.orgId);
  // Materialize a throwaway HOME holding those creds and point the agent's env at
  // it. The outer finally ALWAYS tears it down — it carries a live OAuth token —
  // even if env-build / assertSubscription throws before the run starts.
  const home = materializeForemanHome(creds);
  try {
    const env = buildAgentEnv(process.env, opts.testDbUrl, home);
    assertSubscription(env);

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
  } finally {
    // A mid-run SDK refresh rotates the token IN PLACE on disk; write any such
    // rotation back to the DB before the throwaway HOME (and the fresh token
    // living only in it) is torn down. Best-effort — see the doc comment.
    await persistRotatedCredsIfChanged(opts.orgId, home, creds);
    cleanupForemanHome(home);
  }
}
