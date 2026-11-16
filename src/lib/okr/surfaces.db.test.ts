// @vitest-environment node
//
// (e2e DB) A key result made on the OKR board and measured by linked tickets
// read "3 / 100" with all three tickets done. The board's quick-add sends only
// a title, so the target was the default 100, meant for a percentage. Every
// surface that shows that number now goes through one rule
// (lib/okr/progress.ts `measureKeyResult`). Through the real routes, against a
// real database, the way the board drives them.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { KR_DEFAULT_TARGET } from "./progress";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { GET as listObjectives, POST as createObjective } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/objectives/route";
import {
  GET as getObjective,
  PUT as updateObjective,
} from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/objectives/[objectiveId]/route";
import { POST as createKeyResult } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/objectives/[objectiveId]/key-results/route";
import {
  PUT as updateKeyResult,
  DELETE as deleteKeyResult,
} from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/key-results/[krId]/route";
import {
  POST as linkItem,
  DELETE as unlinkItem,
} from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/key-results/[krId]/links/route";
import { GET as listGoals } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/goals/route";
import {
  listObjectives as cosmoListObjectives,
  updateObjective as cosmoUpdateObjective,
  updateKeyResult as cosmoUpdateKeyResult,
} from "@/lib/ai/executors/okrs";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", projectId = "", userId = "", typeId = "";

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: `okr-${stamp}@okrs.test`, displayName: "OKR owner" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `okrs ${stamp}`, slug: `okrs-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId, role: "OWNER", permissions: "0" } });
  projectId = (await prisma.project.create({ data: { orgId, name: "O", key: `OK${stamp.slice(0, 3).toUpperCase()}` } })).id;
  await ensureFixtureStatuses(projectId);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;
  h.ctx = {
    userId, orgId, orgRole: "OWNER", abacRules: [],
    permissions: RolePermissions.OWNER, basePermissions: RolePermissions.OWNER,
  } satisfies AuthContext;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
});

const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
const at = <E extends Record<string, string>>(extra: E = {} as E) => ({ params: Promise.resolve({ orgId, projectId, ...extra }) });

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  const r = await res;
  const body = await r.json();
  if (!r.ok) throw new Error(`${r.status}: ${JSON.stringify(body)}`);
  return body as T;
}

type BoardKr = {
  id: string; currentValue: number; targetValue: number; targetFromLinks: boolean;
  linkedDone: number; linkedTotal: number; status: string;
};
type BoardObjective = {
  id: string; progress: number; health: string; overdue: boolean; keyResults: BoardKr[];
  dependsOn: { id: string; health: string; overdue: boolean }[];
};
type CosmoObjectives = {
  objectives: { id: string; progress: number; health: string; overdue: boolean; keyResults: { id: string; status: string }[] }[];
};

/** Cosmo, as the same OWNER the routes run as. */
const tool = () => ({ orgId, userId, auth: h.ctx as AuthContext });
const board = async (id: string) => (await json<BoardObjective[]>(listObjectives(req("GET"), at()))).find((o) => o.id === id)!;
const cosmoBoard = async (id: string) =>
  ((await cosmoListObjectives({ projectId }, tool())) as CosmoObjectives).objectives.find((o) => o.id === id)!;
const workItems = (n: number, title: string) =>
  Promise.all(
    Array.from({ length: n }, (_, i) =>
      createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: userId, title: `${title} ${i + 1}`, columnKey: "todo" }),
    ),
  );
const finish = (ids: string[]) => prisma.workItem.updateMany({ where: { id: { in: ids } }, data: { completedAt: new Date() } });

describe("a key result measured by linked tickets, made on the board", () => {
  it("reads 3 / 3 and 100% on every surface once its three tickets are done", async () => {
    // As the board makes them: an objective, then a key result with a title only.
    const objective = await json<{ id: string }>(createObjective(req("POST", { title: "Deliver the pilot", status: "ACTIVE" }), at()));
    const kr = await json<{ id: string; targetValue: number }>(
      createKeyResult(req("POST", { title: "Ship the three" }), at({ objectiveId: objective.id })),
    );
    expect(kr.targetValue).toBe(KR_DEFAULT_TARGET);

    const items = await Promise.all(
      [1, 2, 3].map((n) =>
        createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: userId, title: `pilot ${n}`, columnKey: "todo" }),
      ),
    );
    for (const item of items) {
      await json(linkItem(req("POST", { workItemId: item.id }), at({ krId: kr.id })));
    }

    // A goal that rolls up from the objective, the other reader of its progress.
    const goal = await prisma.goal.create({
      data: { orgId, projectId, title: "Pilot goal", progressMode: "AUTO", links: { create: { kind: "OBJECTIVE", objectiveId: objective.id } } },
    });

    const board = async () => (await json<BoardObjective[]>(listObjectives(req("GET"), at()))).find((o) => o.id === objective.id)!;

    // POSITIVE CONTROL: before anything is done the probe sees an incomplete KR.
    const before = await board();
    expect([before.keyResults[0].currentValue, before.keyResults[0].targetValue, before.progress]).toEqual([0, 3, 0]);

    await prisma.workItem.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { completedAt: new Date() } });

    // The OKR board.
    const after = await board();
    expect(after.keyResults[0]).toMatchObject({ currentValue: 3, targetValue: 3, targetFromLinks: true, linkedDone: 3, linkedTotal: 3 });
    expect(after.progress).toBe(100);

    // The single-objective read.
    const one = await json<{ progress: number; keyResults: { currentValue: number; targetValue: number }[] }>(
      getObjective(req("GET"), at({ objectiveId: objective.id })),
    );
    expect([one.keyResults[0].currentValue, one.keyResults[0].targetValue, one.progress]).toEqual([3, 3, 100]);

    // A goal rolling up from the objective.
    const goals = await json<{ id: string; progress: number }[]>(listGoals(req("GET"), at()));
    expect(goals.find((g) => g.id === goal.id)?.progress).toBe(100);

    // Saving the edit dialog without touching the target keeps it following the
    // links (the dialog sends the default for "not set")...
    await json(updateKeyResult(req("PUT", { title: "Ship the three!", targetValue: KR_DEFAULT_TARGET }), at({ krId: kr.id })));
    expect((await board()).keyResults[0]).toMatchObject({ targetValue: 3, targetFromLinks: true });
    // ...and the stored copy of progress, written on that save, agrees.
    expect((await prisma.objective.findUniqueOrThrow({ where: { id: objective.id } })).progress).toBe(100);

    // A target someone sets is kept: 3 done of 5 is 60%.
    await json(updateKeyResult(req("PUT", { targetValue: 5 }), at({ krId: kr.id })));
    const set = await board();
    expect(set.keyResults[0]).toMatchObject({ currentValue: 3, targetValue: 5, targetFromLinks: false });
    expect(set.progress).toBe(60);
  });
});

describe("a key result's status agrees with its linked work items", () => {
  it("shows Done on every surface once all its linked tickets are done (it showed the stored In Progress)", async () => {
    const objective = await json<{ id: string }>(createObjective(req("POST", { title: "Status follows delivery", status: "ACTIVE" }), at()));
    // As the board makes one: a title, so the status is the API default.
    const kr = await json<{ id: string; status: string }>(
      createKeyResult(req("POST", { title: "Ship both" }), at({ objectiveId: objective.id })),
    );
    expect(kr.status).toBe("IN_PROGRESS");
    const items = await workItems(2, "status");
    for (const item of items) await json(linkItem(req("POST", { workItemId: item.id }), at({ krId: kr.id })));

    // POSITIVE CONTROL: part-way, every surface shows the stored status.
    await finish([items[0].id]);
    expect((await board(objective.id)).keyResults[0]).toMatchObject({ status: "IN_PROGRESS", linkedDone: 1, linkedTotal: 2 });
    expect((await cosmoBoard(objective.id)).keyResults[0].status).toBe("IN_PROGRESS");

    await finish([items[1].id]);

    // The OKR board.
    expect((await board(objective.id)).keyResults[0]).toMatchObject({ status: "DONE", currentValue: 2, targetValue: 2 });
    // The single-objective read.
    const one = await json<{ keyResults: { status: string }[] }>(getObjective(req("GET"), at({ objectiveId: objective.id })));
    expect(one.keyResults[0].status).toBe("DONE");
    // The key result's own PUT answers with what a read shows, not the stored row.
    const put = await json<{ status: string; currentValue: number; targetValue: number }>(
      updateKeyResult(req("PUT", { title: "Ship both!" }), at({ krId: kr.id })),
    );
    expect([put.status, put.currentValue, put.targetValue]).toEqual(["DONE", 2, 2]);
    // Cosmo.
    expect((await cosmoBoard(objective.id)).keyResults[0].status).toBe("DONE");
    const viaCosmo = (await cosmoUpdateKeyResult({ keyResultId: kr.id, title: "Ship both" }, tool())) as {
      keyResult: { status: string; currentValue: number };
    };
    expect([viaCosmo.keyResult.status, viaCosmo.keyResult.currentValue]).toEqual(["DONE", 2]);

    // Read-time: nothing wrote the stored status, so reopening a ticket takes Done away again.
    expect((await prisma.keyResult.findUniqueOrThrow({ where: { id: kr.id } })).status).toBe("IN_PROGRESS");
    await prisma.workItem.update({ where: { id: items[1].id }, data: { completedAt: null } });
    expect((await board(objective.id)).keyResults[0].status).toBe("IN_PROGRESS");
  });

  it("keeps the status someone set on a key result without links, even at 100%", async () => {
    const objective = await json<{ id: string }>(createObjective(req("POST", { title: "Typed in", status: "ACTIVE" }), at()));
    const kr = await json<{ id: string }>(
      createKeyResult(req("POST", { title: "Revenue", currentValue: 100, targetValue: 100 }), at({ objectiveId: objective.id })),
    );
    expect((await board(objective.id)).keyResults[0]).toMatchObject({ status: "IN_PROGRESS", currentValue: 100 });
    await json(updateKeyResult(req("PUT", { status: "AT_RISK" }), at({ krId: kr.id })));
    expect((await board(objective.id)).keyResults[0].status).toBe("AT_RISK");
  });
});

describe("an objective's progress is live in every answer, not the stored copy", () => {
  it("the objective PUT answers with live progress through ticket finish, key result add and delete, link and unlink", async () => {
    const objective = await json<{ id: string }>(createObjective(req("POST", { title: "Live progress", status: "ACTIVE" }), at()));
    const kr = await json<{ id: string }>(createKeyResult(req("POST", { title: "Tickets" }), at({ objectiveId: objective.id })));
    const [first, second] = await workItems(2, "live");
    await json(linkItem(req("POST", { workItemId: first.id }), at({ krId: kr.id })));
    const put = async () =>
      json<{ progress: number; keyResults: { id: string; status: string }[] }>(
        updateObjective(req("PUT", { description: `edited ${Math.random()}` }), at({ objectiveId: objective.id })),
      );

    // A linked ticket finishing writes nothing to the objective...
    await finish([first.id]);
    expect((await prisma.objective.findUniqueOrThrow({ where: { id: objective.id } })).progress).toBe(0);
    // ...so the PUT used to answer 0 here. It answers what the board shows.
    let answer = await put();
    expect(answer.progress).toBe(100);
    expect(answer.progress).toBe((await board(objective.id)).progress);
    expect(answer.keyResults[0].status).toBe("DONE");

    // A second key result, typed in at 0 of 100: the mean is 50.
    const added = await json<{ id: string }>(createKeyResult(req("POST", { title: "Typed" }), at({ objectiveId: objective.id })));
    expect((answer = await put()).progress).toBe(50);
    // Deleted again: back to 100.
    await json(deleteKeyResult(req("DELETE"), at({ krId: added.id })));
    expect((answer = await put()).progress).toBe(100);
    // An open ticket linked: 1 of 2.
    await json(linkItem(req("POST", { workItemId: second.id }), at({ krId: kr.id })));
    expect((answer = await put()).progress).toBe(50);
    // And unlinked: 1 of 1.
    await json(unlinkItem(req("DELETE", { workItemId: second.id }), at({ krId: kr.id })));
    expect((answer = await put()).progress).toBe(100);
  });

  it("Cosmo's update_objective answers with live progress", async () => {
    const objective = await json<{ id: string }>(createObjective(req("POST", { title: "Cosmo live", status: "ACTIVE" }), at()));
    const kr = await json<{ id: string }>(createKeyResult(req("POST", { title: "One ticket" }), at({ objectiveId: objective.id })));
    const [item] = await workItems(1, "cosmo live");
    await json(linkItem(req("POST", { workItemId: item.id }), at({ krId: kr.id })));
    await finish([item.id]);
    // Control: the stored copy is stale.
    expect((await prisma.objective.findUniqueOrThrow({ where: { id: objective.id } })).progress).toBe(0);
    const res = (await cosmoUpdateObjective({ objectiveId: objective.id, title: "Cosmo live!" }, tool())) as {
      objective: { progress: number };
    };
    expect(res.objective.progress).toBe(100);
  });
});

describe("a cancelled objective past its due day", () => {
  it("reads cancelled, not behind, on the board, in what depends on it, and to Cosmo", async () => {
    const pastDue = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const make = (title: string, status: string) =>
      json<{ id: string }>(createObjective(req("POST", { title, status, targetDate: pastDue }), at()));
    const cancelled = await make("Called off", "CANCELLED");
    // POSITIVE CONTROL: the same objective still active is behind and overdue.
    const active = await make("Still on", "ACTIVE");
    const waiting = await make("Waits on both", "ACTIVE");
    for (const dependsOnId of [cancelled.id, active.id]) {
      await prisma.objectiveDependency.create({ data: { orgId, objectiveId: waiting.id, dependsOnId } });
    }

    expect(await board(active.id)).toMatchObject({ health: "behind", overdue: true });
    expect(await board(cancelled.id)).toMatchObject({ health: "cancelled", overdue: false });

    const deps = (await board(waiting.id)).dependsOn;
    expect(deps.find((d) => d.id === active.id)).toMatchObject({ health: "behind", overdue: true });
    expect(deps.find((d) => d.id === cancelled.id)).toMatchObject({ health: "cancelled", overdue: false });

    expect(await cosmoBoard(active.id)).toMatchObject({ health: "behind", overdue: true });
    expect(await cosmoBoard(cancelled.id)).toMatchObject({ health: "cancelled", overdue: false });
  });
});
