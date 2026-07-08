/**
 * The Postgres URL Foreman's checks — and the build agent's own `npm test`
 * self-verification — run vitest against. It is ALWAYS the local e2e/test
 * database, NEVER prod: the DB-integration tests (ingest/files/…) read seeded
 * `test-org` / `TEST`-project fixtures that live only in the test DB, and running
 * them against prod would both fail (no fixtures) and risk touching live data.
 *
 * Defaults to the local e2e bridge; override with `FOREMAN_TEST_DATABASE_URL`.
 * Guarded so it can never resolve to the daemon's live `DATABASE_URL` — a
 * misconfiguration that pointed tests at prod throws here instead of running.
 */
export const DEFAULT_TEST_DATABASE_URL = "postgresql://cosmos:e2epw@127.0.0.1:55440/cosmos";

export function testDatabaseUrl(liveUrl: string | undefined = process.env.DATABASE_URL): string {
  const url = process.env.FOREMAN_TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  if (liveUrl && url === liveUrl) {
    throw new Error(
      "FOREMAN_TEST_DATABASE_URL resolves to the live DATABASE_URL — refusing to run tests against prod",
    );
  }
  return url;
}
