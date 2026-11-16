// @vitest-environment node
//
// (e2e DB) The 20261116120000_work_item_assignee_fk migration, run for real.
//
// work_items.assignee_id gained a foreign key added NOT VALID, and some
// databases hold items whose assignee is no user. NOT VALID does not make such
// a row safe to edit: Postgres skips the check on an unchanged key only for a
// row not already written in the same transaction, and an edit that writes the
// row twice (labels, then the rest) is checked the second time. So the
// migration clears those assignees as it adds the key, and records which.
//
// Every row asserted on is one this file made, in the seeded test-org; the
// cleanup runs inside a transaction that is rolled back, so it never touches
// another file's rows for good.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { applyWorkItemChange } from "@/lib/work-items/apply-change.server";
import type { Prisma } from "@prisma/client";

const sql = (name: string) => readFileSync(path.join(process.cwd(), "prisma/migrations", name, "migration.sql"), "utf8");
const ADD = sql("20261116120000_work_item_assignee_fk");
const VALIDATE = sql("20261116120100_validate_work_item_assignee_fk");
/** The SQL with its comments gone. */
const code = (s: string) => s.replace(/--[^\n]*/g, "").trim();

describe("work_item_assignee_fk: shape", () => {
  it("each file is one DO block, so `prisma migrate deploy` cannot commit part of it", () => {
    for (const s of [ADD, VALIDATE]) {
      expect(code(s).startsWith("DO $$")).toBe(true);
      expect(code(s).endsWith("END $$;")).toBe(true);
      expect(code(s).split("$$")).toHaveLength(3);
    }
  });

  it("adds the key first, then clears what it would refuse, and writes the audit row last", () => {
    const c = code(ADD);
    const at = (needle: string) => {
      expect(c, needle).toContain(needle);
      return c.indexOf(needle);
    };
    const add = at('ADD CONSTRAINT "work_items_assignee_id_fkey"');
    const clear = at('UPDATE "work_items"');
    const audit = at("INSERT INTO audit_logs");
    expect(add).toBeLessThan(clear);
    expect(clear).toBeLessThan(audit);
    expect(c.lastIndexOf("INSERT INTO")).toBe(audit);
    // The key is added NOT VALID; validating is the next migration's.
    expect(c).toContain("NOT VALID");
    expect(c).not.toContain("VALIDATE CONSTRAINT");
  });

  it("validates the key only when it isn't yet, so a second run is a no-op", () => {
    const c = code(VALIDATE);
    expect(c).toContain("convalidated");
    expect(c).toContain('VALIDATE CONSTRAINT "work_items_assignee_id_fkey"');
  });
});

describe("work_item_assignee_fk: an item whose assignee is no user", () => {
  let orgId = "";
  let projectId = "";
  let itemId = "";
  let actorId = "";
  const noUser = randomUUID();

  beforeAll(async () => {
    const org = await prisma.organization.findFirstOrThrow({ where: { slug: "test-org" }, select: { id: true } });
    orgId = org.id;
    actorId = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" }, select: { id: true } })).id;
    const type = await prisma.workItemType.findFirstOrThrow({
      where: { OR: [{ orgId }, { orgId: null }] },
      orderBy: { orgId: { sort: "asc", nulls: "last" } },
      select: { id: true },
    });
    const s = randomUUID().slice(0, 6).toUpperCase();
    projectId = (await prisma.project.create({ data: { orgId, name: `Assignee key ${s}`, key: `AK${s}` }, select: { id: true } })).id;
    await prisma.workflowStatus.create({ data: { orgId, projectId, key: "todo", name: "To do", category: "TODO" } });
    itemId = (
      await prisma.workItem.create({
        data: { orgId, projectId, title: "Old row", columnKey: "todo", ticketNumber: 1, createdById: actorId, workItemTypeId: type.id },
        select: { id: true },
      })
    ).id;
    // As on a database older than the key: written past it, and committed.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw`UPDATE work_items SET assignee_id = ${noUser}::uuid WHERE id = ${itemId}::uuid`;
    });
  });

  afterAll(async () => {
    if (projectId) await prisma.project.delete({ where: { id: projectId } });
  });

  const edit = (tx: Prisma.TransactionClient, patch: { title: string; tags?: string[] }) =>
    applyWorkItemChange(tx, { actorId, orgId, projectId, itemIds: [itemId], patch, source: "API", actor: null });
  const assigneeOf = async () => (await prisma.workItem.findUniqueOrThrow({ where: { id: itemId }, select: { assigneeId: true } })).assigneeId;

  it("left alone, an edit that writes the row twice fails on the key, though one that writes it once does not", async () => {
    expect(await assigneeOf()).toBe(noUser);
    // One write, key unchanged: Postgres skips the check.
    await prisma.$transaction((tx) => edit(tx, { title: "Renamed" }));
    // Labels, then the rest: the second write of the row is checked.
    await expect(prisma.$transaction((tx) => edit(tx, { title: "Renamed again", tags: ["key-check"] }))).rejects.toMatchObject({
      code: "P2003",
    });
  });

  it("the migration clears it, records it, and then the same edit goes through", async () => {
    const rolledBack = new Error("roll back: the cleanup is DB-wide");
    await expect(
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(ADD);
          const row = await tx.workItem.findUniqueOrThrow({ where: { id: itemId }, select: { assigneeId: true } });
          expect(row.assigneeId).toBeNull();
          const audits = await tx.auditLog.findMany({ where: { orgId, action: "work_item.clear_dangling_assignees" }, select: { metadata: true } });
          const mine = audits.map((a) => a.metadata as { itemIds: string[]; assigneeIds: string[] }).filter((m) => m.itemIds.includes(itemId));
          expect(mine).toHaveLength(1);
          expect(mine[0].assigneeIds).toContain(noUser);
          await edit(tx, { title: "Renamed again", tags: ["key-check"] });
          const after = await tx.workItem.findUniqueOrThrow({ where: { id: itemId }, select: { title: true, assigneeId: true } });
          expect(after).toEqual({ title: "Renamed again", assigneeId: null });
          throw rolledBack;
        },
        { timeout: 30_000 },
      ),
    ).rejects.toBe(rolledBack);
    // Rolled back: the row is as it was.
    expect(await assigneeOf()).toBe(noUser);
  });
});
