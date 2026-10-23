// (e2e DB) The legacy filter builder and CQL (via fromWorkItemFilter) must
// return the same page and total for every legacy filter. This is what the
// dark-ship parity check measures on live traffic; here it is pinned before
// anything ships.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { compareWithCql } from "../parity.server";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { runWorkItemQuery } from "@/lib/work-items/query/project";
import type { WorkItemFilter, WorkItemSort } from "@/lib/work-items/query/filter";
import { seedWorld, type World } from "./cql-fixture";

describe("legacy filter ≡ CQL (e2e DB)", () => {
  let w: World;
  beforeAll(async () => {
    w = await seedWorld();
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
  });

  const cases = (): [string, WorkItemFilter, WorkItemSort?][] => [
    ["empty", {}],
    ["archived only", { archived: "only" }],
    ["archived all", { archived: "all" }],
    ["project", { projectIds: [w.P1.id] }],
    ["unreadable project intersects to nothing", { projectIds: [w.P2.id] }],
    ["mixed projects", { projectIds: [w.P2.id, w.P3.id] }],
    ["ids", { ids: [w.items["p1-done"].id, w.items["p1-child"].id] }],
    ["type", { typeIds: [w.typeBug] }],
    ["status", { columnKeys: ["review", "done"] }],
    ["priorities", { priorities: ["HIGH", "CRITICAL"] }],
    ["assignee", { assigneeIds: [w.bob.id] }],
    ["unassigned", { assigneeIds: ["unassigned"] }],
    ["unassigned or me", { assigneeIds: ["unassigned", w.actor.id] }],
    ["labels (names)", { labels: ["auth", "urgent"] }],
    ["sprint", { intervalIds: [w.sprintP1Active] }],
    ["no sprint", { intervalIds: ["none"] }],
    ["sprint or none", { intervalIds: ["none", w.sprintP1Done] }],
    ["has parent", { parent: { mode: "has_parent" } }],
    ["no parent", { parent: { mode: "no_parent" } }],
    ["parent is", { parent: { mode: "is", parentIds: [w.items["p1-login-bug"].id] } }],
    ["parent is empty list", { parent: { mode: "is", parentIds: [] } }],
    ["due to (date only, inclusive)", { dueDate: { to: "2026-10-20" } }],
    ["due from", { dueDate: { from: "2026-10-21" } }],
    ["created from", { createdAt: { from: "2000-01-01" } }],
    ["text in title or description", { text: "login" }],
    ["watched by me", { watchedByUserId: w.actor.id }],
    ["custom field", { customFields: [{ key: `sev_${w.stamp}`, kind: "SELECT", value: "S1" }] }],
    ["combined", { priorities: ["CRITICAL"], labels: ["auth"], assigneeIds: [w.actor.id] }],
    ["sorted by priority asc", {}, { field: "priority", direction: "asc" }],
    ["sorted by ticket desc", { projectIds: [w.P1.id] }, { field: "ticketNumber", direction: "desc" }],
  ];

  it("every legacy filter returns the same page and total through CQL", async () => {
    const ctx = w.ctx();
    const allowedProjectIds = await getReadableProjectIds(ctx);
    for (const [name, filter, sort] of cases()) {
      const legacy = await runWorkItemQuery({ orgId: w.orgA, allowedProjectIds, filter, sort, page: 1, pageSize: 100 });
      const o = await compareWithCql(ctx, { filter, sort, page: 1, pageSize: 100 }, legacy);
      expect(o, name).toMatchObject({ match: true, missing: 0, extra: 0 });
      expect(o.error, name).toBeUndefined();
    }
  });
});
