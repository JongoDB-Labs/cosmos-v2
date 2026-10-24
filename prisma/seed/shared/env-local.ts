import { readFileSync } from "node:fs";

/**
 * Shared `.env.local` loader for the seed / CLI scripts.
 *
 * Importing `@prisma/client` auto-loads `.env`, whose DATABASE_URL points at the
 * in-container `cosmos-postgres` hostname — unreachable from a host run. Every
 * seed script therefore reads `.env.local` itself and hands the result to
 * makePrismaClient(). This used to be the same ~17-line parser copy-pasted into
 * eight scripts; it lives here once so a fix lands in one place.
 *
 * Only `KEY=value` lines with an upper-snake key are recognised, matching what
 * the copies did — this is deliberately NOT a general dotenv implementation (no
 * `export ` prefix, no multi-line values, no interpolation).
 */

/**
 * Parse `./.env.local` into `process.env`, never overwriting a key that is
 * already set, and return the DATABASE_URL it declared (undefined if the file is
 * missing/unreadable or declares none). A missing file is not an error: the
 * caller may already have DATABASE_URL in its environment.
 */
export function loadEnvLocal(): string | undefined {
  let dbUrl: string | undefined;
  try {
    const txt = readFileSync(process.cwd() + "/.env.local", "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
      if (m[1] === "DATABASE_URL") dbUrl = v;
    }
  } catch {
    /* no .env.local — rely on a preset DATABASE_URL */
  }
  return dbUrl;
}

/**
 * `preferProcessEnv` variant: an explicit `DATABASE_URL` in the environment wins
 * outright and `.env.local` is never read. Used by the deployment-facing scripts
 * (bootstrap-org, wire-keycloak-idp), which are normally invoked with the URL on
 * the command line and only fall back to `.env.local` for local runs.
 */
export function resolveDbUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  loadEnvLocal();
  return process.env.DATABASE_URL;
}
