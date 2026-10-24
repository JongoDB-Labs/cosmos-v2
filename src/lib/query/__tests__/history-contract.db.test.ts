// (e2e DB) The Activity contract history depends on: edit through the real
// work-item PUT route, then ask WAS / CHANGED about it. If a writer renames a
// field or changes how it stores values, these fail instead of WAS quietly
// matching nothing.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { executeCql } from "../execute.server";
import { seedWorld, type World } from "./cql-fixture";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
// Outward side effects only; every database write is real.
vi.mock("@/lib/rag/embed", () => ({ storeEmbedding: vi.fn(async () => undefined) }));
vi.mock("@/lib/integrations/teams-notify", async (orig) => ({
  ...((await orig()) as object),
  teamsNotify: vi.fn(async () => undefined),
}));
vi.mock("@/lib/realtime/broker", async (orig) => ({ ...((await orig()) as object), publishToOrg: vi.fn(async () => undefined) }));

import { PUT } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/route";

describe("history ↔ the work-item writer (e2e DB)", () => {
  let w: World;
  let editor: AuthContext;
  beforeAll(async () => {
    w = await seedWorld();
    const permissions = Permission.ITEM_READ | Permission.ITEM_UPDATE;
    editor = { ...w.ctx(), permissions, basePermissions: permissions } as AuthContext;
    getAuthContext.mockImplementation(async () => editor);

    const item = w.items["p1-unassigned"];
    const put = async (body: object) => {
      const res = await PUT(
        new NextRequest(`http://localhost/api/v1/orgs/${w.orgA}/projects/${item.projectId}/work-items/${item.id}`, {
          method: "PUT",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }),
        { params: Promise.resolve({ orgId: w.orgA, projectId: item.projectId, itemId: item.id }) },
      );
      expect(res.status, JSON.stringify(body)).toBe(200);
    };
    await put({ columnKey: "review" });
    await put({ priority: "HIGH" });
    await put({ assigneeId: w.bob.id });
    await put({ intervalId: w.sprintP1Active });
    await put({ dueDate: "2026-11-30T00:00:00.000Z" });
    await put({ columnKey: "done" });
  }, 60_000);
  afterAll(async () => {
    await w?.cleanup();
  });

  const titles = async (cql: string) =>
    (await executeCql(editor, { cql: `project = ${w.P1.key} AND (${cql})` }, { pageSize: 100 })).data.map((r) => r.title);

  it.each([
    ['status CHANGED FROM "To Do" TO Review BY me'],
    ["status WAS Review AFTER -1d"],
    ["status CHANGED TO Done"],
    ["priority CHANGED FROM LOW TO HIGH"],
    ["priority WAS LOW"],
    ['assignee CHANGED FROM EMPTY TO "Bob Builder"'],
    ["sprint WAS \"Sprint 2\""],
    ['sprint CHANGED TO "Sprint 1"'],
    ["due CHANGED FROM EMPTY TO 2026-11-30"],
    ["due WAS EMPTY BEFORE now()"],
    ["completed CHANGED FROM EMPTY AFTER -1d"],
  ])("%s", async (cql) => {
    expect(await titles(cql)).toContain("p1-unassigned");
  });
});
