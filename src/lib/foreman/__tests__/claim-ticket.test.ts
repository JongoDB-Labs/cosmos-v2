// DB-backed (real e2e DB, no mocks besides the fixtures themselves) coverage for
// claimTicket in scripts/foreman/db.mts: the atomic backlog/todo -> in-progress
// claim a build worker uses before dispatch. Mirrors fresh-mentions.test.ts's
// harness — a dedicated THROWAWAY org+project per test (vitest runs test FILES in
// parallel against the same e2e DB, and a shared project's ticketNumber allocation
// races across files), cleaned up in `finally`. claimTicket doesn't read org
// settings (unlike freshMentions -> deliveryProjects), so there's no
// autonomousDelivery config to seed here.
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/client";
import { claimTicket } from "../../../../scripts/foreman/db.mjs";

describe("claimTicket — atomic backlog/todo -> in-progress claim", () => {
  it("claims from todo and from backlog, loses a second claim on an already-claimed item, and never claims an in-progress item", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" }, select: { id: true } });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null }, select: { id: true } });

    const org = await prisma.organization.create({
      data: { name: `claim-ticket-test-${stamp}`, slug: `claim-ticket-test-${stamp}` },
    });
    const orgId = org.id;
    const orgIds = [orgId]; // cleanup tracker (deleteMany at the end; cascades org_members + project)

    const project = await prisma.project.create({
      data: { orgId, name: "Claim Ticket Test", key: `CT${stamp.slice(-6).toUpperCase()}` },
    });
    const projectId = project.id;

    async function createItem(columnKey: string, ticketNumber: number, suffix: string) {
      return prisma.workItem.create({
        data: {
          orgId,
          projectId,
          ticketNumber,
          title: `[claim-ticket-test] ${columnKey} ${stamp}-${suffix}`,
          description: "",
          columnKey,
          workItemTypeId: type.id,
          createdById: alice.id,
        },
      });
    }

    const itemIds: string[] = [];

    try {
      // Case 1: a todo-column item is claimable — this is the bug fix under test.
      // claimTicket used to hardcode `columnKey: "backlog"`, so a todo-column item
      // could never be won (count always 0) even though todo is a TODO_COLUMNS
      // member and pickNext could hand it out.
      const todoItem = await createItem("todo", 1, "todo");
      itemIds.push(todoItem.id);
      expect(await claimTicket(todoItem.id)).toBe(true);
      const claimedTodo = await prisma.workItem.findUniqueOrThrow({
        where: { id: todoItem.id },
        select: { columnKey: true },
      });
      expect(claimedTodo.columnKey).toBe("in-progress");

      // Case 2: backlog is still claimable (the fallback pool) — unchanged.
      const backlogItem = await createItem("backlog", 2, "backlog");
      itemIds.push(backlogItem.id);
      expect(await claimTicket(backlogItem.id)).toBe(true);
      const claimedBacklog = await prisma.workItem.findUniqueOrThrow({
        where: { id: backlogItem.id },
        select: { columnKey: true },
      });
      expect(claimedBacklog.columnKey).toBe("in-progress");

      // Case 3: a second, concurrent-style claim on the SAME item (now
      // in-progress from case 1) loses — proves the updateMany count-as-winner
      // guard against a real row, not just the where clause shape.
      expect(await claimTicket(todoItem.id)).toBe(false);

      // Case 4: an item that starts in-progress (never backlog/todo) is never
      // claimable.
      const inProgressItem = await createItem("in-progress", 3, "inprogress");
      itemIds.push(inProgressItem.id);
      expect(await claimTicket(inProgressItem.id)).toBe(false);
    } finally {
      // work_items has no FK to organizations/projects (plain denormalized
      // columns), so the org delete below won't cascade to these — clean up
      // explicitly first.
      await prisma.workItem.deleteMany({ where: { id: { in: itemIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    }
  });
});
