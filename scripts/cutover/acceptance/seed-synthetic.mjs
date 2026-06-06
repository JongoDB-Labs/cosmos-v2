#!/usr/bin/env node
// scripts/cutover/acceptance/seed-synthetic.mjs — SYNTHETIC source seed for the cutover
// Docker acceptance. Raw SQL (pg), no Prisma client. Seeds a self-consistent tenant plus a
// SECOND org (the "other tenant") so the acceptance proves org-scoping never bleeds.
//
// Usage: SEED_URL=postgres://cosmos:cosmos@localhost:55440/cosmos node seed-synthetic.mjs
//
// The migrated tenant (TENANT) gets: org + 2 users + 2 members, a project, an org-scoped
// work-item-type, a board, a mutable WorkItem, a Note, a ChatChannel + 2 append-only
// ChatMessages, money rows (Revenue, Expense, an Account + JournalEntry + 2 JournalLines),
// and 3 DataClassification rows: a project row + a DUPLICATE (org,NULL) ceiling PAIR with
// DIFFERENT levels (FOUO vs CUI) where the CUI row carries a CUI marking + handling.
//
// PLUS the three referential-integrity / encoding scenarios the fixes must handle:
//   C1 (global parent FK): a GLOBAL work_item_type (org_id IS NULL) referenced by a migrated
//       work_item via the REAL work_items.work_item_type_id FK. The strict org-scope misses
//       the global parent; referential CLOSURE must carry it so the FK resolves.
//   C2 (non-member user ref): a "ghost" user who is NOT in org_members (a removed member) but
//       is still referenced by a migrated home_widget (REAL owner_id FK) AND a migrated
//       work_item's assignee_id (BARE logical user ref). Closure must carry the user.
//   C3 (array-valued jsonb): a CustomField whose `options` jsonb holds a JSON ARRAY
//       (["High","Low"]). Without the codec json fix, pg binds it as a PG array literal and
//       the import transaction aborts; with the fix it round-trips exactly.

import pg from "pg";

const URL = process.env.SEED_URL;
if (!URL) {
  console.error("seed-synthetic: missing SEED_URL");
  process.exit(1);
}

// Stable UUIDs so the acceptance can target specific rows.
export const TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const U1 = "11111111-0000-0000-0000-000000000001";
const U2 = "11111111-0000-0000-0000-000000000002";
const UOTHER = "11111111-0000-0000-0000-0000000000ff";
const M1 = "22222222-0000-0000-0000-000000000001";
const M2 = "22222222-0000-0000-0000-000000000002";
const PROJ = "33333333-0000-0000-0000-000000000001";
const WIT = "44444444-0000-0000-0000-000000000001";
const BOARD = "55555555-0000-0000-0000-000000000001";
export const WORKITEM = "66666666-0000-0000-0000-000000000001";
const NOTE = "77777777-0000-0000-0000-000000000001";
const CHAN = "88888888-0000-0000-0000-000000000001";
const MSG1 = "99999999-0000-0000-0000-000000000001";
const MSG2 = "99999999-0000-0000-0000-000000000002";
export const REVENUE = "a1a1a1a1-0000-0000-0000-000000000001";
export const EXPENSE = "a2a2a2a2-0000-0000-0000-000000000001";
const ACCT_DR = "a3a3a3a3-0000-0000-0000-000000000001";
const ACCT_CR = "a3a3a3a3-0000-0000-0000-000000000002";
const JE = "a4a4a4a4-0000-0000-0000-000000000001";
export const JL1 = "a5a5a5a5-0000-0000-0000-000000000001";
const JL2 = "a5a5a5a5-0000-0000-0000-000000000002";
const DC_PROJ = "c1c1c1c1-0000-0000-0000-000000000001";
const DC_CEIL_FOUO = "c2c2c2c2-0000-0000-0000-000000000001"; // duplicate ceiling, FOUO
const DC_CEIL_CUI = "c2c2c2c2-0000-0000-0000-000000000002"; // duplicate ceiling, CUI (wins)
// ── referential-integrity / encoding fixtures ──
// C1: a GLOBAL (org_id NULL) work_item_type + a migrated work_item that references it.
export const GWIT = "44444444-0000-0000-0000-0000000000e0"; // global WIT (org_id NULL)
const WI_GLOBAL = "66666666-0000-0000-0000-000000000002"; // work_item -> global WIT
// C2: a GHOST user (NOT an org member) still referenced by a home_widget + an assignee.
export const UGHOST = "11111111-0000-0000-0000-0000000000e0";
const HW_GHOST = "d1d1d1d1-0000-0000-0000-000000000001"; // home_widget.owner_id -> ghost (HARD FK)
const WI_GHOST = "66666666-0000-0000-0000-000000000003"; // work_item.assignee_id -> ghost (BARE ref)
// C3: a CustomField whose jsonb `options` is a JSON ARRAY.
export const CUSTOM_FIELD = "e1e1e1e1-0000-0000-0000-000000000001";
// other-org rows (must NEVER be touched by a TENANT-scoped export/import/verify)
const OPROJ = "33333333-0000-0000-0000-0000000000ff";
const OWIT = "44444444-0000-0000-0000-0000000000ff";
const OWORKITEM = "66666666-0000-0000-0000-0000000000ff";
const ODC = "c2c2c2c2-0000-0000-0000-0000000000ff";

const T0 = "2026-06-01T00:00:00Z";

async function main() {
  const c = new pg.Client({ connectionString: URL });
  await c.connect();
  try {
    await c.query("BEGIN");

    // Users (global) — shared by convention; here one per org + a shared author + a GHOST.
    // UGHOST is a former TENANT member (NOT in org_members) still referenced by tenant rows —
    // the C2 closure must carry it even though the MEMBER scope excludes it.
    await c.query(
      `INSERT INTO users (id, email, display_name, created_at) VALUES
         ($1,'alice@tenant.test','Alice',$5),
         ($2,'bob@tenant.test','Bob',$5),
         ($3,'carol@other.test','Carol',$5),
         ($4,'ghost@tenant.test','Ghost (removed member)',$5)`,
      [U1, U2, UOTHER, UGHOST, T0],
    );

    // Organizations.
    await c.query(
      `INSERT INTO organizations (id, name, slug, tenant_class, created_at, updated_at) VALUES
         ($1,'Tenant Inc','tenant','COMMERCIAL',$3,$3),
         ($2,'Other LLC','other','COMMERCIAL',$3,$3)`,
      [TENANT, OTHER, T0],
    );

    // Members.
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, joined_at) VALUES
         ($1,$3,$5,'OWNER',$7),
         ($2,$3,$6,'MEMBER',$7),
         ($4,$8,$9,'OWNER',$7)`,
      [M1, M2, TENANT, "22222222-0000-0000-0000-0000000000ff", U1, U2, T0, OTHER, UOTHER],
    );

    // Project + work-item-type (org-scoped so it migrates) + board.
    await c.query(
      `INSERT INTO projects (id, org_id, name, key, created_at, updated_at) VALUES ($1,$2,'Apollo','APO',$3,$3)`,
      [PROJ, TENANT, T0],
    );
    await c.query(
      `INSERT INTO work_item_types (id, org_id, key, name, created_at) VALUES ($1,$2,'task','Task',$3)`,
      [WIT, TENANT, T0],
    );
    await c.query(
      `INSERT INTO boards (id, org_id, project_id, name, type, created_at) VALUES ($1,$2,$3,'Main','KANBAN',$4)`,
      [BOARD, TENANT, PROJ, T0],
    );

    // Mutable WorkItem (has updated_at) — the row the "mutable update" test will bump.
    await c.query(
      `INSERT INTO work_items (id, org_id, project_id, title, column_key, ticket_number, work_item_type_id, created_by_id, created_at, updated_at)
       VALUES ($1,$2,$3,'Build the thing','todo',1,$4,$5,$6,$6)`,
      [WORKITEM, TENANT, PROJ, WIT, U1, T0],
    );

    // Note (mutable).
    await c.query(
      `INSERT INTO notes (id, org_id, author_id, title, content, created_at, updated_at) VALUES ($1,$2,$3,'Plan','do work',$4,$4)`,
      [NOTE, TENANT, U1, T0],
    );

    // ChatChannel + append-only ChatMessages (PARENT-scoped via channel → org).
    await c.query(
      `INSERT INTO chat_channels (id, org_id, kind, name, created_by_id, created_at, updated_at) VALUES ($1,$2,'CHANNEL','general',$3,$4,$4)`,
      [CHAN, TENANT, U1, T0],
    );
    await c.query(
      `INSERT INTO chat_messages (id, channel_id, author_id, content, kind, created_at) VALUES
         ($1,$3,$4,'hello world','USER',$5),
         ($2,$3,$4,'second message','USER',$6)`,
      [MSG1, MSG2, CHAN, U1, T0, "2026-06-01T00:01:00Z"],
    );

    // Money: Revenue + Expense (Decimal) — exact values to verify per-row.
    await c.query(
      `INSERT INTO revenues (id, org_id, amount, currency, date, created_by_id, created_at, updated_at)
       VALUES ($1,$2,'15000.7500','USD','2026-06-01',$3,$4,$4)`,
      [REVENUE, TENANT, U1, T0],
    );
    await c.query(
      `INSERT INTO expenses (id, org_id, amount, currency, date, category, created_by_id, created_at, updated_at)
       VALUES ($1,$2,'2499.9900','USD','2026-06-01','software',$3,$4,$4)`,
      [EXPENSE, TENANT, U1, T0],
    );

    // Ledger: 2 accounts + a balanced JournalEntry with 2 append-only JournalLines (Decimal).
    await c.query(
      `INSERT INTO accounts (id, org_id, code, name, type, normal_balance, created_at, updated_at) VALUES
         ($1,$3,'1000','Cash','ASSET','DEBIT',$4,$4),
         ($2,$3,'4000','Revenue','REVENUE','CREDIT',$4,$4)`,
      [ACCT_DR, ACCT_CR, TENANT, T0],
    );
    await c.query(
      `INSERT INTO journal_entries (id, org_id, entry_number, date, memo, status, source, created_by_id, created_at, updated_at)
       VALUES ($1,$2,1,'2026-06-01','sale','POSTED','MANUAL',$3,$4,$4)`,
      [JE, TENANT, U1, T0],
    );
    await c.query(
      `INSERT INTO journal_lines (id, org_id, journal_entry_id, account_id, direction, amount, sort_order) VALUES
         ($1,$3,$4,$5,'DEBIT','15000.7500',0),
         ($2,$3,$4,$6,'CREDIT','15000.7500',1)`,
      [JL1, JL2, TENANT, JE, ACCT_DR, ACCT_CR],
    );

    // DataClassification: a project row + a DUPLICATE (org,NULL) ceiling PAIR (FOUO vs CUI).
    // The CUI ceiling carries a CUI marking + handling — the dedupe must KEEP the CUI row
    // (highest rank) and carry its markings verbatim; the FOUO row is dropped + logged.
    await c.query(
      `INSERT INTO data_classifications (id, org_id, project_id, level, markings, handling_instructions, applied_by_id, created_at, updated_at) VALUES
         ($1,$4,$5,'FOUO', ARRAY['FOUO'], 'for official use only', $6, $7, $7),
         ($2,$4,NULL,'FOUO', ARRAY['FOUO//LES'], 'law enforcement sensitive', $6, $7, $7),
         ($3,$4,NULL,'CUI',  ARRAY['CUI//SP-PRVCY'], 'destroy by shredding', $6, $7, $7)`,
      [DC_PROJ, DC_CEIL_FOUO, DC_CEIL_CUI, TENANT, PROJ, U1, T0],
    );

    // ── C1: GLOBAL work_item_type (org_id NULL) + a migrated work_item referencing it. ──
    // The strict org-scope (WHERE org_id = TENANT) EXCLUDES this global parent; without the
    // referential closure the migrated WI_GLOBAL would carry a DANGLING work_item_type_id FK.
    await c.query(
      `INSERT INTO work_item_types (id, org_id, key, name, is_built_in, created_at)
       VALUES ($1, NULL, 'epic', 'Epic (global built-in)', true, $2)`,
      [GWIT, T0],
    );
    await c.query(
      `INSERT INTO work_items (id, org_id, project_id, title, column_key, ticket_number, work_item_type_id, created_by_id, created_at, updated_at)
       VALUES ($1,$2,$3,'References a GLOBAL type','todo',2,$4,$5,$6,$6)`,
      [WI_GLOBAL, TENANT, PROJ, GWIT, U1, T0],
    );

    // ── C2: a home_widget (HARD owner_id FK) + a work_item (BARE assignee_id ref) pointing at
    // the GHOST non-member user. Both must be referentially complete after closure. ──
    await c.query(
      `INSERT INTO home_widgets (id, org_id, owner_id, type, config, sort_order, created_at, updated_at)
       VALUES ($1,$2,$3,'recent_activity','{}',0,$4,$4)`,
      [HW_GHOST, TENANT, UGHOST, T0],
    );
    await c.query(
      `INSERT INTO work_items (id, org_id, project_id, title, column_key, ticket_number, work_item_type_id, assignee_id, created_by_id, created_at, updated_at)
       VALUES ($1,$2,$3,'Assigned to a removed member','todo',3,$4,$5,$6,$7,$7)`,
      [WI_GHOST, TENANT, PROJ, WIT, UGHOST, U1, T0],
    );

    // ── C3: a CustomField whose jsonb `options` is a JSON ARRAY (the abort-on-import bug). ──
    await c.query(
      `INSERT INTO custom_fields (id, org_id, project_id, name, key, field_type, options, required, sort_order, created_at)
       VALUES ($1,$2,$3,'Severity','severity','SELECT', $4::jsonb, false, 0, $5)`,
      [CUSTOM_FIELD, TENANT, PROJ, JSON.stringify(["High", "Medium", "Low"]), T0],
    );

    // ── The OTHER org's data — must NEVER be exported/imported/verified for TENANT. ──
    await c.query(
      `INSERT INTO projects (id, org_id, name, key, created_at, updated_at) VALUES ($1,$2,'Zeus','ZEU',$3,$3)`,
      [OPROJ, OTHER, T0],
    );
    await c.query(
      `INSERT INTO work_item_types (id, org_id, key, name, created_at) VALUES ($1,$2,'task','Task',$3)`,
      [OWIT, OTHER, T0],
    );
    await c.query(
      `INSERT INTO work_items (id, org_id, project_id, title, column_key, ticket_number, work_item_type_id, created_by_id, created_at, updated_at)
       VALUES ($1,$2,$3,'OTHER ORG SECRET','todo',1,$4,$5,$6,$6)`,
      [OWORKITEM, OTHER, OPROJ, OWIT, UOTHER, T0],
    );
    await c.query(
      `INSERT INTO revenues (id, org_id, amount, currency, date, created_by_id, created_at, updated_at)
       VALUES ($1,$2,'999999.9900','USD','2026-06-01',$3,$4,$4)`,
      ["a1a1a1a1-0000-0000-0000-0000000000ff", OTHER, UOTHER, T0],
    );
    await c.query(
      `INSERT INTO data_classifications (id, org_id, project_id, level, markings, handling_instructions, applied_by_id, created_at, updated_at)
       VALUES ($1,$2,NULL,'CUI', ARRAY['CUI//OTHER'], 'other org cui', $3, $4, $4)`,
      [ODC, OTHER, UOTHER, T0],
    );

    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    await c.end();
    console.error(`seed-synthetic: FAILED — ${e?.stack ?? e}`);
    process.exit(1);
  }
  await c.end();
  console.log(`seed-synthetic: seeded tenant ${TENANT} (+ other org ${OTHER}) into the source DB.`);
}

main().catch((e) => {
  console.error(`seed-synthetic: unexpected — ${e?.stack ?? e}`);
  process.exit(1);
});
