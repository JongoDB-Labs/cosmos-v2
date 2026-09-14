// @vitest-environment node
//
// COSMOS-194. Effect of the 20260914200000_backfill_stale_work_item_notification_urls
// migration, proven by applying the real migration.sql to the real e2e database with
// both URL shapes present: the pre-COSMOS-191 "/projects/{KEY}/work-items/{uuid}" rows
// must become "/{orgSlug}/issues?item={uuid}", and rows already on the current shape
// must come out byte-identical.
//
// Everything runs inside a transaction that is rolled back, so the shared e2e database
// is left exactly as it was found — including the row count, which this asserts (the
// backfill rewrites, it never deletes).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const MIGRATION_SQL = readFileSync(
  path.join(
    process.cwd(),
    "prisma/migrations/20260914200000_backfill_stale_work_item_notification_urls/migration.sql",
  ),
  "utf8",
);

const ITEM_ID = "ef31e41d-ed53-46a1-9400-f012d424a828";

let client: pg.Client;
let orgId: string;
let orgSlug: string;
/** url keyed by the notification id we inserted it under, after the migration ran. */
let after: Map<string, string | null>;

async function urlOf(id: string) {
  const r = await client.query<{ url: string | null }>(
    `SELECT url FROM notifications WHERE id = $1`,
    [id],
  );
  return r.rows[0]?.url ?? null;
}

beforeAll(async () => {
  client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("BEGIN");

  const org = await client.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM organizations ORDER BY created_at LIMIT 1`,
  );
  orgId = org.rows[0].id;
  orgSlug = org.rows[0].slug;
  const user = await client.query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
  const userId = user.rows[0].id;

  const fixtures: [string, string, string][] = [
    // [label, type, url] — the shapes that are actually sitting in prod.
    ["stale-mention", "comment.mentioned", `/projects/USMC/work-items/${ITEM_ID}`],
    ["stale-other-project", "comment.mentioned", `/projects/ACME-7/work-items/${ITEM_ID}`],
    ["already-fixed", "comment.mentioned", `/${orgSlug}/issues?item=${ITEM_ID}`],
    ["foreman-alert", "foreman.alert", "/"],
    ["time-tracking", "timesheet.submitted", "/time-tracking?tab=approvals"],
  ];

  const ids: Record<string, string> = {};
  for (const [label, type, url] of fixtures) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO notifications (org_id, user_id, type, title, url)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, userId, type, `COSMOS-194 ${label}`, url],
    );
    ids[label] = inserted.rows[0].id;
  }

  const before = await client.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM notifications`,
  );

  await client.query(MIGRATION_SQL);

  const afterCount = await client.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM notifications`,
  );
  expect(afterCount.rows[0].c).toBe(before.rows[0].c);

  after = new Map();
  for (const [label, id] of Object.entries(ids)) after.set(label, await urlOf(id));
}, 60_000);

afterAll(async () => {
  if (client) {
    await client.query("ROLLBACK");
    await client.end();
  }
});

describe("stale work-item notification URL backfill (e2e DB)", () => {
  it("rewrites the old /projects/{KEY}/work-items/{uuid} shape to the org's issues deep link", () => {
    expect(after.get("stale-mention")).toBe(`/${orgSlug}/issues?item=${ITEM_ID}`);
  });

  it("resolves the slug from the row's own org rather than the project key", () => {
    // Same org, different project key: both land on the same org-slug-prefixed URL.
    expect(after.get("stale-other-project")).toBe(`/${orgSlug}/issues?item=${ITEM_ID}`);
  });

  it("leaves an already-correct /{orgSlug}/issues?item= URL untouched", () => {
    expect(after.get("already-fixed")).toBe(`/${orgSlug}/issues?item=${ITEM_ID}`);
  });

  it("leaves the out-of-scope foreman.alert and /time-tracking URLs untouched", () => {
    expect(after.get("foreman-alert")).toBe("/");
    expect(after.get("time-tracking")).toBe("/time-tracking?tab=approvals");
  });

  it("leaves no row on the dead work-items path", async () => {
    const r = await client.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM notifications WHERE url LIKE '/projects/%/work-items/%'`,
    );
    expect(r.rows[0].c).toBe(0);
  });
});
