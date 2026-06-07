// src/lib/governance/summary.ts
//
// The AGENT GOVERNANCE / EGRESS-AUDIT read model (design AC-4 evidence made reviewable).
//
// Read-only aggregators over the `egress_decisions` trail + the audit-chain integrity state.
// These power the gov "control posture at a glance" dashboard: the visible proof that the
// CUI-blind chokepoint is working.
//
// ── NO CUI, EVER ──────────────────────────────────────────────────────────────────────
// `egress_decisions` rows carry ONLY structural metadata — counts, enums, a content HASH,
// a tool name, a tenant class, a ceiling. They contain NO message content / NO CUI. This
// module surfaces aggregates + structural rows and NEVER joins to any content table, and
// (defensively) never returns `contentHash` in the recent-rows payload (it isn't needed and
// keeps the surface strictly "shape, not substance").
//
// ── ORG SCOPE (the conversation join) ─────────────────────────────────────────────────
// `egress_decisions` is keyed by `conversation_id` (a plain string), NOT by `org_id`, and has
// no cross-cutting FK (mirroring how opaque-handles are conversation-scoped). The org link is
// therefore via the org's conversations: an assistant conversation's id IS the loop's
// conversationId, so we scope by the set of `AssistantConversation.id` for the org.
//
// CAVEAT (documented): bot loops use synthetic conversation ids `meeting:<id>` / `channel:<id>`
// which are NOT `AssistantConversation` rows, so their egress decisions are NOT counted by this
// assistant-conversation scope. That is the correct conservative behavior for a per-org admin
// view today (it never leaks another org's decisions, and the assistant trail is the user-facing
// chokepoint); widening to bot conversations is a future enhancement once a bot→org index exists.

import { prisma } from "@/lib/db/client";

// The closed set of `decidedBy` reasons the egress gate records (design — the 3-gate model
// plus the handle/connector outcomes). Used to give every bucket a stable zero-baseline so the
// UI renders a consistent breakdown even when some reasons haven't occurred in the window.
export const DECIDED_BY_REASONS = [
  "rbac",
  "agentpolicy",
  "classification",
  "tenant",
  "none",
  "handle_mint",
  "handle_resolve",
  "handle_taint_block",
  "connector_availability_block",
  "connector_gov_block",
  "connector_disabled_block",
] as const;

export type DecidedBy = (typeof DECIDED_BY_REASONS)[number];

export interface EgressSummary {
  /** Total egress decisions recorded for the org in the window. */
  total: number;
  /** Decisions where the value was EXPOSED to the model. */
  exposed: number;
  /** Decisions where one or more values were WITHHELD (exposed === false). */
  withheld: number;
  /** withheld / total, 0..1 (0 when total === 0). The headline chokepoint metric. */
  withholdRate: number;
  /** Count by `decidedBy` reason (every known reason present, zero-baselined). */
  byDecidedBy: Record<string, number>;
  /** Count by `ceiling` (e.g. PUBLIC / CUI / "(none)" for null). */
  byCeiling: Record<string, number>;
  /** Count by `tenantClass` (GOV / COMMERCIAL). */
  byTenantClass: Record<string, number>;
}

/** A structural recent-decision row — NO contentHash, NO CUI. Shape, not substance. */
export interface RecentDecision {
  seq: string | null; // BigInt → string (JSON-safe); null for pre-chain legacy rows
  createdAt: string; // ISO timestamp
  toolName: string | null;
  decidedBy: string;
  exposed: boolean;
  withheldCount: number;
  ceiling: string | null;
  tenantClass: string;
}

export interface AuditIntegrity {
  /** "intact" when verify_audit_chain returns no broken rows; else "broken"; or a reason string. */
  auditLogs: "intact" | "broken";
  auditLogsReason: string | null;
  egressDecisions: "intact" | "broken";
  egressDecisionsReason: string | null;
  /**
   * The in-DB high-water mark of the egress chain (max seq). This is the extent of the
   * tamper-evident trail. The AUTHORITATIVE offsite WORM watermark lives in the immutable
   * S3/MinIO bucket (manifest-toSeq-<N>.json) and is intentionally NOT read here — the
   * read-only dashboard does not couple to WORM creds. Null when no chained rows exist.
   */
  latestWormToSeq: string | null;
  /** The latest retention-purge checkpoint seq per table (the re-anchor point). Null if none. */
  latestCheckpointSeq: string | null;
}

/**
 * Resolve the set of conversation ids that belong to an org (the egress-decision scope).
 * Returns the org's assistant-conversation ids; see the module header for the bot caveat.
 */
async function orgConversationIds(orgId: string): Promise<string[]> {
  const convos = await prisma.assistantConversation.findMany({
    where: { orgId },
    select: { id: true },
  });
  return convos.map((c) => c.id);
}

/**
 * Aggregate the org's egress decisions since `since` (default: all time). Read-only; no CUI.
 * Scoped to the org via its conversation ids (see header). Returns zeros when the org has no
 * conversations / no decisions.
 */
export async function egressSummary(orgId: string, since?: Date): Promise<EgressSummary> {
  const conversationIds = await orgConversationIds(orgId);
  const empty: EgressSummary = {
    total: 0,
    exposed: 0,
    withheld: 0,
    withholdRate: 0,
    byDecidedBy: zeroBaseline(),
    byCeiling: {},
    byTenantClass: {},
  };
  if (conversationIds.length === 0) return empty;

  const where = {
    conversationId: { in: conversationIds },
    ...(since ? { createdAt: { gte: since } } : {}),
  };

  // Pull only the structural fields we aggregate over — never any content.
  const rows = await prisma.egressDecisionRow.findMany({
    where,
    select: {
      exposed: true,
      decidedBy: true,
      ceiling: true,
      tenantClass: true,
    },
  });

  const byDecidedBy = zeroBaseline();
  const byCeiling: Record<string, number> = {};
  const byTenantClass: Record<string, number> = {};
  let exposed = 0;

  for (const r of rows) {
    if (r.exposed) exposed += 1;
    byDecidedBy[r.decidedBy] = (byDecidedBy[r.decidedBy] ?? 0) + 1;
    const ceilingKey = r.ceiling ?? "(none)";
    byCeiling[ceilingKey] = (byCeiling[ceilingKey] ?? 0) + 1;
    byTenantClass[r.tenantClass] = (byTenantClass[r.tenantClass] ?? 0) + 1;
  }

  const total = rows.length;
  const withheld = total - exposed;
  return {
    total,
    exposed,
    withheld,
    withholdRate: total === 0 ? 0 : withheld / total,
    byDecidedBy,
    byCeiling,
    byTenantClass,
  };
}

/** Every known `decidedBy` reason at 0 — a stable baseline so the UI renders consistently. */
function zeroBaseline(): Record<string, number> {
  return Object.fromEntries(DECIDED_BY_REASONS.map((r) => [r, 0]));
}

/**
 * The latest `limit` egress decisions for the org — structural rows ONLY (NO contentHash,
 * NO CUI). Read-only; org-scoped via conversation ids.
 */
export async function recentDecisions(orgId: string, limit = 25): Promise<RecentDecision[]> {
  const conversationIds = await orgConversationIds(orgId);
  if (conversationIds.length === 0) return [];

  const rows = await prisma.egressDecisionRow.findMany({
    where: { conversationId: { in: conversationIds } },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(200, limit)),
    // NOTE: contentHash is deliberately NOT selected — the recent view shows shape, not
    // substance. Never select message content (there is none on this table anyway).
    select: {
      seq: true,
      createdAt: true,
      toolName: true,
      decidedBy: true,
      exposed: true,
      withheldCount: true,
      ceiling: true,
      tenantClass: true,
    },
  });

  return rows.map((r) => ({
    seq: r.seq === null ? null : r.seq.toString(),
    createdAt: r.createdAt.toISOString(),
    toolName: r.toolName,
    decidedBy: r.decidedBy,
    exposed: r.exposed,
    withheldCount: r.withheldCount,
    ceiling: r.ceiling,
    tenantClass: r.tenantClass,
  }));
}

// Raw-row shapes for the two read-only SQL probes below.
type BrokenRow = { broken_seq: bigint | null; reason: string };
type MaxSeqRow = { max_seq: bigint | null };
type CheckpointRow = { checkpoint_seq: bigint | null };

/**
 * Read the audit-chain integrity state (AU-9 / AU-11). Calls the in-DB
 * `verify_audit_chain('audit_logs')` + `('egress_decisions')` (empty result ⇒ intact) and
 * reads the in-DB high-water marks (chain head + latest retention checkpoint).
 *
 * Read-only: verify_audit_chain is STABLE and SELECT-only; we never write. NOT org-scoped —
 * the hash-chain is a single global tamper-evidence structure across all tenants (the
 * integrity of the trail is a platform property, not a per-tenant one). It surfaces NO row
 * content — only seq numbers + the break reason enum.
 */
export async function auditIntegrity(): Promise<AuditIntegrity> {
  const [auditBreaks, egressBreaks] = await Promise.all([
    prisma.$queryRaw<BrokenRow[]>`SELECT broken_seq, reason FROM verify_audit_chain('audit_logs'::regclass)`,
    prisma.$queryRaw<BrokenRow[]>`SELECT broken_seq, reason FROM verify_audit_chain('egress_decisions'::regclass)`,
  ]);

  // The egress chain head (max seq over chained rows) — the in-DB extent of the trail.
  const egressMax = await prisma.$queryRaw<MaxSeqRow[]>`
    SELECT max(seq) AS max_seq FROM "egress_decisions" WHERE row_hash IS NOT NULL`;
  const latestWormToSeq = egressMax[0]?.max_seq != null ? egressMax[0].max_seq.toString() : null;

  // The latest retention-purge checkpoint across both audit tables (the re-anchor point).
  const checkpoint = await prisma.$queryRaw<CheckpointRow[]>`
    SELECT max(checkpoint_seq) AS checkpoint_seq FROM "audit_chain_checkpoint"`;
  const latestCheckpointSeq =
    checkpoint[0]?.checkpoint_seq != null ? checkpoint[0].checkpoint_seq.toString() : null;

  return {
    auditLogs: auditBreaks.length === 0 ? "intact" : "broken",
    auditLogsReason: auditBreaks[0]?.reason ?? null,
    egressDecisions: egressBreaks.length === 0 ? "intact" : "broken",
    egressDecisionsReason: egressBreaks[0]?.reason ?? null,
    latestWormToSeq,
    latestCheckpointSeq,
  };
}
