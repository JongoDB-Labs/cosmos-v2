import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import type { Prisma } from "@prisma/client";

/**
 * Guardrail coverage for the fallback classifier — this is what runs when AI
 * triage is unavailable, so the auto-remediation loop keeps delivering feedback
 * into the backlog even with no model configured (the common case for a fresh
 * org). `resolveDeliveryTarget` (pure) and the full `runFeedbackRemediation`
 * loop (routing, delivery, idempotency, config gating) are covered against the
 * real e2e DB further down in this file.
 */

// The AI egress + credential gate are the only true I/O boundaries
// `runFeedbackRemediation` has besides Prisma itself — mocked so the e2e tests
// below are deterministic and never attempt a real model call. `runModelTurn`
// is made to reject so every triage exercises the REAL (unmocked)
// `heuristicTriage` fallback, same as a transient model outage in prod.
const { getAiProviderStatus, runModelTurn } = vi.hoisted(() => ({
  getAiProviderStatus: vi.fn(),
  runModelTurn: vi.fn(),
}));

vi.mock("@/lib/ai/ai-credentials", () => ({ getAiProviderStatus }));
vi.mock("@/lib/ai/egress", () => ({ runModelTurn }));
vi.mock("@/lib/integrations/teams-notify", () => ({ teamsNotify: vi.fn(async () => {}) }));

import { prisma } from "@/lib/db/client";
import { heuristicTriage, resolveDeliveryTarget, runFeedbackRemediation } from "./remediate";

describe("heuristicTriage — AI-unavailable fallback", () => {
  it("keeps a bug a BUG and raises severity when there's an error signature", () => {
    const t = heuristicTriage({
      type: "BUG",
      telemetry: { stack: "TypeError: x is undefined", route: "/issues" },
    });
    expect(t.classification).toBe("BUG");
    expect(t.severity).toBe("high");
    expect(t.source).toBe("heuristic");
  });

  it("a bug WITHOUT error telemetry stays medium", () => {
    const t = heuristicTriage({ type: "BUG", telemetry: {} });
    expect(t.classification).toBe("BUG");
    expect(t.severity).toBe("medium");
  });

  it("treats errorSignature / digest as an error signal too", () => {
    expect(heuristicTriage({ type: "BUG", telemetry: { errorSignature: "abc" } }).severity).toBe("high");
    expect(heuristicTriage({ type: "BUG", telemetry: { digest: "123" } }).severity).toBe("high");
  });

  it("a feature request is FEATURE / medium regardless of telemetry", () => {
    const t = heuristicTriage({ type: "FEATURE", telemetry: { stack: "noise" } });
    expect(t.classification).toBe("FEATURE");
    expect(t.severity).toBe("medium");
  });

  it("tolerates null/odd telemetry without throwing", () => {
    expect(() => heuristicTriage({ type: "FEATURE", telemetry: null })).not.toThrow();
    expect(heuristicTriage({ type: "FEATURE", telemetry: null }).acceptanceCriteria).toEqual([]);
  });
});

describe("resolveDeliveryTarget — per-item routing (pure)", () => {
  it("routes to the item's own project when that project is in scope", () => {
    expect(resolveDeliveryTarget("p1", ["p1", "p2"], "p2")).toBe("p1");
  });

  it("falls back to the org default when the item has no project", () => {
    expect(resolveDeliveryTarget(null, ["p1", "p2"], "p2")).toBe("p2");
  });

  it("falls back to the org default when the item's project is out of scope", () => {
    expect(resolveDeliveryTarget("p3", ["p1", "p2"], "p2")).toBe("p2");
  });

  it("returns null (skip) when there is no default and no in-scope project to use", () => {
    expect(resolveDeliveryTarget(null, ["p1", "p2"], null)).toBeNull();
    expect(resolveDeliveryTarget("p3", ["p1", "p2"], null)).toBeNull();
  });

  it("returns null (skip) when the configured default is itself out of scope", () => {
    expect(resolveDeliveryTarget(null, ["p1", "p2"], "p9")).toBeNull();
    expect(resolveDeliveryTarget("p3", ["p1", "p2"], "p9")).toBeNull();
  });
});

/**
 * Full-loop coverage against the real e2e DB (seeded `test-org` / `TEST`
 * project fixtures — see `DATABASE_URL` in the e2e env). Exercises routing,
 * delivery, and idempotency end-to-end; only the AI egress is mocked (above).
 *
 * Two extra projects are created once for the suite: `RTSCOPE` (a second
 * in-scope target, WITH a usable TODO column) and `RTOUT` (a real project
 * that's deliberately never added to `projectIds`, standing in for "some
 * other project in this org that this automation run doesn't cover"). Both
 * are torn down in `afterAll`; every feedback/work item a test creates is
 * torn down in that test's own `finally` so a failed assertion never leaves
 * the shared e2e DB dirty for the next run.
 */
describe("runFeedbackRemediation — per-item multi-project routing (e2e)", () => {
  const TITLE_PREFIX = "[routing-test]";
  const SCOPE_KEY = "RTSCOPE";
  const OUTSIDE_KEY = "RTOUT";

  let orgId: string;
  let userId: string;
  let mainProjectId: string;
  let mainProjectKey: string;
  let secondProjectId: string;
  let secondProjectKey: string;
  let outsideProjectId: string;
  let originalSettings: Prisma.JsonValue;

  async function purgeStaleFixtures(id: string) {
    const stale = await prisma.project.findMany({
      where: { orgId: id, key: { in: [SCOPE_KEY, OUTSIDE_KEY] } },
      select: { id: true },
    });
    for (const p of stale) {
      await prisma.workItem.deleteMany({ where: { projectId: p.id } });
      await prisma.project.delete({ where: { id: p.id } });
    }
    await prisma.feedbackItem.deleteMany({ where: { orgId: id, title: { startsWith: TITLE_PREFIX } } });
  }

  async function createProjectWithBoard(id: string, key: string) {
    return prisma.project.create({
      data: {
        orgId: id,
        key,
        name: `Routing test — ${key}`,
        boards: {
          create: {
            orgId: id,
            name: "Board",
            type: "KANBAN",
            sortOrder: 0,
            columns: { create: [{ name: "To Do", key: "todo", category: "TODO", sortOrder: 0 }] },
          },
        },
      },
      select: { id: true, key: true },
    });
  }

  async function setAutoRemediationConfig(cfg: {
    enabled: boolean;
    projectIds: string[];
    defaultProjectId: string | null;
  }) {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { settings: true },
    });
    const settings = (org.settings ?? {}) as Record<string, unknown>;
    await prisma.organization.update({
      where: { id: orgId },
      data: { settings: { ...settings, autoRemediation: cfg } },
    });
  }

  beforeAll(async () => {
    getAiProviderStatus.mockResolvedValue({
      provider: "anthropic",
      anthropic: { configured: false },
      openai: { configured: false, baseUrl: undefined, model: undefined },
      claudeOAuth: { connected: true },
    });
    runModelTurn.mockRejectedValue(new Error("AI egress disabled in tests — heuristic fallback expected"));

    const org = await prisma.organization.findFirstOrThrow({
      where: { slug: "test-org" },
      select: { id: true, settings: true },
    });
    orgId = org.id;
    originalSettings = org.settings;

    await purgeStaleFixtures(orgId);

    const mainProject = await prisma.project.findFirstOrThrow({
      where: { orgId, key: "TEST" },
      select: { id: true, key: true },
    });
    mainProjectId = mainProject.id;
    mainProjectKey = mainProject.key;

    const user = await prisma.user.findFirstOrThrow({ select: { id: true } });
    userId = user.id;

    const second = await createProjectWithBoard(orgId, SCOPE_KEY);
    secondProjectId = second.id;
    secondProjectKey = second.key;

    const outside = await prisma.project.create({
      data: { orgId, key: OUTSIDE_KEY, name: "Routing test — outside scope" },
      select: { id: true },
    });
    outsideProjectId = outside.id;
  });

  afterAll(async () => {
    await prisma.organization.update({
      where: { id: orgId },
      data: { settings: originalSettings as unknown as Prisma.InputJsonValue },
    });
    await prisma.project.delete({ where: { id: secondProjectId } }); // cascades board + columns
    await prisma.project.delete({ where: { id: outsideProjectId } });
  });

  it("routes items with different in-scope projectIds into their own project's backlog", async () => {
    await setAutoRemediationConfig({
      enabled: true,
      projectIds: [mainProjectId, secondProjectId],
      defaultProjectId: mainProjectId,
    });
    const titleA = `${TITLE_PREFIX} own-project A`;
    const titleB = `${TITLE_PREFIX} own-project B`;
    const itemA = await prisma.feedbackItem.create({
      data: { orgId, authorId: userId, type: "BUG", title: titleA, projectId: mainProjectId },
      select: { id: true },
    });
    const itemB = await prisma.feedbackItem.create({
      data: { orgId, authorId: userId, type: "FEATURE", title: titleB, projectId: secondProjectId },
      select: { id: true },
    });

    try {
      const summary = await runFeedbackRemediation(orgId, { actorUserId: userId, limit: 10 });

      expect(summary.delivered).toBe(2);
      expect(summary.skippedNoTarget).toBe(0);

      const deliveredA = summary.items.find((i) => i.feedbackId === itemA.id);
      const deliveredB = summary.items.find((i) => i.feedbackId === itemB.id);
      expect(deliveredA).toBeDefined();
      expect(deliveredB).toBeDefined();
      expect(deliveredA!.ticketKey.startsWith(`${mainProjectKey}-`)).toBe(true);
      expect(deliveredB!.ticketKey.startsWith(`${secondProjectKey}-`)).toBe(true);

      const wiA = await prisma.workItem.findUniqueOrThrow({
        where: { id: deliveredA!.workItemId },
        select: { projectId: true },
      });
      const wiB = await prisma.workItem.findUniqueOrThrow({
        where: { id: deliveredB!.workItemId },
        select: { projectId: true },
      });
      expect(wiA.projectId).toBe(mainProjectId);
      expect(wiB.projectId).toBe(secondProjectId);
    } finally {
      await prisma.workItem.deleteMany({ where: { orgId, title: { in: [titleA, titleB] } } });
      await prisma.feedbackItem.deleteMany({ where: { id: { in: [itemA.id, itemB.id] } } });
    }
  });

  it("routes a null-projectId item to the org default", async () => {
    await setAutoRemediationConfig({
      enabled: true,
      projectIds: [mainProjectId, secondProjectId],
      defaultProjectId: mainProjectId,
    });
    const title = `${TITLE_PREFIX} null-to-default`;
    const item = await prisma.feedbackItem.create({
      data: { orgId, authorId: userId, type: "FEATURE", title, projectId: null },
      select: { id: true },
    });

    try {
      const summary = await runFeedbackRemediation(orgId, { actorUserId: userId, limit: 10 });

      expect(summary.delivered).toBe(1);
      const delivered = summary.items.find((i) => i.feedbackId === item.id);
      expect(delivered).toBeDefined();
      expect(delivered!.ticketKey.startsWith(`${mainProjectKey}-`)).toBe(true);

      const wi = await prisma.workItem.findUniqueOrThrow({
        where: { id: delivered!.workItemId },
        select: { projectId: true },
      });
      expect(wi.projectId).toBe(mainProjectId);
    } finally {
      await prisma.workItem.deleteMany({ where: { orgId, title } });
      await prisma.feedbackItem.deleteMany({ where: { id: item.id } });
    }
  });

  it("routes an out-of-scope item to the org default when one is configured", async () => {
    await setAutoRemediationConfig({
      enabled: true,
      projectIds: [mainProjectId],
      defaultProjectId: mainProjectId,
    });
    const title = `${TITLE_PREFIX} outside-to-default`;
    const item = await prisma.feedbackItem.create({
      data: { orgId, authorId: userId, type: "BUG", title, projectId: outsideProjectId },
      select: { id: true },
    });

    try {
      const summary = await runFeedbackRemediation(orgId, { actorUserId: userId, limit: 10 });

      expect(summary.delivered).toBe(1);
      expect(summary.skippedNoTarget).toBe(0);
      const delivered = summary.items.find((i) => i.feedbackId === item.id);
      expect(delivered).toBeDefined();

      const wi = await prisma.workItem.findUniqueOrThrow({
        where: { id: delivered!.workItemId },
        select: { projectId: true },
      });
      expect(wi.projectId).toBe(mainProjectId);
    } finally {
      await prisma.workItem.deleteMany({ where: { orgId, title } });
      await prisma.feedbackItem.deleteMany({ where: { id: item.id } });
    }
  });

  it("skips (and counts) an out-of-scope item when no default is configured, without triaging it", async () => {
    await setAutoRemediationConfig({
      enabled: true,
      projectIds: [mainProjectId],
      defaultProjectId: null,
    });
    const title = `${TITLE_PREFIX} outside-no-default`;
    const item = await prisma.feedbackItem.create({
      data: { orgId, authorId: userId, type: "BUG", title, projectId: outsideProjectId },
      select: { id: true },
    });

    try {
      const callsBefore = runModelTurn.mock.calls.length;
      const summary = await runFeedbackRemediation(orgId, { actorUserId: userId, limit: 10 });

      expect(summary.delivered).toBe(0);
      expect(summary.skippedNoTarget).toBe(1);
      expect(summary.items.find((i) => i.feedbackId === item.id)).toBeUndefined();
      // Routing is resolved BEFORE triage — a skipped item must never reach the
      // (expensive) AI call.
      expect(runModelTurn.mock.calls.length).toBe(callsBefore);

      const refreshed = await prisma.feedbackItem.findUniqueOrThrow({
        where: { id: item.id },
        select: { deliveredAt: true, workItemId: true, status: true },
      });
      expect(refreshed.deliveredAt).toBeNull();
      expect(refreshed.workItemId).toBeNull();
      expect(refreshed.status).toBe("OPEN");
    } finally {
      await prisma.feedbackItem.deleteMany({ where: { id: item.id } });
    }
  });

  it("is idempotent — a second run does not re-deliver an already-delivered item", async () => {
    await setAutoRemediationConfig({
      enabled: true,
      projectIds: [mainProjectId],
      defaultProjectId: mainProjectId,
    });
    const title = `${TITLE_PREFIX} idempotency`;
    const item = await prisma.feedbackItem.create({
      data: { orgId, authorId: userId, type: "BUG", title, projectId: mainProjectId },
      select: { id: true },
    });

    try {
      const first = await runFeedbackRemediation(orgId, { actorUserId: userId, limit: 10 });
      expect(first.delivered).toBe(1);
      const delivered = first.items.find((i) => i.feedbackId === item.id);
      expect(delivered).toBeDefined();

      const second = await runFeedbackRemediation(orgId, { actorUserId: userId, limit: 10 });
      expect(second.delivered).toBe(0);
      expect(second.items.find((i) => i.feedbackId === item.id)).toBeUndefined();

      const refreshed = await prisma.feedbackItem.findUniqueOrThrow({
        where: { id: item.id },
        select: { workItemId: true },
      });
      expect(refreshed.workItemId).toBe(delivered!.workItemId);

      const wiCount = await prisma.workItem.count({ where: { orgId, title } });
      expect(wiCount).toBe(1);
    } finally {
      await prisma.workItem.deleteMany({ where: { orgId, title } });
      await prisma.feedbackItem.deleteMany({ where: { id: item.id } });
    }
  });
});
