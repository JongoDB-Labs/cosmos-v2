// Prisma 7 configuration.
//
// Carries what Prisma 7 moved out of schema.prisma + package.json:
//   • The datasource connection URL for the Prisma CLI / Migrate. In v7 the schema's
//     `datasource` block keeps only `provider` (+ `extensions`); `url`, `directUrl`,
//     and `shadowDatabaseUrl` are no longer allowed there (https://pris.ly/d/config-datasource).
//   • The seed command — the `prisma` key in package.json is no longer read in v7.
//
// `dotenv/config` restores v6's implicit `.env` loading for CLI commands (Prisma 7
// dropped it). It is a no-op when no `.env` exists — CI and docker-compose inject the
// env vars directly, and the seed scripts load `.env.local` themselves.
//
// `directUrl` is gone in v7 with no config equivalent; this repo set DIRECT_URL ===
// DATABASE_URL everywhere (no connection pooler), so `url` covers it. The shadow DB URL
// is supplied by its only consumer (scripts/cutover/parity-gate.mjs) as an explicit
// `--shadow-database-url` CLI flag, so it needs no entry here.
//
// The APPLICATION RUNTIME does not read this file — it connects through the
// @prisma/adapter-pg driver adapter in src/lib/db/client.ts. This datasource is only
// for the migrate/CLI tooling.
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // Replaces the removed package.json `prisma.seed` key. Used by `prisma db seed`
    // and the auto-seed step of `prisma migrate reset` / `migrate dev`.
    seed: "tsx prisma/seed/index.ts",
  },
  // Only wire the Migrate datasource when DATABASE_URL is present. `env()` resolves
  // EAGERLY at config load and throws if the var is unset, which would break
  // `npx prisma generate` anywhere DATABASE_URL isn't set (e.g. the build-pontis CI
  // job, local generate). `generate` needs no datasource URL, so omitting it there is
  // safe; every command that actually connects (migrate deploy/diff, db execute) runs
  // with DATABASE_URL set.
  ...(process.env.DATABASE_URL
    ? { datasource: { url: env("DATABASE_URL") } }
    : {}),
});
