import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/rag/embed", () => ({ storeEmbedding: vi.fn(async () => {}) }));

import { prisma } from "@/lib/db/client";
import { ingestItems } from "../items";

/** Resolve the shared e2e fixtures: test-org, its TEST project, and any user. */
async function fixtures() {
  const org = await prisma.organization.findFirst({
    where: { slug: "test-org" },
    select: { id: true },
  });
  const project = await prisma.project.findFirst({
    where: { orgId: org!.id, key: "TEST" },
    select: { id: true },
  });
  const user = await prisma.user.findFirst({ select: { id: true } });
  return { orgId: org!.id, projectId: project!.id, userId: user!.id };
}

describe("ingestItems — structured item-import (all types)", () => {
  it("creates one item of each non-roadmap type with the documented defaults", async () => {
    const { orgId, projectId, userId } = await fixtures();

    const report = await ingestItems({
      orgId,
      projectId,
      userId,
      items: [
        { type: "ISSUE", title: "Ingest issue" },
        { type: "MILESTONE", title: "Ingest milestone" },
        { type: "OBJECTIVE", title: "Ingest objective" },
        { type: "GOAL", title: "Ingest goal" },
        { type: "INTERVAL", name: "Ingest interval" },
      ],
    });

    expect(report.mode).toBe("create");
    expect(report.created).toHaveLength(5);

    const byType = Object.fromEntries(report.created.map((c) => [c.type, c]));

    // ISSUE — ticketNumber assigned + a `created` Activity row, attributed to user.
    const issue = byType.ISSUE;
    expect(issue.ticketNumber).toBeGreaterThan(0);
    const wi = await prisma.workItem.findUnique({
      where: { id: issue.id },
      select: { createdById: true, priority: true, tags: true },
    });
    expect(wi!.createdById).toBe(userId);
    expect(wi!.priority).toBe("MEDIUM");
    expect(wi!.tags).toEqual([]);
    const activity = await prisma.activity.findFirst({
      where: { workItemId: issue.id, action: "created", userId },
    });
    expect(activity).not.toBeNull();

    // MILESTONE — dueDate ~ +30 days, autoStatus true.
    const milestone = await prisma.milestone.findUnique({
      where: { id: byType.MILESTONE.id },
      select: { dueDate: true, autoStatus: true },
    });
    const days = (milestone!.dueDate.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    expect(milestone!.autoStatus).toBe(true);

    // OBJECTIVE — status ACTIVE, progress 0.
    const objective = await prisma.objective.findUnique({
      where: { id: byType.OBJECTIVE.id },
      select: { status: true, progress: true },
    });
    expect(objective!.status).toBe("ACTIVE");
    expect(objective!.progress).toBe(0);

    // GOAL — status PLANNED, progressMode MANUAL, progress 0.
    const goal = await prisma.goal.findUnique({
      where: { id: byType.GOAL.id },
      select: { status: true, progressMode: true, progress: true },
    });
    expect(goal!.status).toBe("PLANNED");
    expect(goal!.progressMode).toBe("MANUAL");
    expect(goal!.progress).toBe(0);

    // INTERVAL — number > 0, ~2-week window, SPRINT kind, default empty goal.
    const interval = await prisma.interval.findUnique({
      where: { id: byType.INTERVAL.id },
      select: { number: true, startDate: true, endDate: true, intervalKind: true, goal: true },
    });
    expect(interval!.number).toBeGreaterThan(0);
    expect(interval!.intervalKind).toBe("SPRINT");
    expect(interval!.goal).toBe("");
    const windowDays = (interval!.endDate.getTime() - interval!.startDate.getTime()) / 86_400_000;
    expect(windowDays).toBeGreaterThan(13);
    expect(windowDays).toBeLessThan(15);

    // Cleanup.
    await prisma.workItem.delete({ where: { id: byType.ISSUE.id } });
    await prisma.milestone.delete({ where: { id: byType.MILESTONE.id } });
    await prisma.objective.delete({ where: { id: byType.OBJECTIVE.id } });
    await prisma.goal.delete({ where: { id: byType.GOAL.id } });
    await prisma.interval.delete({ where: { id: byType.INTERVAL.id } });
  });

  it("honors provided values over defaults", async () => {
    const { orgId, projectId, userId } = await fixtures();

    const report = await ingestItems({
      orgId,
      projectId,
      userId,
      items: [
        {
          type: "ISSUE",
          title: "High-priority tagged issue",
          priority: "HIGH",
          tags: ["alpha", "beta"],
          description: "body text",
        },
        { type: "GOAL", title: "At-risk auto goal", status: "AT_RISK", progressMode: "AUTO" },
      ],
    });

    const byType = Object.fromEntries(report.created.map((c) => [c.type, c]));
    const wi = await prisma.workItem.findUnique({
      where: { id: byType.ISSUE.id },
      select: { priority: true, tags: true, description: true },
    });
    expect(wi!.priority).toBe("HIGH");
    expect(wi!.tags).toEqual(["alpha", "beta"]);
    expect(wi!.description).toBe("body text");

    const goal = await prisma.goal.findUnique({
      where: { id: byType.GOAL.id },
      select: { status: true, progressMode: true },
    });
    expect(goal!.status).toBe("AT_RISK");
    expect(goal!.progressMode).toBe("AUTO");

    await prisma.workItem.delete({ where: { id: byType.ISSUE.id } });
    await prisma.goal.delete({ where: { id: byType.GOAL.id } });
  });

  it("batches ROADMAP_NODE items into a single roadmap upsert", async () => {
    const { orgId, projectId, userId } = await fixtures();

    const report = await ingestItems({
      orgId,
      projectId,
      userId,
      items: [
        {
          type: "ROADMAP_NODE",
          kind: "SECTION",
          title: "Ingest roadmap section",
          externalRef: "ING-S-1",
          body: "Section body.",
        },
      ],
    });

    expect(report.roadmap).toBeDefined();
    expect(report.roadmap!.total).toBe(1);
    expect(report.roadmap!.created).toBe(1);

    const node = await prisma.roadmapNode.findFirst({
      where: { orgId, projectId, externalRef: "ING-S-1" },
      select: { id: true, kind: true, title: true },
    });
    expect(node).not.toBeNull();
    expect(node!.kind).toBe("SECTION");

    await prisma.roadmapNode.delete({ where: { id: node!.id } });
  });

  it("rejects items for a project that does not belong to the org", async () => {
    const { orgId, userId } = await fixtures();
    await expect(
      ingestItems({
        orgId,
        projectId: "00000000-0000-0000-0000-000000000000",
        userId,
        items: [{ type: "ISSUE", title: "orphan" }],
      }),
    ).rejects.toThrow();
  });
});
