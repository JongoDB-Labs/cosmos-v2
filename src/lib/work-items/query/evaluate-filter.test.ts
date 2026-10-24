// (e2e DB) The in-memory evaluator must agree with the server's where-builder.
// Seeds one project with items spread across every filter field, then for each
// filter compares `prisma.workItem.findMany({ where: buildWorkItemWhere(...) })`
// with `matchesWorkItemFilter` over the same rows. A disagreement here is a
// board showing different items from the Issues list it was saved from.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { buildWorkItemWhere } from "./build-where";
import { matchesWorkItemFilter, evaluable } from "./evaluate-filter";
import type { WorkItemFilter } from "./filter";

describe("matchesWorkItemFilter ≡ buildWorkItemWhere (e2e DB)", () => {
  let orgId = "";
  let projectId = "";
  const ids: Record<string, string> = {};
  let alice = "";
  let bob = "";
  let typeA = "";
  let typeB = "";
  let sprint = "";

  beforeAll(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    alice = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } })).id;
    bob = (await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" } })).id;
    const org = await prisma.organization.create({ data: { name: `ev ${stamp}`, slug: `ev-${stamp}` } });
    orgId = org.id;
    const project = await prisma.project.create({
      data: { orgId, name: "EV", key: `EV${stamp.slice(-4).toUpperCase()}` },
    });
    await ensureFixtureStatuses(project.id);
    projectId = project.id;
    typeA = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } })).id;
    typeB = (await prisma.workItemType.create({ data: { orgId, key: "epic", name: "Epic" } })).id;
    sprint = (
      await prisma.interval.create({
        data: { orgId, projectId, number: 1, name: "S1", startDate: new Date("2026-10-01"), endDate: new Date("2026-10-14") },
      })
    ).id;

    let n = 0;
    const mk = async (key: string, data: Record<string, unknown>, coAssignees: string[] = []) => {
      const row = await prisma.workItem.create({
        data: {
          orgId, projectId, ticketNumber: ++n, title: key, description: "", columnKey: "todo",
          workItemTypeId: typeA, createdById: alice, ...data,
        },
      });
      for (const [i, userId] of coAssignees.entries()) {
        await prisma.workItemAssignee.create({ data: { workItemId: row.id, userId, sortOrder: i } });
      }
      ids[key] = row.id;
    };
    await mk("epic", { workItemTypeId: typeB, priority: "HIGH", tags: ["platform"] });
    await mk("bug login", {
      priority: "CRITICAL", assigneeId: alice, tags: ["auth", "urgent"], intervalId: sprint,
      columnKey: "in-progress", dueDate: new Date("2026-10-09T15:00:00Z"),
      customFields: { severity: "S1", areas: ["web", "api"], blocked: true },
    });
    await mk("co-owned", { assigneeId: null, description: "Touches the LOGIN page" }, [bob]);
    await mk("child", { parentId: undefined, startDate: new Date("2026-10-02T00:00:00Z"), customFields: { blocked: false } });
    await prisma.workItem.update({ where: { id: ids["child"] }, data: { parentId: ids["epic"] } });
    await mk("old archived", { archivedAt: new Date("2026-09-01T00:00:00Z"), tags: ["auth"] });
    await mk("due end of day", { dueDate: new Date("2026-10-10T23:30:00Z"), intervalId: sprint, assigneeId: bob });
  });

  afterAll(async () => {
    if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  });

  const filters = (): [string, WorkItemFilter][] => [
    ["empty (active only)", {}],
    ["archived only", { archived: "only" }],
    ["archived all", { archived: "all" }],
    ["ids", { ids: [ids["epic"], ids["old archived"]] }],
    ["type", { typeIds: [typeB] }],
    ["status", { columnKeys: ["in-progress"] }],
    ["priorities", { priorities: ["HIGH", "CRITICAL"] }],
    ["assignee primary or co", { assigneeIds: [bob] }],
    ["unassigned", { assigneeIds: ["unassigned"] }],
    ["unassigned or alice", { assigneeIds: ["unassigned", alice] }],
    ["labels has-any", { labels: ["auth", "platform"], archived: "all" }],
    ["sprint", { intervalIds: [sprint] }],
    ["no sprint", { intervalIds: ["none"] }],
    ["sprint or none", { intervalIds: ["none", sprint] }],
    ["has parent", { parent: { mode: "has_parent" } }],
    ["no parent", { parent: { mode: "no_parent" } }],
    ["parent is", { parent: { mode: "is", parentIds: [ids["epic"]] } }],
    ["parent is empty list", { parent: { mode: "is", parentIds: [] } }],
    ["due to (date-only is end of day)", { dueDate: { to: "2026-10-10" } }],
    ["due from", { dueDate: { from: "2026-10-10" } }],
    ["start range", { startDate: { from: "2026-10-01", to: "2026-10-03" } }],
    ["created today onward", { createdAt: { from: "2000-01-01" } }],
    ["text title/description, case-insensitive", { text: "login" }],
    ["cf select", { customFields: [{ key: "severity", kind: "SELECT", value: "S1" }] }],
    ["cf multi", { customFields: [{ key: "areas", kind: "MULTI_SELECT", value: "api" }] }],
    ["cf checkbox true", { customFields: [{ key: "blocked", kind: "CHECKBOX", value: true }] }],
    ["cf checkbox false", { customFields: [{ key: "blocked", kind: "CHECKBOX", value: false }] }],
    ["combined", { priorities: ["CRITICAL"], labels: ["auth"], intervalIds: [sprint], text: "bug" }],
  ];

  it("every filter selects the same items on the server and in memory", async () => {
    const rows = await prisma.workItem.findMany({ where: { projectId }, include: { assignees: { select: { userId: true } } } });
    expect(rows).toHaveLength(6);
    for (const [name, filter] of filters()) {
      expect(evaluable(filter).ok).toBe(true);
      const server = await prisma.workItem.findMany({
        where: buildWorkItemWhere({ orgId, allowedProjectIds: [projectId], filter }),
        select: { title: true },
      });
      const memory = rows.filter((r) => matchesWorkItemFilter(r, filter));
      expect(memory.map((r) => r.title).sort(), name).toEqual(server.map((r) => r.title).sort());
    }
  });

  it("watchedByUserId is reported as not evaluable rather than guessed", () => {
    expect(evaluable({ watchedByUserId: alice }).ok).toBe(false);
  });
});
