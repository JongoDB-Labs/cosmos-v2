/**
 * Point the daemon's git + gh at the org's connected fine-grained GitHub PAT
 * (Foreman settings) instead of the host `gh` CLI login. Sets GH_TOKEN (for gh)
 * and a GIT_ASKPASS credential shim (for git push/fetch over https) on the process
 * env, which every execFile child — the `gh` and `git` calls throughout ship.mts /
 * run.mts — inherits, so there are NO per-call-site changes. When no delivery org
 * has a PAT connected it is a NO-OP: git/gh keep using whatever the host is logged
 * into, so nothing breaks before a PAT is configured. Best-effort.
 *
 * The PAT needs Contents + Pull requests (write) for build/push/PR and
 * Administration (write) to merge past main's required check (Foreman merges with
 * `--admin`) — see the Foreman GitHub settings card for the full list.
 */
import { writeFileSync, chmodSync } from "node:fs";
import { getForemanGithubToken } from "@/lib/ai/foreman-github-pat";
import { deliveryProjects } from "./db.mjs";

const ASKPASS_PATH = "/tmp/foreman-git-askpass.sh";

/** Apply (or clear) the PAT auth env. Pure w.r.t. the env object it is handed, so
 *  it is unit-tested. The askpass script holds NO secret — it echoes the PAT from
 *  the FOREMAN_GH_PAT env var (kept off disk); 0700 so only the daemon user reads
 *  it. Returns whether auth was configured. */
export function applyGithubAuthEnv(token: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!token) return false;
  writeFileSync(
    ASKPASS_PATH,
    '#!/bin/sh\ncase "$1" in *[Uu]sername*) echo x-access-token ;; *) echo "$FOREMAN_GH_PAT" ;; esac\n',
    { mode: 0o700 },
  );
  chmodSync(ASKPASS_PATH, 0o700);
  env.GH_TOKEN = token;
  env.GITHUB_TOKEN = token;
  env.GIT_ASKPASS = ASKPASS_PATH;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "credential.helper";
  env.GIT_CONFIG_VALUE_0 = "";
  env.FOREMAN_GH_PAT = token;
  return true;
}

/** Resolve the first delivery org's connected PAT and apply it to this process.
 *  No-op when none is connected. */
export async function configureGithubAuth(
  resolve: (orgId: string) => Promise<string | null> = getForemanGithubToken,
): Promise<{ configured: boolean }> {
  try {
    const pool = await deliveryProjects();
    const orgIds = [...new Set(pool.map((p) => p.orgId))];
    let token: string | null = null;
    for (const orgId of orgIds) {
      token = await resolve(orgId);
      if (token) break;
    }
    return { configured: applyGithubAuthEnv(token) };
  } catch {
    return { configured: false };
  }
}
