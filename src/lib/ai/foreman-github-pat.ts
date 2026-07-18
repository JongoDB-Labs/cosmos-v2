/**
 * Foreman's per-org GitHub personal access token (fine-grained PAT), configured
 * from the Foreman console settings — the ONE GitHub credential Foreman uses for
 * read-only PR analysis today (COSMOS: AI Analysis / Approve recommendation) and,
 * going forward, for the daemon's own git/PR/merge operations (replacing the
 * host `gh` CLI). Stored org-scoped and vault-sealed in `connector_credentials`
 * (provider="github", org-level) via {@link setOrgCredential} — the SAME store the
 * analysis endpoints already read through {@link getOrgCredential}, so connecting
 * a PAT here immediately powers the analysis.
 */
import { getOrgCredential, setOrgCredential, deleteOrgCredential } from "@/lib/integrations/credentials";

const GH_PROVIDER = "github";

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "cosmos-foreman",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * The read-only GitHub token Foreman uses. Prefers the org's connected PAT;
 * falls back to a deployment-level `GITHUB_ANALYSIS_TOKEN` env for self-hosted /
 * single-tenant installs where the operator provisions one token for the app
 * process. Returns null when neither is set (callers degrade gracefully).
 */
export async function getForemanGithubToken(orgId: string): Promise<string | null> {
  const bundle = await getOrgCredential(orgId, GH_PROVIDER);
  return bundle?.token ?? process.env.GITHUB_ANALYSIS_TOKEN?.trim() ?? null;
}

/**
 * Validate a PAT is live before we seal it (never store a rejected token).
 * `/rate_limit` succeeds for ANY authenticated token (even a repo-only
 * fine-grained PAT with no account scopes), so it is the liveness probe; the
 * account login is a best-effort label (a repo-only PAT may 403 on `/user`).
 */
export async function validateGithubPat(token: string): Promise<{ login: string } | null> {
  const rl = await fetch("https://api.github.com/rate_limit", { headers: authHeaders(token) });
  if (!rl.ok) return null;
  let login = "connected";
  try {
    const u = await fetch("https://api.github.com/user", { headers: authHeaders(token) });
    if (u.ok) {
      const body = (await u.json()) as { login?: string };
      if (body.login) login = body.login;
    }
  } catch {
    /* login label is best-effort; the token is already proven live */
  }
  return { login };
}

/** Seal + store the PAT as the org-level GitHub connector credential. */
export async function connectForemanGithub(orgId: string, token: string, login: string): Promise<void> {
  await setOrgCredential(orgId, GH_PROVIDER, { token }, { login, connectedAt: new Date().toISOString() });
}

/** Remove the org-level GitHub connector credential. Idempotent. */
export async function disconnectForemanGithub(orgId: string): Promise<void> {
  await deleteOrgCredential(orgId, GH_PROVIDER);
}

/** Connection status for the settings UI. Never returns the token itself. */
export async function getForemanGithubStatus(
  orgId: string,
): Promise<{ connected: boolean; login?: string | null; source?: "org" | "deployment" }> {
  const bundle = await getOrgCredential(orgId, GH_PROVIDER);
  if (bundle?.token) {
    const v = await validateGithubPat(bundle.token).catch(() => null);
    return { connected: true, login: v?.login ?? null, source: "org" };
  }
  if (process.env.GITHUB_ANALYSIS_TOKEN?.trim()) {
    return { connected: true, login: null, source: "deployment" };
  }
  return { connected: false };
}
