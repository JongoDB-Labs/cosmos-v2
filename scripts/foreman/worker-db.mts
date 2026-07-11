// Per-worker e2e test databases for PARALLEL builds. The full vitest suite has
// serialization-sensitive specs (files/ingest race per-project ticketNumber
// allocation; several suites share test-org fixtures) — two concurrent builds
// hammering ONE test DB produce cross-process flakes that gate good changes.
// Each worker therefore gets its own database, template-cloned from the seeded
// e2e DB at daemon startup (fresh every boot; intra-run drift is fine because
// suites self-clean or create isolated orgs).
import { Client } from "pg";
import { testDatabaseUrl } from "@/lib/foreman/test-db";

/** DROP + CREATE `foreman_w<i>` (i = 1..n) as clones of the e2e template DB,
 *  returning each worker slot's DATABASE_URL. Throws on any failure — the
 *  caller falls back to a single shared DB rather than running parallel on it. */
export async function ensureWorkerDbs(n: number): Promise<string[]> {
  const template = new URL(testDatabaseUrl(process.env.DATABASE_URL));
  const templateDb = template.pathname.replace(/^\//, "");
  // Admin connection on the SAME server, against the maintenance DB — you
  // cannot DROP/CREATE the database you are connected to.
  const admin = new URL(template.toString());
  admin.pathname = "/postgres";
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const urls: string[] = [];
    for (let i = 1; i <= n; i++) {
      const name = `foreman_w${i}`;
      // Belt & suspenders: the worker DB must never resolve to the live DB.
      const url = new URL(template.toString());
      url.pathname = `/${name}`;
      if (process.env.DATABASE_URL && url.toString() === process.env.DATABASE_URL) {
        throw new Error(`worker DB ${name} resolves to the live DATABASE_URL — refusing`);
      }
      // Kill stragglers holding either the old worker DB or the template (a
      // CREATE ... TEMPLATE needs the template connection-free).
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name],
      );
      await client.query(`DROP DATABASE IF EXISTS ${name}`);
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [templateDb],
      );
      await client.query(`CREATE DATABASE ${name} TEMPLATE "${templateDb}"`);
      urls.push(url.toString());
    }
    return urls;
  } finally {
    await client.end().catch(() => undefined);
  }
}
