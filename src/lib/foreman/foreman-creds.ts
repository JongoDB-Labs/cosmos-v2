// A throwaway HOME holding the org's Foreman Claude OAuth creds, so the Agent SDK
// authenticates as that per-org subscription instead of the deploy box's ~/.claude.
// This is the SDK's NATIVE auth path: with no API key in the (allowlisted) env it
// reads $HOME/.claude/.credentials.json (claudeAiOauth) — the same source `claude
// -p` uses — so pointing HOME here (via buildAgentEnv's homeDir) swaps the identity
// without any env-token plumbing. runAgent materializes one per run and MUST
// cleanupForemanHome() it in a finally: the file holds a live OAuth token.
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_SCOPE_CODE } from "@/lib/ai/claude-oauth-core";

/** The credential triple the SDK reads from `~/.claude/.credentials.json`'s
 *  `claudeAiOauth`. `expiresAt` is a Unix epoch in MILLISECONDS (matches a live
 *  credentials file — it lines up with Date.now()). `refreshToken` may be null
 *  (a session token with no refresh), which the SDK tolerates. */
export interface ForemanClaudeCreds {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

/** The scopes the Foreman connection is granted — the exact set the connect flow
 *  requests ({@link CLAUDE_SCOPE_CODE}), written as the array a live credentials
 *  file stores. The Claude Code runtime checks this for `user:sessions:claude_code`
 *  and refuses to consider itself logged in without it. */
const FOREMAN_CRED_SCOPES = CLAUDE_SCOPE_CODE.split(" ");

/** Local subscription-mode hint the runtime reads from the credentials file to
 *  take the flat-subscription auth path (not metered). The connected account's
 *  real plan is enforced server-side by the token itself — this value is only the
 *  local mode signal, mirroring what a live `~/.claude` cred carries. */
const FOREMAN_SUBSCRIPTION_TYPE = "max";

/** Write the given creds to a fresh temp HOME's `.claude/.credentials.json`
 *  (mode 0600) and return that HOME dir. Caller sets HOME=<dir> for the agent
 *  and cleanupForemanHome(dir)s it afterward. */
export function materializeForemanHome(creds: ForemanClaudeCreds): string {
  const home = mkdtempSync(join(tmpdir(), "foreman-home-"));
  const claudeDir = join(home, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const credPath = join(claudeDir, ".credentials.json");
  writeFileSync(
    credPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt: creds.expiresAt,
        // The runtime rejects an otherwise-valid token as "Not logged in · Please
        // run /login" from the triple ALONE — it also reads `scopes` (to confirm
        // user:sessions:claude_code) and `subscriptionType` (to take the flat-
        // subscription path). A live ~/.claude cred carries both; omitting them
        // was the bug that idled the daemon on every pass.
        scopes: FOREMAN_CRED_SCOPES,
        subscriptionType: FOREMAN_SUBSCRIPTION_TYPE,
      },
    }),
    { mode: 0o600 },
  );
  // Belt-and-suspenders: writeFileSync's mode is masked by umask, so chmod the
  // token file to exactly 0600 regardless of the daemon's umask.
  chmodSync(credPath, 0o600);
  return home;
}

/** Remove a temp HOME created by materializeForemanHome. Best-effort + idempotent
 *  (force: true) so a double-cleanup or an already-gone dir never throws. */
export function cleanupForemanHome(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
