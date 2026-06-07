// @vitest-environment node
//
// The agent-governance read model — proves the aggregation SHAPING (counts, withhold rate,
// by-decidedBy / by-ceiling / by-tenantClass), the org scope (conversation-id join), the
// audit-integrity read (intact vs broken + high-water marks), and — critically — that NO CUI
// (and no contentHash) ever leaks into a payload that doesn't need it.
import { describe, it, expect, beforeEach, vi } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    assistantConversation: { findMany: vi.fn() },
    egressDecisionRow: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import {
  egressSummary,
  recentDecisions,
  auditIntegrity,
  DECIDED_BY_REASONS,
} from "./summary";

const ORG = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.assistantConversation.findMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
});

describe("egressSummary — aggregation shaping", () => {
  it("computes total/exposed/withheld/withholdRate + the breakdowns", async () => {
    prisma.egressDecisionRow.findMany.mockResolvedValue([
      { exposed: true, decidedBy: "none", ceiling: "PUBLIC", tenantClass: "GOV" },
      { exposed: false, decidedBy: "classification", ceiling: "CUI", tenantClass: "GOV" },
      { exposed: false, decidedBy: "agentpolicy", ceiling: null, tenantClass: "GOV" },
      { exposed: true, decidedBy: "handle_mint", ceiling: "CUI", tenantClass: "GOV" },
    ]);

    const s = await egressSummary(ORG);
    expect(s.total).toBe(4);
    expect(s.exposed).toBe(2);
    expect(s.withheld).toBe(2);
    expect(s.withholdRate).toBe(0.5);
    expect(s.byDecidedBy.classification).toBe(1);
    expect(s.byDecidedBy.agentpolicy).toBe(1);
    expect(s.byDecidedBy.handle_mint).toBe(1);
    expect(s.byDecidedBy.none).toBe(1);
    // Every known reason is present (zero-baselined) so the UI renders consistently.
    for (const reason of DECIDED_BY_REASONS) {
      expect(s.byDecidedBy).toHaveProperty(reason);
    }
    expect(s.byCeiling).toEqual({ PUBLIC: 1, CUI: 2, "(none)": 1 });
    expect(s.byTenantClass).toEqual({ GOV: 4 });
  });

  it("scopes the query to the org's conversation ids", async () => {
    prisma.egressDecisionRow.findMany.mockResolvedValue([]);
    await egressSummary(ORG);
    const arg = prisma.egressDecisionRow.findMany.mock.calls[0][0];
    expect(arg.where.conversationId).toEqual({ in: ["c1", "c2"] });
  });

  it("passes the `since` lower bound through when given", async () => {
    prisma.egressDecisionRow.findMany.mockResolvedValue([]);
    const since = new Date("2026-06-01T00:00:00Z");
    await egressSummary(ORG, since);
    const arg = prisma.egressDecisionRow.findMany.mock.calls[0][0];
    expect(arg.where.createdAt).toEqual({ gte: since });
  });

  it("returns zeros (no query) when the org has no conversations", async () => {
    prisma.assistantConversation.findMany.mockResolvedValue([]);
    const s = await egressSummary(ORG);
    expect(s.total).toBe(0);
    expect(s.withholdRate).toBe(0);
    expect(prisma.egressDecisionRow.findMany).not.toHaveBeenCalled();
  });

  it("never selects message content — only structural fields", async () => {
    prisma.egressDecisionRow.findMany.mockResolvedValue([]);
    await egressSummary(ORG);
    const arg = prisma.egressDecisionRow.findMany.mock.calls[0][0];
    // The select is structural only; content/contentHash must not be requested.
    expect(arg.select).toEqual({
      exposed: true,
      decidedBy: true,
      ceiling: true,
      tenantClass: true,
    });
    expect(arg.select).not.toHaveProperty("contentHash");
    expect(arg.select).not.toHaveProperty("content");
  });
});

describe("recentDecisions — structural rows, NO contentHash / NO CUI", () => {
  it("maps rows to structural shape (seq→string, createdAt→ISO) without contentHash", async () => {
    prisma.egressDecisionRow.findMany.mockResolvedValue([
      {
        seq: 42n,
        createdAt: new Date("2026-06-07T12:00:00Z"),
        toolName: "search_work_items",
        decidedBy: "classification",
        exposed: false,
        withheldCount: 3,
        ceiling: "CUI",
        tenantClass: "GOV",
      },
    ]);

    const rows = await recentDecisions(ORG, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      seq: "42",
      createdAt: "2026-06-07T12:00:00.000Z",
      toolName: "search_work_items",
      decidedBy: "classification",
      exposed: false,
      withheldCount: 3,
      ceiling: "CUI",
      tenantClass: "GOV",
    });
    // No contentHash / no content surfaced anywhere.
    expect(JSON.stringify(rows)).not.toContain("contentHash");
    expect(rows[0]).not.toHaveProperty("contentHash");
  });

  it("does NOT request contentHash in the select", async () => {
    prisma.egressDecisionRow.findMany.mockResolvedValue([]);
    await recentDecisions(ORG, 5);
    const arg = prisma.egressDecisionRow.findMany.mock.calls[0][0];
    expect(arg.select).not.toHaveProperty("contentHash");
    expect(arg.select).not.toHaveProperty("content");
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
  });

  it("clamps the limit to [1,200] and scopes to conversation ids", async () => {
    prisma.egressDecisionRow.findMany.mockResolvedValue([]);
    await recentDecisions(ORG, 9999);
    const arg = prisma.egressDecisionRow.findMany.mock.calls[0][0];
    expect(arg.take).toBe(200);
    expect(arg.where.conversationId).toEqual({ in: ["c1", "c2"] });
  });

  it("returns [] when the org has no conversations", async () => {
    prisma.assistantConversation.findMany.mockResolvedValue([]);
    expect(await recentDecisions(ORG)).toEqual([]);
    expect(prisma.egressDecisionRow.findMany).not.toHaveBeenCalled();
  });
});

describe("auditIntegrity — chain verification + high-water marks", () => {
  function mockRaw({
    auditBreaks = [],
    egressBreaks = [],
    egressMax = null,
    checkpoint = null,
  }: {
    auditBreaks?: Array<{ broken_seq: bigint | null; reason: string }>;
    egressBreaks?: Array<{ broken_seq: bigint | null; reason: string }>;
    egressMax?: bigint | null;
    checkpoint?: bigint | null;
  }) {
    // Four $queryRaw calls in order: audit verify, egress verify, egress max(seq), checkpoint.
    prisma.$queryRaw
      .mockResolvedValueOnce(auditBreaks)
      .mockResolvedValueOnce(egressBreaks)
      .mockResolvedValueOnce([{ max_seq: egressMax }])
      .mockResolvedValueOnce([{ checkpoint_seq: checkpoint }]);
  }

  it("reports INTACT for both chains when verify returns no rows", async () => {
    mockRaw({ egressMax: 7n, checkpoint: null });
    const r = await auditIntegrity();
    expect(r.auditLogs).toBe("intact");
    expect(r.egressDecisions).toBe("intact");
    expect(r.auditLogsReason).toBeNull();
    expect(r.egressDecisionsReason).toBeNull();
    expect(r.latestWormToSeq).toBe("7");
    expect(r.latestCheckpointSeq).toBeNull();
  });

  it("reports BROKEN with the reason when verify returns a break row", async () => {
    mockRaw({
      egressBreaks: [{ broken_seq: 5n, reason: "row_hash mismatch (content tampered)" }],
      egressMax: 9n,
      checkpoint: 3n,
    });
    const r = await auditIntegrity();
    expect(r.auditLogs).toBe("intact");
    expect(r.egressDecisions).toBe("broken");
    expect(r.egressDecisionsReason).toMatch(/row_hash mismatch/);
    expect(r.latestCheckpointSeq).toBe("3");
  });
});
