// @vitest-environment node
//
// createFixtureWorkItem against the REAL e2e DB: it must never take a ticket
// number a production writer is about to use. Production allocates under the
// project's advisory lock and does not retry, so the fixture has to take the
// same lock; a fixture that merely retries wins the race and the PRODUCT path
// is the one that fails.
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { allocateTicketNumber } from "@/lib/work-items/allocate";
import { createWorkItemRow } from "@/lib/work-items/write.server";
import { createFixtureWorkItem, ensureFixtureStatuses } from "./db-fixtures";

let orgId: string | undefined;

afterAll(async () => {
  if (orgId) await prisma.organization.delete({ where: { id: orgId } });
});

describe("createFixtureWorkItem (e2e DB)", () => {
  it("shares ticket allocation with production writers, so neither side collides", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    orgId = (await prisma.organization.create({ data: { name: `fixture-lock ${stamp}`, slug: `fixture-lock-${stamp}` } })).id;
    const project = await prisma.project.create({ data: { orgId, name: "P", key: "FXL" } });
    await ensureFixtureStatuses(project.id, ["todo"]);
    const user = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } });
    const base = { orgId, projectId: project.id, workItemTypeId: type.id, createdById: user.id, columnKey: "todo" };

    // The production shape (convert, the work-items route): allocate and insert
    // in one transaction, no retry.
    const product = (n: number) =>
      prisma.$transaction(async (tx) => {
        const ticketNumber = await allocateTicketNumber(tx, { orgId: base.orgId, projectId: base.projectId });
        return createWorkItemRow(
          tx,
          { data: { ...base, title: `product ${n}`, description: "", ticketNumber } },
          { actorId: null, source: "SYSTEM" },
        );
      });
    const fixture = (n: number) => createFixtureWorkItem({ ...base, title: `fixture ${n}` });

    const N = 12;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, n) => (n % 2 ? product(n) : fixture(n))),
    );
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason).slice(0, 120))).toEqual([]);
    const numbers = (await prisma.workItem.findMany({ where: { projectId: project.id }, select: { ticketNumber: true } }))
      .map((w) => w.ticketNumber)
      .sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });
});
