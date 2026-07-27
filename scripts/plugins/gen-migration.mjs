#!/usr/bin/env node
/**
 * Generate the ADDITIVE migration for the currently-composed plugins.
 *
 * Plugins do not ship migrations (ADR 0003): their tables are created by a
 * migration generated OFFLINE at compose time, which is what this produces.
 *
 * How it works — and why it is safe to run anywhere, including CI:
 *   1. `git show HEAD:prisma/schema.prisma` is the neutral (pre-compose) schema.
 *      The composed schema on disk is that plus every composed plugin's models.
 *   2. `prisma migrate diff --from-schema … --to-schema … --script` renders the
 *      delta as SQL. A schema→schema diff is PURELY textual: it never opens a
 *      database connection. (Verified by pointing DATABASE_URL at an unroutable
 *      host and still getting correct SQL.)
 *
 * The output is written to a file, reviewed, and applied by the deploy pipeline
 * as a normal timestamped migration — this script never touches a database.
 *
 * Usage:
 *   node scripts/plugins/sync.mjs                 # compose first
 *   node scripts/plugins/gen-migration.mjs [out.sql]
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = process.cwd();
const out = process.argv[2] ?? "plugin-migration.sql";

// The schema-engine binary refuses to start without `--datasource <JSON>`, which
// prisma.config.ts derives from DATABASE_URL. A schema→schema diff never
// connects, so any syntactically valid URL satisfies it — but leave a real
// DATABASE_URL alone if the caller set one.
const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://unset:unset@127.0.0.1:1/unset",
};

const tmp = mkdtempSync(join(tmpdir(), "plugin-mig-"));
const neutral = join(tmp, "neutral.prisma");
writeFileSync(neutral, execFileSync("git", ["show", "HEAD:prisma/schema.prisma"], { cwd: ROOT, maxBuffer: 64 << 20 }));

const sql = execFileSync(
  "npx",
  ["prisma", "migrate", "diff", "--from-schema", neutral, "--to-schema", join(ROOT, "prisma", "schema.prisma"), "--script"],
  { cwd: ROOT, env, maxBuffer: 64 << 20 },
).toString();

// Prisma renders an empty diff as a comment rather than an empty string, so
// testing for blank output alone would happily emit a migration that does nothing.
const hasStatements = /^\s*(CREATE|ALTER|DROP)\b/im.test(sql);
if (!hasStatements) {
  console.log("[gen-migration] no schema delta — nothing composed, or already neutral. No file written.");
  process.exit(0);
}

// A plugin migration must be purely additive: it may CREATE, never destroy. A
// DROP here means a plugin fragment altered core, which is a compose-time bug —
// fail loudly rather than hand someone a destructive migration to run on prod.
const destructive = sql.match(/^\s*(DROP TABLE|DROP COLUMN|ALTER TABLE .* DROP)/gim);
if (destructive) {
  console.error(`[gen-migration] REFUSING: migration is not additive:\n  ${destructive.join("\n  ")}`);
  process.exit(1);
}

// resolve(), not join() — `out` may legitimately be an absolute path.
writeFileSync(resolve(ROOT, out), sql);
const tables = (sql.match(/^CREATE TABLE/gim) ?? []).length;
const types = (sql.match(/^CREATE TYPE/gim) ?? []).length;
console.log(`[gen-migration] wrote ${out} — ${tables} table(s), ${types} type(s), additive-only ✅`);
console.log(`[gen-migration] review it, then apply as a timestamped migration under prisma/migrations/.`);
