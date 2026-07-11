// The environments Foreman hands to its child processes — the coding agent and
// the checks runner. Pure + unit-tested, because getting NODE_ENV wrong here once
// gated EVERY ticket: the daemon runs NODE_ENV=production, but the app's own vitest
// suite is written for test mode and fails wholesale under production (egress /
// agent-loop / render tests). An inherited "production" therefore made both the
// agent's `npm test` self-check and Foreman's own checks spuriously red. Both
// builders force NODE_ENV=test.
import { testDatabaseUrl } from "@/lib/foreman/test-db";

/** The ALLOWLISTED env for `claude` — never the daemon's full `process.env`.
 *  Foreman runs with DATABASE_URL (prod) and may carry GH_TOKEN/GITHUB_TOKEN;
 *  handing those to the agent's Bash would let a build (or a prompt-injected judge)
 *  psql prod or `git push` directly, bypassing every gate. So forward ONLY what
 *  `claude` needs to run on the subscription: PATH (node/binaries), HOME (the
 *  ~/.claude creds), TERM, locale (LANG/LC_*). DATABASE_URL is pinned to the e2e
 *  TEST db so the agent's self-check hits the same fixtures Foreman's checks do
 *  (testDatabaseUrl throws if that ever resolves to the live URL). NODE_ENV is
 *  forced to "test" — see the file header. Metered/cloud-billing vars, GH tokens
 *  and the live DATABASE_URL are excluded by construction; assertSubscription
 *  re-checks the result. */
export function buildAgentEnv(src: NodeJS.ProcessEnv, testDbUrl?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const key of ["PATH", "HOME", "TERM", "LANG"]) {
    if (src[key] !== undefined) env[key] = src[key];
  }
  for (const [key, value] of Object.entries(src)) {
    if (key.startsWith("LC_") && value !== undefined) env[key] = value;
  }
  env.DATABASE_URL = testDbUrl ?? testDatabaseUrl(src.DATABASE_URL);
  return env;
}

/** The env for a check subprocess (tsc / eslint / vitest): the daemon's full env
 *  with NODE_ENV forced to "test" (see the file header), and `extraEnv` — e.g. the
 *  e2e DATABASE_URL — applied last so it still wins. */
export function checkEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, NODE_ENV: "test", ...extraEnv };
}
