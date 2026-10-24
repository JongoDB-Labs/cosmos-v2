// @vitest-environment node
// (e2e DB) The CQL index migration against the data prod actually has.
// Activity.old_value / new_value carry uncapped free text (PM register edits:
// a risk's mitigation), and a btree key past ~2.7KB can't be stored, so an
// index on them breaks the deploy, and later inserts after it. The migration
// builds CONCURRENTLY, so its own check must catch an index left INVALID.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/client";

const DIR = join("prisma", "migrations", readdirSync(join("prisma", "migrations")).find((d) => d.endsWith("_cql_indexes"))!);
const SQL = readFileSync(join(DIR, "migration.sql"), "utf8");
const statements = SQL.split(/;\s*\n/)
  .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
  .filter(Boolean);
const indexStatements = statements.filter((s) => s.startsWith("CREATE INDEX CONCURRENTLY"));
const check = statements.find((s) => s.startsWith("SELECT CASE WHEN bad IS NULL"))!;
const NAMES = indexStatements.map((s) => /IF NOT EXISTS "([a-z_]+)"/.exec(s)![1]);
/** Longer than any btree row can hold. */
const LONG = "mitigation ".repeat(400);

describe("the CQL index migration (e2e DB)", () => {
  const orgId = randomUUID();
  const userId = randomUUID();
  const scratch = `cqlmig_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@mig.test`, displayName: "Mig" } });
    await prisma.organization.create({ data: { id: orgId, name: "Mig", slug: `mig-${orgId.slice(0, 8)}` } });
  });
  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${scratch}" CASCADE`);
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  });

  it("is plain statements Prisma can split, and indexes no free-text column", () => {
    expect(indexStatements).toHaveLength(11);
    expect(check).toBeDefined();
    // A dollar-quoted block makes Prisma run the file as one transaction, where
    // CONCURRENTLY fails.
    expect(SQL).not.toContain("$");
    for (const s of indexStatements) {
      expect(s).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS /);
      expect(s, s).not.toMatch(/"(old_value|new_value|description|body|content)"/);
    }
  });

  it("left every index valid on the migrated database", async () => {
    const rows = await prisma.$queryRaw<{ name: string; valid: boolean }[]>`
      SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = ANY(${NAMES}::text[]) AND c.relnamespace = 'public'::regnamespace`;
    expect(rows.map((r) => r.name).sort()).toEqual([...NAMES].sort());
    expect(rows.every((r) => r.valid)).toBe(true);
  });

  it("still takes free text past a btree row afterwards", async () => {
    const a = await prisma.activity.create({
      data: { orgId, userId, subjectType: "risk", subjectId: randomUUID(), action: "updated", field: "mitigation", oldValue: LONG, newValue: LONG },
    });
    expect(a.newValue).toHaveLength(LONG.length);
  });

  it("builds over existing long-text rows", async () => {
    // The migration's own statements, against copies of the tables in a
    // scratch schema that already holds a 4KB activity.
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${scratch}"`);
    for (const t of ["activities", "work_items", "milestone_links", "work_item_links"]) {
      await prisma.$executeRawUnsafe(`CREATE TABLE "${scratch}"."${t}" (LIKE public."${t}" INCLUDING DEFAULTS)`);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${scratch}"."activities" (id, org_id, user_id, action, field, old_value, new_value, created_at) VALUES ($1::uuid, $2::uuid, $3::uuid, 'updated', 'mitigation', $4, $4, now())`,
      randomUUID(), orgId, userId, LONG,
    );
    for (const s of indexStatements) await prisma.$executeRawUnsafe(s.replace(/ ON "([a-z_]+)"/, ` ON "${scratch}"."$1"`));
    const valid = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relnamespace = ${scratch}::regnamespace AND c.relname = ANY(${NAMES}::text[]) AND i.indisvalid`;
    expect(Number(valid[0].n)).toBe(11);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${scratch}"."activities" (id, org_id, user_id, action, field, old_value, new_value, created_at) VALUES ($1::uuid, $2::uuid, $3::uuid, 'updated', 'mitigation', $4, $4, now())`,
      randomUUID(), orgId, userId, LONG,
    );
  });

  it("fails the deploy, naming it, while an index is INVALID", async () => {
    // An interrupted CONCURRENTLY build leaves an INVALID index; a failed
    // unique build makes one on purpose.
    const probe = `${scratch}_probe_idx`;
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "${scratch}"."dups" (v int)`);
    await prisma.$executeRawUnsafe(`INSERT INTO "${scratch}"."dups" VALUES (1), (1)`);
    await expect(prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX CONCURRENTLY "${probe}" ON "${scratch}"."dups" (v)`)).rejects.toThrow();
    const against = (names: string[]) => check.replace(/ARRAY\[[^\]]*\]/, `ARRAY[${names.map((n) => `'${n}'`).join(", ")}]`);
    await expect(prisma.$queryRawUnsafe(against([probe]))).rejects.toThrow(new RegExp(`missing or INVALID: ${probe}`));
    await expect(prisma.$queryRawUnsafe(against([`${scratch}_never_built_idx`]))).rejects.toThrow(/missing or INVALID/);
    // All present and valid: it passes.
    await expect(prisma.$queryRawUnsafe(against(NAMES))).resolves.toEqual([{ case: 0 }]);
  });
});
