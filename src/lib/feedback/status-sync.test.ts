import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { createFixtureWorkItem } from "@/lib/testing/db-fixtures";
import { feedbackStatusForColumn, syncFeedbackForWorkItems } from "./status-sync";

describe("feedbackStatusForColumn", () => {
  it("maps the canonical kanban columns", () => {
    expect(feedbackStatusForColumn("backlog")).toBe("PLANNED");
    expect(feedbackStatusForColumn("in-progress")).toBe("IN_PROGRESS");
    expect(feedbackStatusForColumn("review")).toBe("IN_REVIEW");
    expect(feedbackStatusForColumn("done")).toBe("DONE");
  });

  it("handles custom column names via the same heuristics interval-complete uses", () => {
    expect(feedbackStatusForColumn("Completed ✅".toLowerCase())).toBe("DONE");
    expect(feedbackStatusForColumn("closed-wont-fix")).toBe("DONE");
    expect(feedbackStatusForColumn("Doing")).toBe("IN_PROGRESS");
    expect(feedbackStatusForColumn("QA Testing")).toBe("IN_PROGRESS");
    expect(feedbackStatusForColumn("In Review")).toBe("IN_REVIEW");
    expect(feedbackStatusForColumn("To-Do")).toBe("PLANNED");
    expect(feedbackStatusForColumn("triage")).toBe("PLANNED");
  });

  it("returns null (no opinion) for unknown columns", () => {
    expect(feedbackStatusForColumn("someday-maybe")).toBeNull();
    expect(feedbackStatusForColumn("")).toBeNull();
  });
});

describe("syncFeedbackForWorkItems (e2e DB)", () => {
  const created: { workItemIds: string[]; feedbackIds: string[] } = { workItemIds: [], feedbackIds: [] };

  afterAll(async () => {
    await prisma.feedbackItem.deleteMany({ where: { id: { in: created.feedbackIds } } }).catch(() => undefined);
    await prisma.workItem.deleteMany({ where: { id: { in: created.workItemIds } } }).catch(() => undefined);
  });

  async function fixture(columnKey: string, feedbackStatus: "PLANNED" | "DECLINED") {
    const org = await prisma.organization.findFirstOrThrow({ where: { slug: "test-org" } });
    const project = await prisma.project.findFirstOrThrow({ where: { orgId: org.id } });
    const type = await prisma.workItemType.findFirstOrThrow({
      where: { OR: [{ orgId: org.id }, { orgId: null }] },
    });
    const author = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    // Via the shared helper: computing `max + 1` inline races another spec file
    // doing the same thing in a parallel worker against the same project, and
    // the loser gets a unique-constraint failure on (org, project, ticket).
    const wi = await createFixtureWorkItem({
      orgId: org.id,
      projectId: project.id,
      workItemTypeId: type.id,
      createdById: author.id,
      title: `status-sync fixture ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      columnKey,
    });
    const fb = await prisma.feedbackItem.create({
      data: {
        orgId: org.id,
        type: "FEATURE",
        title: `status-sync feedback ${wi.id}`,
        description: "",
        status: feedbackStatus,
        authorId: author.id,
        workItemId: wi.id,
        deliveredAt: new Date(),
      },
    });
    created.workItemIds.push(wi.id);
    created.feedbackIds.push(fb.id);
    return { wi, fb };
  }

  it("follows the work item's column: done → DONE, review → IN_REVIEW", async () => {
    const a = await fixture("done", "PLANNED");
    const b = await fixture("review", "PLANNED");
    await syncFeedbackForWorkItems([a.wi.id, b.wi.id]);
    const fa = await prisma.feedbackItem.findUniqueOrThrow({ where: { id: a.fb.id } });
    const fb = await prisma.feedbackItem.findUniqueOrThrow({ where: { id: b.fb.id } });
    expect(fa.status).toBe("DONE");
    expect(fb.status).toBe("IN_REVIEW");
  });

  it("never overwrites a human DECLINED", async () => {
    const d = await fixture("done", "DECLINED");
    await syncFeedbackForWorkItems([d.wi.id]);
    const fd = await prisma.feedbackItem.findUniqueOrThrow({ where: { id: d.fb.id } });
    expect(fd.status).toBe("DECLINED");
  });

  it("is a no-op for ids with no linked feedback and never throws", async () => {
    await expect(syncFeedbackForWorkItems(["00000000-0000-0000-0000-000000000000"])).resolves.toBeUndefined();
    await expect(syncFeedbackForWorkItems([])).resolves.toBeUndefined();
  });
});
