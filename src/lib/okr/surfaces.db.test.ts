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
import { GET as getObjective } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/objectives/[objectiveId]/route";
import { POST as createKeyResult } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/objectives/[objectiveId]/key-results/route";
import { PUT as updateKeyResult } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/key-results/[krId]/route";
import { POST as linkItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/key-results/[krId]/links/route";
import { GET as listGoals } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/goals/route";

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

type BoardKr = { id: string; currentValue: number; targetValue: number; targetFromLinks: boolean; linkedDone: number; linkedTotal: number };
type BoardObjective = { id: string; progress: number; health: string; keyResults: BoardKr[] };

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
