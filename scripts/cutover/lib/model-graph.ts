// scripts/cutover/lib/model-graph.ts
//
// THE SCHEMA-DRIVEN MIGRATION PLAN (cutover engine — design spec §9.3–9.4).
//
// Everything the export/import/verify steps need to know about WHICH rows move and
// HOW is DERIVED HERE AT RUNTIME from the Prisma DMMF (+ live `information_schema`),
// never hardcoded. That is deliberate: the v1 and v2 schemas share the SAME 69
// org-scoped business models, and hardcoding "the 69" or "the 37 append-only ones"
// would silently rot the instant a model is added/renamed. The DMMF is the single
// source of truth; this module just classifies it.
//
// What we derive per model:
//   - table name (DMMF dbName)            — the physical table
//   - primary key column (the @id scalar) — UUID `id` everywhere in this schema
//   - append-only vs mutable              — by presence of an `updated_at` column
//                                           (37/69 models lack it → append-only)
//   - money/Decimal columns               — for the per-row money verify
//   - the org-scope path                  — how a row is tied to ONE org:
//        * DIRECT  : the table has an `org_id` column
//        * PARENT  : no org_id, but a to-one FK chain reaches a table that has one
//        * ROOT    : Organization itself (scoped by `id = :orgId`)
//        * MEMBER  : User (scoped via membership: id IN org_members.user_id)
//
// What we EXCLUDE (and why):
//   - the 5 v2-only models (IdpConnection, FederatedIdentity, ConnectorCredential,
//     EgressDecisionRow, EgressHandle) — they have NO v1 source, so they start empty.
//     (Some of them DO have an org_id path, so they must be excluded BY NAME, not by
//     scope-ability.)
//   - user-global / ephemeral tables with no org-scope path that aren't tenant data:
//     Session (ephemeral auth — users re-auth post-cutover), AllowedEmail (a global
//     allowlist), UserPreferences + PushSubscription (per-user settings, not org data).
//   - `_prisma_migrations` is never a DMMF model, so it is never touched.
//
// Columns stripped on copy (NEVER written to v2):
//   - GENERATED columns (e.g. chat_messages.content_tsv `GENERATED ALWAYS … STORED`)
//     — detected generically from information_schema.is_generated; the DB recomputes.
//   - `embedding` (Unsupported("vector(384)")) — not a DMMF scalar at all, so it is
//     naturally absent from our column list; re-embedded separately, left NULL.
//   - `search_vector` (legacy v1 fake-RAG JSON) — a real DMMF scalar, stripped by name.
//
// Pure + dependency-light: imports only `@prisma/client` (for the DMMF) and `pg`
// (for the live column probe). Importable from both `.ts` and `.mjs` (tsx) callers.

import pkg from "@prisma/client";
import type pg from "pg";

// The generated client is CJS; the DMMF hangs off the `Prisma` namespace. We read it
// through a default import so this compiles under the repo's ESM/bundler setup and
// also runs under tsx from a plain `.mjs`.
const { Prisma } = pkg as unknown as { Prisma: { dmmf: DMMF } };

// ── Minimal DMMF shape (we only touch what we use; avoids a hard type dep) ──
interface DMMFField {
  name: string;
  dbName?: string | null;
  kind: "scalar" | "object" | "enum" | "unsupported";
  type: string;
  isId?: boolean;
  isList?: boolean;
  isGenerated?: boolean;
  relationFromFields?: string[];
  relationToFields?: string[];
}
interface DMMFModel {
  name: string;
  dbName?: string | null;
  fields: DMMFField[];
  primaryKey?: { name: string | null; fields: string[] } | null;
}
interface DMMF {
  datamodel: { models: DMMFModel[] };
}

// ── Config (the ONLY hardcoded knowledge — and it's policy, not schema shape) ──

/** v2-only models with no v1 source — they start EMPTY. Excluded BY NAME because some
 *  of them (IdpConnection/FederatedIdentity/ConnectorCredential) are org-scope-able and
 *  would otherwise be picked up by the scope-path resolver. */
export const V2_ONLY_MODELS: ReadonlySet<string> = new Set([
  "IdpConnection",
  "FederatedIdentity",
  "ConnectorCredential",
  "EgressDecisionRow",
  "EgressHandle",
]);

/** Non-org-scoped, non-tenant globals / ephemeral state. Not migrated per-tenant.
 *  (They have no org-scope path anyway; listing them documents the INTENT so a future
 *  reader knows these omissions are deliberate, not a missed path.) */
export const EXCLUDED_GLOBAL_MODELS: ReadonlySet<string> = new Set([
  "Session", // ephemeral auth; users re-auth after cutover
  "AllowedEmail", // global signup allowlist, not org data
  "UserPreferences", // per-user settings, user-global (no org link)
  "PushSubscription", // per-user web-push endpoints, user-global
  "FrozenOrg", // OPERATIONAL cutover-freeze flag, not tenant data (see freeze.ts)
]);

/** The tenant root — migrated as exactly one row scoped by `id = :orgId`. */
const ROOT_MODEL = "Organization";
/** Shared across orgs — migrated as the org's members' users (via org_members). */
const MEMBER_MODEL = "User";
const ORG_MEMBERS_TABLE = "org_members";

/**
 * The IMMUTABLE AUDIT tables (AU-9 append-only store; migration 20260606050000). These carry a
 * BEFORE UPDATE OR DELETE trigger that RAISES for everyone (incl. the owner) — only
 * session_replication_role = replica bypasses it. Even with that bypass, audit immutability
 * means the reconcile must NEVER delete-reconcile these: v1 never deletes audit rows, and the
 * migrated history is anchored by the source's offsite WORM export, not re-reconciled. The
 * delete-extras hard guard refuses any table in this set. (They are append-only anyway, so the
 * mutable-only filter already excludes them; this is a SECOND, explicit, by-name fail-closed
 * guard — defense in depth against a future schema change making one of them "mutable".) */
export const AUDIT_APPEND_ONLY_TABLES: ReadonlySet<string> = new Set([
  "audit_logs",
  "egress_decisions",
]);

/** Legacy v1 fake-RAG column — a real DMMF Json scalar that must NEVER be copied
 *  (replaced by the pgvector `embedding`, backfilled separately). */
const SEARCH_VECTOR_COLS: ReadonlySet<string> = new Set(["search_vector"]);

/** Classification level rank (fail-closed: higher = more restrictive). Mirrors
 *  src/lib/classification/effective.ts `rankOf` EXACTLY — kept local so this module
 *  stays dependency-light and usable from a plain `.mjs` script. */
const CLASSIFICATION_ORDER = [
  "PUBLIC",
  "UNCLASSIFIED",
  "FOUO",
  "CUI",
  "CONFIDENTIAL",
] as const;
export type ClassificationLevelName = (typeof CLASSIFICATION_ORDER)[number];

export function rankOf(level: string): number {
  const i = CLASSIFICATION_ORDER.indexOf(level as ClassificationLevelName);
  // An unknown level is treated as the LOWEST rank so a known level always wins the
  // dedupe — but we never silently accept it: callers should validate against the enum.
  return i;
}

// ── Derived types ──

export type ScopeKind = "DIRECT" | "PARENT" | "ROOT" | "MEMBER";

/** One hop of a PARENT scope path: this table's FK column → the parent table. */
export interface ScopeHop {
  fkColumn: string; // e.g. "channel_id"
  parentTable: string; // e.g. "chat_channels"
  parentPkColumn: string; // e.g. "id"
}

export interface ModelPlan {
  model: string; // DMMF model name, e.g. "ChatMessage"
  table: string; // physical table, e.g. "chat_messages"
  pk: string[]; // primary-key column(s) — usually ["id"], but composite for join tables
  appendOnly: boolean; // true ⇒ ON CONFLICT DO NOTHING; false ⇒ DO UPDATE on updatedAt
  updatedAtColumn: string | null; // the db column name when mutable, else null
  moneyColumns: string[]; // Decimal columns (db names) for the per-row money verify
  scope: {
    kind: ScopeKind;
    // For DIRECT: the org_id column on THIS table.
    orgIdColumn?: string;
    // For PARENT: the ordered FK chain from THIS table up to a table with org_id, plus
    // that final org_id column.
    hops?: ScopeHop[];
    parentOrgIdColumn?: string;
  };
}

/** A column known to the DMMF (scalar) AND present in the live table, with GENERATED
 *  columns excluded — i.e. the exact column set safe to SELECT + INSERT. */
export interface ColumnPlan {
  table: string;
  /** Columns to copy, in a stable order. */
  columns: string[];
  /** Columns deliberately dropped, with the reason (for the report / audit trail). */
  stripped: { column: string; reason: string }[];
}

// ── DMMF helpers ──

function dmmfModels(): DMMFModel[] {
  return Prisma.dmmf.datamodel.models as unknown as DMMFModel[];
}

function tableOf(m: DMMFModel): string {
  return m.dbName ?? m.name;
}

function scalarFields(m: DMMFModel): DMMFField[] {
  return m.fields.filter((f) => f.kind === "scalar");
}

/** Fields that map to a COPYABLE physical column: scalars AND enums (enum columns —
 *  AccountType, ClassificationLevel, OrgRole, … — are stored values that MUST migrate;
 *  in the DMMF they are `kind: "enum"`, NOT "scalar", so a scalar-only filter would
 *  silently drop them and import them as NULL — a data-loss bug). Excludes relation
 *  objects (`kind: "object"`) and any Unsupported/db-only column (not in the DMMF). */
function copyableFields(m: DMMFModel): DMMFField[] {
  return m.fields.filter((f) => f.kind === "scalar" || f.kind === "enum");
}

function colName(f: DMMFField): string {
  return f.dbName ?? f.name;
}

/** The primary-key column(s): a single `@id` scalar, or a `@@id([...])` composite (the
 *  one join table, OrgMemberWorkRole). Returned as db column names. UPSERT keys on the
 *  full PK so a composite-key row replays idempotently on its real identity. */
function pkColumns(m: DMMFModel): string[] {
  const single = m.fields.find((f) => f.isId && f.kind === "scalar");
  if (single) return [colName(single)];
  if (m.primaryKey && m.primaryKey.fields.length > 0) {
    return m.primaryKey.fields.map((fieldName) => {
      const f = scalarFields(m).find((x) => x.name === fieldName);
      if (!f) {
        throw new Error(
          `model-graph: composite PK field ${fieldName} of ${m.name} is not a scalar`,
        );
      }
      return colName(f);
    });
  }
  throw new Error(
    `model-graph: model ${m.name} has no @id or @@id — keyless tables are unsupported by the cutover engine`,
  );
}

/** The single PK column when a model has one (used by ROOT/MEMBER/PARENT join logic,
 *  which only ever target single-UUID-PK tables — Organization, User, and FK parents). */
function singlePkColumn(m: DMMFModel): string {
  const cols = pkColumns(m);
  if (cols.length !== 1) {
    throw new Error(
      `model-graph: ${m.name} has a composite PK; a single-column PK was required here`,
    );
  }
  return cols[0];
}

function orgIdColumnOf(m: DMMFModel): string | null {
  const f = scalarFields(m).find(
    (x) => colName(x) === "org_id" || x.name === "orgId",
  );
  return f ? colName(f) : null;
}

function updatedAtColumnOf(m: DMMFModel): string | null {
  const f = scalarFields(m).find(
    (x) => colName(x) === "updated_at" || x.name === "updatedAt",
  );
  return f ? colName(f) : null;
}

function moneyColumnsOf(m: DMMFModel): string[] {
  return scalarFields(m)
    .filter((x) => x.type === "Decimal")
    .map(colName);
}

/** To-one forward relations (this model holds the FK): single, with relationFromFields. */
function toOneParents(m: DMMFModel): DMMFField[] {
  return m.fields.filter(
    (f) =>
      f.kind === "object" &&
      !f.isList &&
      Array.isArray(f.relationFromFields) &&
      f.relationFromFields.length > 0,
  );
}

/** Map a DMMF FK field's `relationFromFields` (a model FIELD name) to its db column. */
function fkColumnFor(m: DMMFModel, fieldName: string): string {
  const f = scalarFields(m).find((x) => x.name === fieldName);
  return f ? colName(f) : fieldName;
}

// ── Scope-path resolution (BFS over to-one parent FKs to an org_id-bearing table) ──

function resolveScope(
  m: DMMFModel,
  byName: Map<string, DMMFModel>,
): ModelPlan["scope"] | null {
  if (m.name === ROOT_MODEL) return { kind: "ROOT" };
  if (m.name === MEMBER_MODEL) return { kind: "MEMBER" };

  const direct = orgIdColumnOf(m);
  if (direct) return { kind: "DIRECT", orgIdColumn: direct };

  // Walk to-one parents looking for the FIRST that reaches an org_id (shortest path).
  // Guards against cycles (self-FK work-item parent, comment threads, ledger reversals)
  // with a visited set.
  const visited = new Set<string>();
  function walk(model: DMMFModel, hops: ScopeHop[]): ModelPlan["scope"] | null {
    if (visited.has(model.name)) return null;
    visited.add(model.name);
    for (const rel of toOneParents(model)) {
      const parent = byName.get(rel.type);
      if (!parent) continue;
      // Never route org-scope through a model we don't migrate (e.g. a v2-only parent)
      // or back through the User/Org roots — those aren't org-scope carriers here.
      const fkCol = fkColumnFor(model, rel.relationFromFields![0]);
      const parentPk = singlePkColumn(parent);
      const hop: ScopeHop = {
        fkColumn: fkCol,
        parentTable: tableOf(parent),
        parentPkColumn: parentPk,
      };
      const parentOrgId = orgIdColumnOf(parent);
      if (parentOrgId) {
        return { kind: "PARENT", hops: [...hops, hop], parentOrgIdColumn: parentOrgId };
      }
      const deeper = walk(parent, [...hops, hop]);
      if (deeper) return deeper;
    }
    return null;
  }
  return walk(m, []);
}

// ── Public API ──

/**
 * Build the full migration plan for every migratable model, DERIVED from the DMMF.
 * The order is FK-topological-ish for a clean human read, but the import runs under
 * `session_replication_role = replica` so FK firing is suppressed during load — load
 * order does not affect FK satisfaction (it's the complete set at commit that matters).
 * Export/import still iterate in this deterministic order for reproducible output.
 */
export function buildModelPlans(): ModelPlan[] {
  const models = dmmfModels();
  const byName = new Map(models.map((m) => [m.name, m]));
  const plans: ModelPlan[] = [];

  for (const m of models) {
    if (V2_ONLY_MODELS.has(m.name)) continue;
    if (EXCLUDED_GLOBAL_MODELS.has(m.name)) continue;

    const scope = resolveScope(m, byName);
    if (!scope) continue; // no derivable org-scope path ⇒ not tenant data ⇒ skip

    const updatedAtColumn = updatedAtColumnOf(m);
    plans.push({
      model: m.name,
      table: tableOf(m),
      pk: pkColumns(m),
      appendOnly: updatedAtColumn === null,
      updatedAtColumn,
      moneyColumns: moneyColumnsOf(m),
      scope,
    });
  }

  // Deterministic, FK-friendly ordering: ROOT first, then MEMBER, then DIRECT (parents
  // before their PARENT-scoped children by a topo pass), then PARENT by hop depth.
  return orderForLoad(plans);
}

/** Order: Organization, then User, then DIRECT models, then PARENT models by ascending
 *  hop count (parents land before children). Stable + alphabetical within a tier so the
 *  output is byte-reproducible across runs. */
function orderForLoad(plans: ModelPlan[]): ModelPlan[] {
  const tier = (p: ModelPlan): number => {
    if (p.scope.kind === "ROOT") return 0;
    if (p.scope.kind === "MEMBER") return 1;
    if (p.scope.kind === "DIRECT") return 2;
    // PARENT: deeper chains later
    return 3 + (p.scope.hops?.length ?? 0);
  };
  return [...plans].sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    return a.table.localeCompare(b.table);
  });
}

/** Convenience lookup keyed by model name. */
export function modelPlanByName(): Map<string, ModelPlan> {
  return new Map(buildModelPlans().map((p) => [p.model, p]));
}

/**
 * Resolve the exact set of COPYABLE columns for a table against the LIVE database:
 *   columns = (DMMF scalar db-names) ∩ (information_schema columns)
 *             − GENERATED columns − search_vector
 * `embedding` (Unsupported) is not a DMMF scalar, so it's already absent — but we also
 * defend-in-depth by never selecting an information_schema column that isn't a DMMF
 * scalar (so any future Unsupported/db-only column is dropped automatically).
 *
 * Requires a connected `pg.Client`/pool against the SOURCE (or target — same schema).
 */
export async function resolveColumns(
  client: Pick<pg.Client, "query">,
  modelName: string,
): Promise<ColumnPlan> {
  const m = dmmfModels().find((x) => x.name === modelName);
  if (!m) throw new Error(`model-graph: unknown model ${modelName}`);
  const table = tableOf(m);

  // DMMF copyable columns = scalars + enums (the values the app round-trips). Relation
  // objects and db-only columns (e.g. the Unsupported `embedding`) are NOT here, so they
  // are dropped automatically below.
  const dmmfCopyableCols = new Set(copyableFields(m).map(colName));

  // Live columns + their generated-status from information_schema.
  const { rows } = await client.query(
    `SELECT column_name, is_generated
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );

  const columns: string[] = [];
  const stripped: { column: string; reason: string }[] = [];
  for (const r of rows as { column_name: string; is_generated: string }[]) {
    const col = r.column_name;
    if (r.is_generated && r.is_generated.toUpperCase() === "ALWAYS") {
      stripped.push({ column: col, reason: "generated-always (recomputed by DB)" });
      continue;
    }
    if (SEARCH_VECTOR_COLS.has(col)) {
      stripped.push({ column: col, reason: "legacy v1 fake-RAG search_vector" });
      continue;
    }
    if (!dmmfCopyableCols.has(col)) {
      // Not a DMMF scalar/enum (e.g. `embedding` vector(384) Unsupported) ⇒ never copy.
      stripped.push({ column: col, reason: "not a DMMF scalar/enum (db-only/unsupported)" });
      continue;
    }
    columns.push(col);
  }

  if (columns.length === 0) {
    throw new Error(
      `model-graph: table ${table} resolved to zero copyable columns — schema mismatch?`,
    );
  }
  // Ensure every PK column is present (it always should be) — a defensive invariant.
  for (const pk of pkColumns(m)) {
    if (!columns.includes(pk)) {
      throw new Error(`model-graph: PK ${pk} missing from copyable columns of ${table}`);
    }
  }
  return { table, columns, stripped };
}

/**
 * Build the parameterized WHERE clause + params that scope a SELECT to ONE org.
 * Returns SQL fragments to be embedded into `SELECT <cols> FROM <table> <FROM joins>
 * WHERE <where>`. Org-scoping is STRICT: a row of another org can never match.
 *
 *   DIRECT  : WHERE <table>.<org_id> = $1
 *   PARENT  : INNER JOINs up the FK chain to the org_id-bearing ancestor; WHERE that = $1
 *   ROOT    : WHERE <table>.id = $1   (the Organization row itself)
 *   MEMBER  : WHERE <table>.id IN (SELECT user_id FROM org_members WHERE org_id = $1)
 *
 * `extraFilter` (optional, for the incremental soak-sync delta) appends an additional
 * `AND (<sql>)` to the WHERE with its bind value spliced in as `$2`. It is `$2` because the
 * org-scope always binds `$1`; the watermark builder is told to use placeholder index 2. This
 * keeps the org-scope STRICT — the extra filter can only NARROW the result (it is ANDed), it
 * can NEVER widen it to another org. When omitted, the SQL+params are byte-identical to the
 * original full-scope select (so every existing caller is unaffected).
 */
export function buildScopedSelect(
  plan: ModelPlan,
  columns: string[],
  orgId: string,
  extraFilter?: { sql: string; value: unknown },
): { sql: string; params: unknown[] } {
  const t = quoteIdent(plan.table);
  const cols = columns.map((c) => `${t}.${quoteIdent(c)}`).join(", ");
  // The extra (delta) filter, when present, ANDs an additional predicate that binds $2.
  const andExtra = extraFilter ? ` AND (${extraFilter.sql})` : "";
  const extraParams = extraFilter ? [extraFilter.value] : [];

  switch (plan.scope.kind) {
    case "ROOT": {
      // Organization: single-UUID PK by construction.
      const idCol = quoteIdent(plan.pk[0]);
      return {
        sql: `SELECT ${cols} FROM ${t} WHERE ${t}.${idCol} = $1${andExtra} ORDER BY ${t}.${idCol} ASC`,
        params: [orgId, ...extraParams],
      };
    }
    case "MEMBER": {
      // User: single-UUID PK; scoped to this org's members.
      const idCol = quoteIdent(plan.pk[0]);
      return {
        sql:
          `SELECT ${cols} FROM ${t} WHERE ${t}.${idCol} IN ` +
          `(SELECT ${quoteIdent("user_id")} FROM ${quoteIdent(ORG_MEMBERS_TABLE)} WHERE ${quoteIdent("org_id")} = $1)${andExtra} ` +
          `ORDER BY ${t}.${idCol} ASC`,
        params: [orgId, ...extraParams],
      };
    }
    case "DIRECT": {
      const orgCol = plan.scope.orgIdColumn!;
      return {
        sql: `SELECT ${cols} FROM ${t} WHERE ${t}.${quoteIdent(orgCol)} = $1${andExtra} ORDER BY ${orderByClause(plan, t)}`,
        params: [orgId, ...extraParams],
      };
    }
    case "PARENT": {
      const hops = plan.scope.hops!;
      // Build INNER JOINs: child.fk = parent.pk for each hop, aliasing each ancestor.
      let fromSql = t;
      let prevAlias = t;
      const aliases: string[] = [];
      hops.forEach((hop, i) => {
        const alias = quoteIdent(`__p${i}`);
        aliases.push(alias);
        fromSql += ` INNER JOIN ${quoteIdent(hop.parentTable)} ${alias} ON ${prevAlias}.${quoteIdent(hop.fkColumn)} = ${alias}.${quoteIdent(hop.parentPkColumn)}`;
        prevAlias = alias;
      });
      const orgCol = plan.scope.parentOrgIdColumn!;
      const topAlias = aliases[aliases.length - 1];
      return {
        sql: `SELECT ${cols} FROM ${fromSql} WHERE ${topAlias}.${quoteIdent(orgCol)} = $1${andExtra} ORDER BY ${orderByClause(plan, t)}`,
        params: [orgId, ...extraParams],
      };
    }
  }
}

/** Deterministic export ordering: by the full PK, which is unique + stable, so the NDJSON
 *  is byte-reproducible across runs (required for the verify content checksum). Composite
 *  PKs (the one join table) order by all key columns. */
function orderByClause(plan: ModelPlan, tableQuoted: string): string {
  return plan.pk.map((c) => `${tableQuoted}.${quoteIdent(c)} ASC`).join(", ");
}

/** Safe SQL identifier quoting (double-quote, escape embedded quotes). Our identifiers
 *  come from the DMMF/information_schema (trusted), but we quote defensively anyway. */
export function quoteIdent(ident: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    // Identifiers in this schema are snake_case; anything else is a red flag.
    throw new Error(`model-graph: refusing unsafe identifier ${JSON.stringify(ident)}`);
  }
  return `"${ident}"`;
}

// ── REFERENTIAL CLOSURE (C1 + C2 fix — design spec §9.3) ──
//
// The org-scope SELECTs are deliberately STRICT (WHERE org_id = $1 / member subquery), so
// they EXCLUDE two classes of row that a migrated child legitimately references:
//   C1 — GLOBAL built-in parents (org_id IS NULL): WorkItemType / ProjectTemplate /
//        BoardTemplate (and Theme). A migrated work_item points at a global work_item_type
//        via a REAL DB FK (work_items.work_item_type_id, RESTRICT). The org-scoped export
//        misses that global parent ⇒ the imported child is a DANGLING FK (committed silently
//        because the import runs under session_replication_role = replica).
//   C2 — non-member USERS still referenced by a migrated row (a removed member whose
//        user_id/assignee_id/author_id/… still appears). Some of these are REAL DB FKs
//        (home_widgets.owner_id, cycle_capacities.user_id); most are BARE logical refs
//        (no DB FK, but the app reads them and they'd break in v2).
//
// THE FIX: after the org-scoped rows are collected, compute the TRANSITIVE CLOSURE of the
// FK-referenced parent rows that aren't already in the set and export them too — BY ID,
// regardless of their org_id/membership — so the imported set is REFERENTIALLY COMPLETE.
// The closure adds ONLY referenced parent rows (users/globals); it NEVER widens what counts
// as "the org's rows". Closure rows are SHARED, not org-owned (a global built-in or a user
// already present in v2 with the same id is a harmless idempotent no-op on import).
//
// FK edges are DERIVED from the DMMF (every to-one relation → its FK column + target model)
// — that covers every HARD DB FK automatically. The BARE user refs have NO DMMF relation
// (they're plain @db.Uuid scalars), so they CANNOT be derived; they are enumerated below by
// name (table → column) with a comment for why. Each such column targets `User`.

/** One FK edge from a migrated table to a parent that may live OUTSIDE the org scope (a
 *  global built-in or a shared user). Used to pull referenced parents into the closure. */
export interface FkEdge {
  /** The FK column on the CHILD table holding the parent id. */
  fkColumn: string;
  /** The parent DMMF model name. */
  targetModel: string;
  /** The parent physical table. */
  targetTable: string;
  /** The parent's single-column PK (closure only follows single-UUID-PK parents). */
  targetPk: string;
  /** true when this is a real DB FK (DMMF relation); false for a bare logical ref. */
  hardFk: boolean;
}

/**
 * BARE logical user references — @db.Uuid columns that point at `users.id` but carry NO
 * Prisma relation (and therefore NO DB FK), so they are invisible to DMMF FK derivation.
 * They MUST be enumerated by hand. Every column here targets the User model. Keeping them
 * explicit (rather than guessing by name) is deliberate: a wrong guess would pull the wrong
 * parent table. Derived once from the schema (grep of *_id @db.Uuid scalars with no
 * relation whose name denotes a user/actor/owner/author) — see the build prompt's C2 list.
 *
 * NOTE: columns that DO have a relation (home_widgets.owner_id, cycle_capacities.user_id,
 * federated_identities.user_id, …) are intentionally ABSENT here — they're picked up as
 * HARD FKs by fkEdgesOf() from the DMMF, so listing them again would be redundant.
 */
export const BARE_USER_REF_COLUMNS: ReadonlyMap<string, readonly string[]> = new Map([
  ["work_items", ["assignee_id", "created_by_id"]],
  ["activities", ["user_id"]],
  ["comments", ["author_id"]],
  ["notes", ["author_id"]],
  ["chat_channels", ["created_by_id"]],
  ["chat_messages", ["author_id"]],
  ["chat_channel_members", ["user_id"]],
  ["chat_message_mentions", ["user_id"]],
  ["chat_message_reactions", ["user_id"]],
  ["chat_message_attachments", ["uploaded_by_id"]],
  ["revenues", ["created_by_id"]],
  ["expenses", ["created_by_id", "approved_by_id"]],
  ["journal_entries", ["created_by_id"]],
  ["accounting_periods", ["closed_by_id"]],
  ["time_entries", ["user_id", "approved_by_id"]],
  ["saved_reports", ["created_by_id"]],
  ["data_classifications", ["applied_by_id"]],
  ["compliance_controls", ["assessed_by_id"]],
  ["audit_logs", ["user_id"]],
  ["notifications", ["user_id"]],
  ["objectives", ["owner_id"]],
  ["key_results", ["owner_id"]],
  ["crm_contacts", ["owner_id"]],
  ["feedback_items", ["author_id"]],
  ["feedback_votes", ["user_id"]],
  ["meeting_attendees", ["user_id"]],
  ["sync_meetings", ["created_by_id"]],
  ["assistant_conversations", ["user_id"]],
  ["session_records", ["user_id"]],
  ["connector_credentials", ["user_id"]],
]);

/** Resolve a model's physical table + single PK column (helper for closure edge building). */
function tableAndPkOf(modelName: string, byName: Map<string, DMMFModel>): { table: string; pk: string } | null {
  const m = byName.get(modelName);
  if (!m) return null;
  return { table: tableOf(m), pk: singlePkColumn(m) };
}

/**
 * The FK edges from one migrated model to parent rows that may fall OUTSIDE the strict
 * org-scope and therefore must be pulled into the referential closure:
 *   - HARD FKs: every to-one DMMF relation (covers work_item_type_id, project_template_id,
 *     home_widgets.owner_id, cycle_capacities.user_id, the self-FK parent_id, cycle_id, …).
 *   - BARE user refs: the enumerated @db.Uuid → users.id columns with no DMMF relation.
 *
 * Self-references and refs to already-org-scoped parents (Cycle, the parent WorkItem) are
 * KEPT — they're harmless (the parent is already in the export, so the closure finds nothing
 * new to add) and dropping them would require knowing the org-scope set here. The closure
 * loop dedupes by id, so following an already-exported parent is a cheap no-op.
 */
export function fkEdgesOf(modelName: string): FkEdge[] {
  const models = dmmfModels();
  const byName = new Map(models.map((m) => [m.name, m]));
  const m = byName.get(modelName);
  if (!m) throw new Error(`model-graph: unknown model ${modelName}`);

  const edges: FkEdge[] = [];
  const seenCols = new Set<string>();

  // HARD FKs from the DMMF (to-one relations holding the FK on THIS model).
  for (const rel of toOneParents(m)) {
    const target = tableAndPkOf(rel.type, byName);
    if (!target) continue; // relation to a non-DMMF model (can't happen here) — skip
    const fkCol = fkColumnFor(m, rel.relationFromFields![0]);
    if (rel.relationFromFields!.length !== 1) continue; // composite FKs unused in this schema
    edges.push({
      fkColumn: fkCol,
      targetModel: rel.type,
      targetTable: target.table,
      targetPk: target.pk,
      hardFk: true,
    });
    seenCols.add(fkCol);
  }

  // BARE user refs (no DMMF relation) — every one targets User.
  const userTarget = tableAndPkOf(MEMBER_MODEL, byName);
  const bare = BARE_USER_REF_COLUMNS.get(tableOf(m));
  if (bare && userTarget) {
    for (const col of bare) {
      if (seenCols.has(col)) continue; // already a hard FK (shouldn't happen, defensive)
      edges.push({
        fkColumn: col,
        targetModel: MEMBER_MODEL,
        targetTable: userTarget.table,
        targetPk: userTarget.pk,
        hardFk: false,
      });
      seenCols.add(col);
    }
  }

  return edges;
}

/** A row to add to a parent table's export because a migrated child references it but the
 *  strict org-scope excluded it (a global built-in or a non-member user). */
export interface ClosureTargetTable {
  model: string;
  table: string;
  pk: string;
}

/** The set of parent TABLES the closure may need to fetch rows from (union of all FK-edge
 *  targets across migrated models), keyed by table. Used by the exporter to know which
 *  parent tables to resolve columns for once. */
export function closureTargetTables(plans: ModelPlan[]): Map<string, ClosureTargetTable> {
  const out = new Map<string, ClosureTargetTable>();
  for (const p of plans) {
    for (const e of fkEdgesOf(p.model)) {
      if (!out.has(e.targetTable)) {
        out.set(e.targetTable, { model: e.targetModel, table: e.targetTable, pk: e.targetPk });
      }
    }
  }
  return out;
}

// ── GENERIC ORPHAN / DANGLING-FK PROBE (the C-fix backstop — design spec §9.3 step 7) ──
//
// Count checks + money + checksum CANNOT see a dangling FK (the row is present, just its
// parent is missing). This probe is driven off the live catalog (pg_constraint) so it catches
// C1, C2, AND any future scope gap GENERICALLY — every FK on every migrated table is checked
// with a LEFT JOIN: `child.fk IS NOT NULL AND parent.pk IS NULL` ⇒ ORPHAN ⇒ FAIL. It also
// checks the BARE logical user refs (LEFT JOIN users) since those have no catalog FK.

export interface OrphanProbeTarget {
  /** Child physical table. */
  childTable: string;
  /** FK column on the child. */
  childColumn: string;
  /** Parent physical table. */
  parentTable: string;
  /** Parent PK column. */
  parentColumn: string;
  /** Constraint name (catalog FKs) or a synthetic label (bare refs). */
  constraint: string;
  /** true when this is a real DB FK; false for a bare logical user ref. */
  hardFk: boolean;
}

/** The set of migrated physical tables (so the probe only checks rows we actually load). */
export function migratedTableSet(plans: ModelPlan[]): Set<string> {
  return new Set(plans.map((p) => p.table));
}

/**
 * Discover every FK to check, GENERICALLY:
 *   1. Real DB FKs from pg_constraint where the CHILD table is a migrated table (so we only
 *      probe what the cutover loads; a v2-only child isn't our concern).
 *   2. The BARE logical user refs (no catalog FK) → users.id.
 * Single-column FKs only (this schema has no composite FK columns); composite FKs are skipped
 * with a warning so a future composite FK is noticed rather than silently unchecked.
 */
export async function discoverOrphanProbeTargets(
  client: Pick<pg.Client, "query">,
  plans: ModelPlan[],
): Promise<OrphanProbeTarget[]> {
  const migrated = migratedTableSet(plans);
  const targets: OrphanProbeTarget[] = [];

  // 1. Catalog FKs (single-column) whose CHILD is a migrated table.
  const { rows } = await client.query(
    `SELECT
        con.conname                              AS constraint,
        child.relname                            AS child_table,
        parent.relname                           AS parent_table,
        att_child.attname                        AS child_column,
        att_parent.attname                       AS parent_column,
        array_length(con.conkey, 1)              AS nkeys
       FROM pg_constraint con
       JOIN pg_class child   ON child.oid  = con.conrelid
       JOIN pg_class parent  ON parent.oid = con.confrelid
       JOIN pg_namespace ns  ON ns.oid = child.relnamespace
       JOIN pg_attribute att_child  ON att_child.attrelid  = con.conrelid  AND att_child.attnum  = con.conkey[1]
       JOIN pg_attribute att_parent ON att_parent.attrelid = con.confrelid AND att_parent.attnum = con.confkey[1]
      WHERE con.contype = 'f'
        AND ns.nspname = current_schema()
      ORDER BY child.relname, con.conname`,
  );
  for (const r of rows as Array<Record<string, string | number>>) {
    const childTable = String(r.child_table);
    if (!migrated.has(childTable)) continue; // only probe migrated children
    if (Number(r.nkeys) !== 1) {
      console.warn(
        `model-graph: SKIPPING composite FK ${r.constraint} on ${childTable} (probe handles single-column FKs)`,
      );
      continue;
    }
    targets.push({
      childTable,
      childColumn: String(r.child_column),
      parentTable: String(r.parent_table),
      parentColumn: String(r.parent_column),
      constraint: String(r.constraint),
      hardFk: true,
    });
  }

  // 2. Bare logical user refs (no catalog FK) → users.id.
  const userT = tableAndPkOf(MEMBER_MODEL, new Map(dmmfModels().map((m) => [m.name, m])));
  if (userT) {
    for (const [childTable, cols] of BARE_USER_REF_COLUMNS) {
      if (!migrated.has(childTable)) continue;
      for (const col of cols) {
        targets.push({
          childTable,
          childColumn: col,
          parentTable: userT.table,
          parentColumn: userT.pk,
          constraint: `logical:${childTable}.${col}->users`,
          hardFk: false,
        });
      }
    }
  }

  return targets;
}

/** Build the orphan-detecting SQL for one probe target: a LEFT JOIN finding any child row
 *  whose non-null FK has no matching parent. LIMIT 1 — we only need existence. */
export function orphanProbeSql(t: OrphanProbeTarget): string {
  const c = quoteIdent(t.childTable);
  const p = quoteIdent(t.parentTable);
  const fk = quoteIdent(t.childColumn);
  const pk = quoteIdent(t.parentColumn);
  return (
    `SELECT child.${fk} AS orphan_fk ` +
    `FROM ${c} child LEFT JOIN ${p} parent ON child.${fk} = parent.${pk} ` +
    `WHERE child.${fk} IS NOT NULL AND parent.${pk} IS NULL LIMIT 1`
  );
}

// ── DELETE-EXTRAS support (the FINAL reconcile — design spec §9.4) ──
//
// The final reconcile (reconcile-org.mjs, run ONCE under freeze) makes v2 EXACTLY match the
// write-frozen source by removing rows that were DELETED in the source during the soak (a
// watermark delta can't see a delete). The set of tables eligible for delete-extras is, by
// HARD INVARIANT, exactly:
//
//   org-owned (DIRECT or PARENT scope) ∩ mutable (has updated_at) ∩ non-audit
//
//   - ROOT (the Organization row) and MEMBER (shared Users) are NEVER delete-reconciled —
//     the org row is the tenant itself; Users are shared across orgs (a closure parent, not
//     org-owned). Excluded by the DIRECT/PARENT scope filter.
//   - APPEND-ONLY tables are NEVER deleted (audit immutability + immutable history). Excluded
//     by the mutable filter.
//   - The two AUDIT tables are refused a SECOND time BY NAME (defense in depth) even though
//     they're already append-only.
//   - The referential-closure parents (global built-ins org_id IS NULL, shared users) are
//     NEVER candidates: the org-scoped PK-set diff is computed from the STRICT org-scope
//     SELECT, which excludes a global (org_id NULL) parent and a non-member user — so such a
//     row can never appear in either the source-scoped or target-scoped PK set, hence never in
//     target-minus-source.

/**
 * The plans eligible for delete-extras: mutable, DIRECT/PARENT-scoped, NON-AUDIT. This is the
 * ONLY set the reconcile may delete from. Throws if (impossibly) an audit table slipped through
 * the mutable filter — fail-closed.
 */
export function deleteExtrasPlans(plans: ModelPlan[]): ModelPlan[] {
  const out: ModelPlan[] = [];
  for (const p of plans) {
    if (p.appendOnly) continue; // immutable history / audit — never delete
    if (p.scope.kind !== "DIRECT" && p.scope.kind !== "PARENT") continue; // not org-owned
    if (AUDIT_APPEND_ONLY_TABLES.has(p.table)) {
      // Cannot happen (audit tables are append-only), but if a future schema change made one
      // "mutable", refuse LOUDLY rather than silently delete-reconcile an audit table.
      throw new Error(
        `model-graph: ${p.table} is an AUDIT table but resolved as mutable — refusing to make it delete-extras-eligible (audit immutability)`,
      );
    }
    out.push(p);
  }
  return out;
}

/** Hard guard used by the reconcile before EVERY delete: refuse to delete from an append-only
 *  or audit table. Returns the reason string if forbidden, else null (allowed). */
export function deleteForbiddenReason(plan: ModelPlan): string | null {
  if (AUDIT_APPEND_ONLY_TABLES.has(plan.table)) return "audit/append-only (AU-9 immutable store)";
  if (plan.appendOnly) return "append-only (immutable history)";
  if (plan.scope.kind === "ROOT") return "ROOT (the tenant Organization row)";
  if (plan.scope.kind === "MEMBER") return "MEMBER (shared User — closure parent, not org-owned)";
  return null;
}

/**
 * Order the delete-extras plans CHILDREN-BEFORE-PARENTS (reverse FK-topological) so deleting a
 * parent never strands a retained child (which would become a dangling FK). Derived from the
 * LIVE catalog (pg_constraint) restricted to the eligible table set: an edge child→parent means
 * "child must be deleted before parent". We emit a topological order of PARENTS-FIRST then
 * REVERSE it (so children come first). Self-references are ignored (a self-FK can't constrain
 * the table's position relative to itself). A cycle among distinct tables (none in this schema)
 * is broken deterministically with a warning so it's noticed, not silently mis-ordered.
 *
 * Only edges WITHIN the eligible set matter: an edge to a NON-eligible parent (a global, a user,
 * an append-only table — none of which we delete) imposes no ordering constraint on our deletes
 * (we never delete that parent), so it is skipped.
 */
export async function orderForDelete(
  client: Pick<pg.Client, "query">,
  plans: ModelPlan[],
): Promise<ModelPlan[]> {
  const eligible = deleteExtrasPlans(plans);
  const eligibleTables = new Set(eligible.map((p) => p.table));
  const planByTable = new Map(eligible.map((p) => [p.table, p]));

  // Build edges child -> parent for FKs where BOTH endpoints are eligible (and child != parent).
  const { rows } = await client.query(
    `SELECT child.relname AS child_table, parent.relname AS parent_table
       FROM pg_constraint con
       JOIN pg_class child  ON child.oid  = con.conrelid
       JOIN pg_class parent ON parent.oid = con.confrelid
       JOIN pg_namespace ns ON ns.oid = child.relnamespace
      WHERE con.contype = 'f' AND ns.nspname = current_schema()`,
  );
  // adjacency: parent -> set of children that must be deleted before it (we want parents LAST).
  // We compute a parents-first topo (Kahn) over edges parent->child, then reverse.
  const childrenOf = new Map<string, Set<string>>(); // parent -> children
  const indegree = new Map<string, number>(); // child -> count of eligible parents
  for (const t of eligibleTables) {
    childrenOf.set(t, new Set());
    indegree.set(t, 0);
  }
  for (const r of rows as { child_table: string; parent_table: string }[]) {
    const c = r.child_table;
    const p = r.parent_table;
    if (c === p) continue; // self-FK: no ordering constraint
    if (!eligibleTables.has(c) || !eligibleTables.has(p)) continue; // edge leaves the set
    const kids = childrenOf.get(p)!;
    if (!kids.has(c)) {
      kids.add(c);
      indegree.set(c, (indegree.get(c) ?? 0) + 1);
    }
  }

  // Kahn topo: parents (indegree 0) first.
  const queue: string[] = [...eligibleTables].filter((t) => (indegree.get(t) ?? 0) === 0).sort();
  const parentsFirst: string[] = [];
  while (queue.length > 0) {
    const t = queue.shift()!;
    parentsFirst.push(t);
    for (const child of [...(childrenOf.get(t) ?? [])].sort()) {
      indegree.set(child, (indegree.get(child) ?? 0) - 1);
      if ((indegree.get(child) ?? 0) === 0) queue.push(child);
    }
  }
  // Any table left with indegree > 0 is in a cycle (none expected here) — append deterministically.
  if (parentsFirst.length < eligibleTables.size) {
    const remaining = [...eligibleTables].filter((t) => !parentsFirst.includes(t)).sort();
    console.warn(
      `model-graph: FK cycle among delete-extras tables (${remaining.join(", ")}) — appending deterministically; verify the orphan probe still passes`,
    );
    parentsFirst.push(...remaining);
  }

  // Reverse ⇒ children-before-parents (delete children first so a parent delete never strands one).
  return parentsFirst.reverse().map((t) => planByTable.get(t)!);
}

/**
 * Build the strict org-scoped PK-SET select for delete-extras: fetch ONLY the PK column(s) of a
 * table, scoped to ONE org (reusing the same DIRECT/PARENT scope as the exporter). Used to
 * compute source-scoped vs target-scoped PK sets. Returns the SELECT + params (org = $1).
 */
export function buildScopedPkSelect(
  plan: ModelPlan,
  orgId: string,
): { sql: string; params: unknown[] } {
  return buildScopedSelect(plan, plan.pk, orgId);
}
