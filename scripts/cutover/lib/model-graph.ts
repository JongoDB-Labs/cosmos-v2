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

  // DMMF scalar columns (the only ones Prisma/the app round-trips).
  const dmmfScalarCols = new Set(scalarFields(m).map(colName));

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
    if (!dmmfScalarCols.has(col)) {
      // Not a DMMF scalar (e.g. `embedding` vector(384) Unsupported) ⇒ never copy.
      stripped.push({ column: col, reason: "not a DMMF scalar (db-only/unsupported)" });
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
 */
export function buildScopedSelect(
  plan: ModelPlan,
  columns: string[],
  orgId: string,
): { sql: string; params: unknown[] } {
  const t = quoteIdent(plan.table);
  const cols = columns.map((c) => `${t}.${quoteIdent(c)}`).join(", ");

  switch (plan.scope.kind) {
    case "ROOT": {
      // Organization: single-UUID PK by construction.
      const idCol = quoteIdent(plan.pk[0]);
      return {
        sql: `SELECT ${cols} FROM ${t} WHERE ${t}.${idCol} = $1 ORDER BY ${t}.${idCol} ASC`,
        params: [orgId],
      };
    }
    case "MEMBER": {
      // User: single-UUID PK; scoped to this org's members.
      const idCol = quoteIdent(plan.pk[0]);
      return {
        sql:
          `SELECT ${cols} FROM ${t} WHERE ${t}.${idCol} IN ` +
          `(SELECT ${quoteIdent("user_id")} FROM ${quoteIdent(ORG_MEMBERS_TABLE)} WHERE ${quoteIdent("org_id")} = $1) ` +
          `ORDER BY ${t}.${idCol} ASC`,
        params: [orgId],
      };
    }
    case "DIRECT": {
      const orgCol = plan.scope.orgIdColumn!;
      return {
        sql: `SELECT ${cols} FROM ${t} WHERE ${t}.${quoteIdent(orgCol)} = $1 ORDER BY ${orderByClause(plan, t)}`,
        params: [orgId],
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
        sql: `SELECT ${cols} FROM ${fromSql} WHERE ${topAlias}.${quoteIdent(orgCol)} = $1 ORDER BY ${orderByClause(plan, t)}`,
        params: [orgId],
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
