// @vitest-environment node
//
// update_interval against PUT /intervals/{intervalId}, for the SAME real actor,
// in a real database (e2e DB). Both write an interval's status, so both must
// apply the same Program Increment rules:
//
//   1. one sprint runs at a time, and a running PI is not a competitor;
//   2. a PI is never started by hand;
//   3. a PI completes only once every interval inside it has;
//   4. starting a sprint starts the PI around it — the PI it ends up under,
//      when the same change moves it.
//
// And the re-parent rules both had already, which moved into the same function.
// Completing has its own door on each side (POST /intervals/{id}/complete and
// complete_interval), and rule 3 holds there too. Last, who may change a
// sprint at all: the agent asks the route's own question, requireProjectManage.
//
// The agent used to carry its own copy written before PIs existed, which
// counted an active PI as a competitor and applied none of 2-4. Every case
// runs through both doors on fresh rows, and every refusal has a control
// beside it showing the same change landing where it should.
//
// Own org and own user; the seeded ones are never touched.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import type { IntervalKind, SprintStatus } from "@prisma/client";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { prisma } from "@/lib/db/client";
import { memberToolCtx } from "@/lib/testing/tool-auth";
import type { ToolContext } from "./_ctx";
import { completeInterval, updateInterval } from "./projects";
import { PUT as intervalRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/route";
import { POST as completeRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/complete/route";
import { PARENT_NOT_A_PI } from "@/lib/intervals/pi-lifecycle";
import { Permission } from "@/lib/rbac/permissions";

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const k = stamp.slice(-4).toUpperCase();
const userIds: string[] = [];
let orgId = "";
let actor: ToolContext;
let projects = 0;

type Change = { status?: SprintStatus; parentId?: string | null };
/** What a door answered: refused with a message, or done. */
type Outcome = { refused: string } | { done: true };

/** The agent's door. */
async function viaAgent(projectId: string, intervalId: string, change: Change): Promise<Outcome> {
  const out = (await updateInterval({ projectId, intervalId, ...change }, actor)) as { error?: string; updated?: boolean };
  if (out.error !== undefined) return { refused: out.error };
  expect(out.updated).toBe(true);
  return { done: true };
}

/** The route's door: a refusal is a 409 (a status rule) or a 400 (a nesting rule) whose `detail` is the message. */
async function viaRoute(projectId: string, intervalId: string, change: Change): Promise<Outcome> {
  getAuthContext.mockResolvedValue(actor.auth);
  const res = await intervalRoute(
    new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify(change), headers: { "Content-Type": "application/json" } }),
    { params: Promise.resolve({ orgId, projectId, intervalId }) } as never,
  );
  if (res.status === 200) return { done: true };
  const body = (await res.json()) as { detail?: string };
  expect([400, 409], JSON.stringify(body)).toContain(res.status);
  return { refused: body.detail ?? "" };
}

const DOORS = [
  ["the agent", viaAgent],
  ["the route", viaRoute],
] as const;

/**
 * A fresh project: a Program Increment holding two sprints, plus a sprint
 * outside it. Everything PLANNED unless `status` says otherwise.
 */
async function world(status: Partial<Record<"pi" | "s1" | "s2" | "loose", SprintStatus>> = {}) {
  projects += 1;
  const projectId = (await prisma.project.create({ data: { orgId, name: `P${projects}`, key: `IV${k}${projects}` } })).id;
  let number = 0;
  const iv = async (name: string, intervalKind: IntervalKind, s: SprintStatus | undefined, parentId?: string) =>
    (
      await prisma.interval.create({
        data: {
          orgId, projectId, number: ++number, name, intervalKind, status: s ?? "PLANNED",
          startDate: new Date("2026-07-01"), endDate: new Date("2026-09-30"), ...(parentId ? { parentId } : {}),
        },
      })
    ).id;
  const pi = await iv(`PI ${projects}`, "PROGRAM_INCREMENT", status.pi);
  const s1 = await iv(`Sprint A${projects}`, "SPRINT", status.s1, pi);
  const s2 = await iv(`Sprint B${projects}`, "SPRINT", status.s2, pi);
  const loose = await iv(`Sprint C${projects}`, "SPRINT", status.loose);
  return { projectId, pi, s1, s2, loose };
}

/** Completing, through each side's own door. */
async function completeViaAgent(projectId: string, intervalId: string): Promise<Outcome> {
  const out = (await completeInterval({ projectId, intervalId }, actor)) as { error?: string; completed?: boolean };
  if (out.error !== undefined) return { refused: out.error };
  expect(out.completed).toBe(true);
  return { done: true };
}

async function completeViaRoute(projectId: string, intervalId: string): Promise<Outcome> {
  getAuthContext.mockResolvedValue(actor.auth);
  const res = await completeRoute(
    new NextRequest("http://localhost/x", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }),
    { params: Promise.resolve({ orgId, projectId, intervalId }) } as never,
  );
  if (res.status === 200) return { done: true };
  const body = (await res.json()) as { detail?: string; error?: string };
  expect(res.status, JSON.stringify(body)).toBe(409);
  return { refused: body.detail ?? body.error ?? "" };
}

const COMPLETE_DOORS = [
  ["the agent", completeViaAgent],
  ["the route", completeViaRoute],
] as const;

/** A second Program Increment in a world's project, to move a sprint into. */
async function secondPi(projectId: string) {
  return (
    await prisma.interval.create({
      data: {
        orgId, projectId, number: 99, name: `PI two ${projects}`, intervalKind: "PROGRAM_INCREMENT", status: "PLANNED",
        startDate: new Date("2026-10-01"), endDate: new Date("2026-12-31"),
      },
    })
  ).id;
}

const statusOf = async (id: string) => (await prisma.interval.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `iv ${stamp}`, slug: `iv-${stamp}` } })).id;
  const u = await prisma.user.create({ data: { email: `planner-${stamp}@example.com`, displayName: "planner" } });
  userIds.push(u.id);
  await prisma.orgMember.create({ data: { orgId, userId: u.id, role: "OWNER" } });
  actor = await memberToolCtx(orgId, u.id);
}, 120_000);

afterAll(async () => {
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

describe.each(DOORS)("an interval's status change through %s", (_door, change) => {
  it("the fixture is what it claims", async () => {
    const w = await world({ pi: "ACTIVE", s1: "ACTIVE" });
    expect(actor.auth).toBeDefined();
    expect(await statusOf(w.pi)).toBe("ACTIVE");
    expect(await statusOf(w.s1)).toBe("ACTIVE");
    expect(await statusOf(w.s2)).toBe("PLANNED");
  });

  // Rule 1. The PI around the running sprint is ACTIVE too; it must not count.
  it("starts a sprint while only the Program Increment is running", async () => {
    const w = await world({ pi: "ACTIVE", s1: "COMPLETED" });
    expect(await change(w.projectId, w.s2, { status: "ACTIVE" })).toEqual({ done: true });
    expect(await statusOf(w.s2)).toBe("ACTIVE");
  });

  it("refuses to start a sprint while another sprint is running, and names it", async () => {
    const w = await world({ pi: "ACTIVE", s1: "ACTIVE" });
    expect(await change(w.projectId, w.s2, { status: "ACTIVE" })).toEqual({
      refused: `Sprint A${projects} is still active — complete it first.`,
    });
    expect(await statusOf(w.s2)).toBe("PLANNED");
  });

  // Rule 2.
  it("refuses to start a Program Increment by hand", async () => {
    // Its sprints are done, so nothing but this rule stands in the way.
    const w = await world({ s1: "COMPLETED", s2: "COMPLETED" });
    expect(await change(w.projectId, w.pi, { status: "ACTIVE" })).toEqual({
      refused: "A Program Increment starts when its first sprint starts — it is not started directly.",
    });
    expect(await statusOf(w.pi)).toBe("PLANNED");
    // Control: the same door does set a PI's status where the rules allow it.
    expect(await change(w.projectId, w.pi, { status: "COMPLETED" })).toEqual({ done: true });
    expect(await statusOf(w.pi)).toBe("COMPLETED");
  });

  // Rule 3.
  it("refuses to complete a Program Increment with unfinished sprints, naming them", async () => {
    const w = await world({ pi: "ACTIVE", s1: "COMPLETED", s2: "ACTIVE" });
    expect(await change(w.projectId, w.pi, { status: "COMPLETED" })).toEqual({
      refused: `This Program Increment still has unfinished iterations: Sprint B${projects}.`,
    });
    expect(await statusOf(w.pi)).toBe("ACTIVE");
  });

  it("completes a Program Increment once every sprint inside it is done", async () => {
    const w = await world({ pi: "ACTIVE", s1: "COMPLETED", s2: "COMPLETED" });
    expect(await change(w.projectId, w.pi, { status: "COMPLETED" })).toEqual({ done: true });
    expect(await statusOf(w.pi)).toBe("COMPLETED");
  });

  // Rule 4.
  it("starting a sprint starts the Program Increment around it", async () => {
    const w = await world();
    expect(await change(w.projectId, w.s1, { status: "ACTIVE" })).toEqual({ done: true });
    expect(await statusOf(w.s1)).toBe("ACTIVE");
    expect(await statusOf(w.pi)).toBe("ACTIVE");
  });

  it("starting a sprint outside any Program Increment starts no PI", async () => {
    const w = await world();
    expect(await change(w.projectId, w.loose, { status: "ACTIVE" })).toEqual({ done: true });
    expect(await statusOf(w.loose)).toBe("ACTIVE");
    expect(await statusOf(w.pi)).toBe("PLANNED");
  });

  // Rule 4 when the same change moves the sprint: the PI it lands in starts,
  // the one it left does not.
  it("starting a sprint while moving it into another PI starts that PI, not the one it left", async () => {
    const w = await world();
    const pi2 = await secondPi(w.projectId);
    expect(await change(w.projectId, w.s1, { status: "ACTIVE", parentId: pi2 })).toEqual({ done: true });
    expect(await statusOf(pi2)).toBe("ACTIVE");
    expect(await statusOf(w.pi)).toBe("PLANNED");
  });

  it("starting a loose sprint while moving it into a PI starts that PI", async () => {
    const w = await world();
    expect(await change(w.projectId, w.loose, { status: "ACTIVE", parentId: w.pi })).toEqual({ done: true });
    expect(await statusOf(w.pi)).toBe("ACTIVE");
  });

  it("starting a sprint while taking it out of its PI starts no PI", async () => {
    const w = await world();
    expect(await change(w.projectId, w.s1, { status: "ACTIVE", parentId: null })).toEqual({ done: true });
    expect(await statusOf(w.s1)).toBe("ACTIVE");
    expect(await statusOf(w.pi)).toBe("PLANNED");
  });

  // The re-parent rules, which moved into the same function.
  it("refuses to nest a sprint under a sprint or under itself, and nests it under a PI", async () => {
    const w = await world();
    const parentOf = async (id: string) =>
      (await prisma.interval.findUniqueOrThrow({ where: { id }, select: { parentId: true } })).parentId;
    expect(await change(w.projectId, w.loose, { parentId: w.s1 })).toEqual({ refused: PARENT_NOT_A_PI });
    expect(await change(w.projectId, w.loose, { parentId: w.loose })).toEqual({
      refused: "An interval can't be its own Program Increment",
    });
    expect(await parentOf(w.loose)).toBeNull();
    // Control: the same door does nest it where the rules allow.
    expect(await change(w.projectId, w.loose, { parentId: w.pi })).toEqual({ done: true });
    expect(await parentOf(w.loose)).toBe(w.pi);
  });
});

// Rule 3 on the complete doors. Completing used to check only that the
// interval was ACTIVE, so an ACTIVE PI completed with its sprints still open.
describe.each(COMPLETE_DOORS)("completing an interval through %s", (_door, complete) => {
  it("refuses to complete a Program Increment with an unfinished sprint, naming it", async () => {
    const w = await world({ pi: "ACTIVE", s1: "COMPLETED", s2: "ACTIVE" });
    expect(await complete(w.projectId, w.pi)).toEqual({
      refused: `This Program Increment still has unfinished iterations: Sprint B${projects}.`,
    });
    expect(await statusOf(w.pi)).toBe("ACTIVE");
  });

  it("completes a Program Increment once every sprint inside it is done", async () => {
    const w = await world({ pi: "ACTIVE", s1: "COMPLETED", s2: "COMPLETED" });
    expect(await complete(w.projectId, w.pi)).toEqual({ done: true });
    expect(await statusOf(w.pi)).toBe("COMPLETED");
  });

  it("completes a running sprint while its sibling is still planned", async () => {
    const w = await world({ pi: "ACTIVE", s1: "ACTIVE" });
    expect(await complete(w.projectId, w.s1)).toEqual({ done: true });
    expect(await statusOf(w.s1)).toBe("COMPLETED");
  });
});

// Who may change a sprint. The route asks requireProjectManage: the org-wide
// SPRINT_UPDATE bit, or MANAGER of this project. The agent asked for the bit
// alone, so a project manager without it (an ordinary MEMBER) could rename
// their own sprint in the app and not through Cosmo.
describe("who may change a sprint", () => {
  let projectId = "";
  let sprintId = "";
  let manager: ToolContext;
  let member: ToolContext;

  beforeAll(async () => {
    projectId = (await prisma.project.create({ data: { orgId, name: "Gate", key: `GT${k}` } })).id;
    sprintId = (
      await prisma.interval.create({
        data: { orgId, projectId, number: 1, name: "Gate sprint", intervalKind: "SPRINT", status: "PLANNED",
          startDate: new Date("2026-07-01"), endDate: new Date("2026-07-14") },
      })
    ).id;
    const join = async (name: string, projectRole: "MANAGER" | "MEMBER") => {
      const u = await prisma.user.create({ data: { email: `${name}-${stamp}@example.com`, displayName: name } });
      userIds.push(u.id);
      const om = await prisma.orgMember.create({ data: { orgId, userId: u.id, role: "MEMBER" } });
      await prisma.projectMember.create({ data: { projectId, orgMemberId: om.id, role: projectRole } });
      return memberToolCtx(orgId, u.id);
    };
    manager = await join("pm", "MANAGER");
    member = await join("dev", "MEMBER");
  }, 120_000);

  const nameOf = async () => (await prisma.interval.findUniqueOrThrow({ where: { id: sprintId }, select: { name: true } })).name;

  async function routeStatus(who: ToolContext, name: string) {
    getAuthContext.mockResolvedValue(who.auth);
    const res = await intervalRoute(
      new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify({ name }), headers: { "Content-Type": "application/json" } }),
      { params: Promise.resolve({ orgId, projectId, intervalId: sprintId }) } as never,
    );
    return res.status;
  }
  const agentSays = async (who: ToolContext, name: string) =>
    (await updateInterval({ projectId, intervalId: sprintId, name }, who)) as { error?: string; updated?: boolean };

  it("the fixture is what it claims: neither holds the org-wide bit", () => {
    expect(manager.auth).toBeDefined();
    expect(member.auth).toBeDefined();
    expect(manager.auth!.orgRole).toBe("MEMBER");
    expect(member.auth!.orgRole).toBe("MEMBER");
    expect(manager.auth!.permissions & Permission.SPRINT_UPDATE).toBe(0n);
    expect(member.auth!.permissions & Permission.SPRINT_UPDATE).toBe(0n);
  });

  it("refuses a project member who doesn't manage the project, through both", async () => {
    expect(await routeStatus(member, "by the route")).toBe(403);
    expect(await agentSays(member, "by the agent")).toEqual({ error: "You do not have permission to change this project" });
    expect(await nameOf()).toBe("Gate sprint");
  });

  it("lets the project's manager change it, through both", async () => {
    expect(await routeStatus(manager, "renamed by the route")).toBe(200);
    expect(await nameOf()).toBe("renamed by the route");
    expect(await agentSays(manager, "renamed by the agent")).toMatchObject({ updated: true });
    expect(await nameOf()).toBe("renamed by the agent");
  });
});
