import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import {
  listObjectives,
  createObjective,
  updateObjective,
  deleteObjective,
  createKeyResult,
  updateKeyResult,
  addKrCheckin,
  linkKeyResultItem,
} from "./okrs";
import { memberToolCtx } from "@/lib/testing/tool-auth";
import { ensureFixtureStatuses } from "@/lib/testing/db-fixtures";

const NON_MEMBER = "00000000-0000-0000-0000-000000000000";

describe("okr executors (e2e DB)", () => {
  const cleanup: { orgIds: string[] } = { orgIds: [] };
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } }).catch(() => undefined);
  });

  async function makeOrg() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `okr-test ${stamp}`, slug: `okr-test-${stamp}` },
    });
    cleanup.orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: "OWNER" } });
    const project = await prisma.project.create({
      data: { orgId: org.id, name: "P", key: `OK${stamp.slice(-4).toUpperCase()}` },
    });
    const ctx = await memberToolCtx(org.id, owner.id);
    const denyCtx = await memberToolCtx(org.id, NON_MEMBER);
    return { org, project, ctx, denyCtx, ownerId: owner.id };
  }

  async function makeWorkItem(orgId: string, projectId: string, createdById: string) {
    await ensureFixtureStatuses(projectId, ["todo"]);
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } });
    return prisma.workItem.create({
      data: {
        orgId,
        projectId,
        ticketNumber: Math.floor(Math.random() * 1_000_000),
        title: "linked",
        description: "",
        columnKey: "todo",
        workItemTypeId: type.id,
        createdById,
      },
    });
  }

  it("create_objective + create_key_result persist and roll up progress", async () => {
    const { ctx, project } = await makeOrg();
    const obj = (await createObjective({ projectId: project.id, title: "Grow" }, ctx)) as {
      created: boolean;
      id: string;
    };
    expect(obj.created).toBe(true);

    const kr = (await createKeyResult(
      { objectiveId: obj.id, title: "Signups", startValue: 0, currentValue: 50, targetValue: 100 },
      ctx,
    )) as { created: boolean; id: string };
    expect(kr.created).toBe(true);
    // 50/100 → objective progress 50.
    expect((await prisma.objective.findUnique({ where: { id: obj.id } }))?.progress).toBe(50);

    await updateKeyResult({ keyResultId: kr.id, currentValue: 100 }, ctx);
    expect((await prisma.objective.findUnique({ where: { id: obj.id } }))?.progress).toBe(100);
  });

  it("add_kr_checkin folds into the KR snapshot and derives rag from confidence", async () => {
    const { ctx, project } = await makeOrg();
    const obj = (await createObjective({ projectId: project.id, title: "Reliability" }, ctx)) as { id: string };
    const kr = (await createKeyResult({ objectiveId: obj.id, title: "Uptime", targetValue: 100 }, ctx)) as {
      id: string;
    };
    const res = (await addKrCheckin({ keyResultId: kr.id, value: 80, confidence: 90 }, ctx)) as {
      created: boolean;
      id: string;
    };
    expect(res.created).toBe(true);
    const row = await prisma.keyResult.findUnique({ where: { id: kr.id } });
    expect(row?.currentValue).toBe(80);
    expect(row?.confidence).toBe(90);
    expect(row?.rag).toBe("GREEN"); // confidence 90 → GREEN
    const checkins = await prisma.keyResultCheckin.count({ where: { keyResultId: kr.id } });
    expect(checkins).toBe(1);
  });

  it("link_key_result_item creates a KeyResultLink (same-project)", async () => {
    const { ctx, project, ownerId, org } = await makeOrg();
    const obj = (await createObjective({ projectId: project.id, title: "Deliver" }, ctx)) as { id: string };
    const kr = (await createKeyResult({ objectiveId: obj.id, title: "Tickets" }, ctx)) as { id: string };
    const wi = await makeWorkItem(org.id, project.id, ownerId);
    const res = (await linkKeyResultItem({ keyResultId: kr.id, workItemId: wi.id }, ctx)) as {
      created: boolean;
      id: string;
    };
    expect(res.created).toBe(true);
    expect(
      await prisma.keyResultLink.count({ where: { keyResultId: kr.id, workItemId: wi.id } }),
    ).toBe(1);
  });

  it("list_objectives round-trips with keyResults + progress + health", async () => {
    const { ctx, project } = await makeOrg();
    const obj = (await createObjective({ projectId: project.id, title: "See me" }, ctx)) as { id: string };
    await createKeyResult({ objectiveId: obj.id, title: "kr", currentValue: 25, targetValue: 100 }, ctx);
    const list = (await listObjectives({ projectId: project.id }, ctx)) as {
      count: number;
      objectives: { id: string; progress: number; health: string; keyResults: unknown[] }[];
    };
    expect(list.count).toBe(1);
    expect(list.objectives[0].progress).toBe(25);
    expect(list.objectives[0].keyResults).toHaveLength(1);
    expect(typeof list.objectives[0].health).toBe("string");
  });

  it("list_objectives reads a KR counting 3 done linked tickets as 3 / 3 and 100%, like the board", async () => {
    // A key result made with only a title, as the OKR board's quick-add makes
    // it, keeps the default target of 100. Linked to three tickets that are all
    // done it read "3 / 100" — 3% — on the board, here and in the dashboards.
    const { ctx, project, ownerId, org } = await makeOrg();
    const obj = (await createObjective({ projectId: project.id, title: "Deliver" }, ctx)) as { id: string };
    const kr = (await createKeyResult({ objectiveId: obj.id, title: "Ship the three" }, ctx)) as { id: string };
    // A sibling KR with a target someone set (5), linked to the same tickets:
    // the set target must survive, so 3 of 5 is 60%.
    const setKr = (await createKeyResult({ objectiveId: obj.id, title: "Ship five", targetValue: 5 }, ctx)) as { id: string };
    const items = [
      await makeWorkItem(org.id, project.id, ownerId),
      await makeWorkItem(org.id, project.id, ownerId),
      await makeWorkItem(org.id, project.id, ownerId),
    ];
    for (const wi of items) {
      await linkKeyResultItem({ keyResultId: kr.id, workItemId: wi.id }, ctx);
      await linkKeyResultItem({ keyResultId: setKr.id, workItemId: wi.id }, ctx);
    }

    type Listed = { objectives: { progress: number; keyResults: { id: string; currentValue: number; targetValue: number; targetFromLinks: boolean }[] }[] };
    const read = async () => {
      const o = ((await listObjectives({ projectId: project.id }, ctx)) as Listed).objectives[0];
      const byId = new Map(o.keyResults.map((k) => [k.id, k]));
      return { progress: o.progress, kr: byId.get(kr.id)!, setKr: byId.get(setKr.id)! };
    };

    // POSITIVE CONTROL: nothing done yet, so the probe can see a non-complete KR.
    const before = await read();
    expect([before.kr.currentValue, before.kr.targetValue]).toEqual([0, 3]);

    await prisma.workItem.updateMany({ where: { id: { in: items.map((w) => w.id) } }, data: { completedAt: new Date() } });
    const after = await read();
    expect([after.kr.currentValue, after.kr.targetValue, after.kr.targetFromLinks]).toEqual([3, 3, true]);
    expect([after.setKr.currentValue, after.setKr.targetValue, after.setKr.targetFromLinks]).toEqual([3, 5, false]);
    // (100 + 60) / 2
    expect(after.progress).toBe(80);
  });

  it("update_objective + delete_objective mutate the row", async () => {
    const { ctx, project } = await makeOrg();
    const obj = (await createObjective({ projectId: project.id, title: "Temp" }, ctx)) as { id: string };
    await updateObjective({ objectiveId: obj.id, status: "COMPLETED" }, ctx);
    expect((await prisma.objective.findUnique({ where: { id: obj.id } }))?.status).toBe("COMPLETED");
    await deleteObjective({ objectiveId: obj.id }, ctx);
    expect(await prisma.objective.findUnique({ where: { id: obj.id } })).toBeNull();
  });

  it("denies a non-member across the OKR surface", async () => {
    const { denyCtx, project } = await makeOrg();
    expect(await listObjectives({ projectId: project.id }, denyCtx)).toEqual({ error: "Insufficient permissions" });
    expect(await createObjective({ projectId: project.id, title: "x" }, denyCtx)).toEqual({
      error: "Insufficient permissions",
    });
    expect(await createKeyResult({ objectiveId: NON_MEMBER, title: "x" }, denyCtx)).toEqual({
      error: "Insufficient permissions",
    });
    expect(await addKrCheckin({ keyResultId: NON_MEMBER, value: 1 }, denyCtx)).toEqual({
      error: "Insufficient permissions",
    });
  });
});
