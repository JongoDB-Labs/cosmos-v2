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
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // Replaces the removed package.json `prisma.seed` key. Used by `prisma db seed`
    // and the auto-seed step of `prisma migrate reset` / `migrate dev`.
    seed: "tsx prisma/seed/index.ts",
  },
  // ALWAYS wire a Migrate datasource. Two constraints meet here:
  //
  //  - `env("DATABASE_URL")` resolves EAGERLY at config load and throws when the
  //    var is unset, which would break `npx prisma generate` anywhere it isn't
  //    set (the alternate-product build CI job, a local generate).
  //  - The schema-engine BINARY refuses to start without `--datasource <JSON>`.
  //    Omitting the key entirely therefore broke every schema-engine command —
  //    including `migrate diff`, which needs no database at all — with an
  //    inscrutable, EMPTY "Error in Schema engine:" and no output. That silently
  //    blocked generating additive plugin migrations.
  //
  // A literal placeholder satisfies both: no eager env() throw, and the engine
  // always gets its argument. Commands that genuinely connect still use the real
  // DATABASE_URL whenever it is set, and when it is NOT set they now fail with a
  // plain connection error to an unroutable host instead of an empty engine
  // error — louder, not quieter. This file is read ONLY by the Prisma CLI /
  // Migrate; the application runtime connects through the driver adapter in
  // src/lib/db/client.ts and never loads it.
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://unset:unset@127.0.0.1:1/unset",
  },
});
