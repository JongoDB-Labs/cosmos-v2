// @vitest-environment node
//
// update_interval against PUT /intervals/{intervalId}, for the SAME real actor,
// in a real database (e2e DB). Both write an interval's status, so both must
// apply the same Program Increment rules:
//
//   1. one sprint runs at a time, and a running PI is not a competitor;
//   2. a PI is never started by hand;
//   3. a PI completes only once every interval inside it has;
//   4. starting a sprint starts the PI around it.
//
// And the re-parent rules both had already, which moved into the same function.
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
import { updateInterval } from "./projects";
import { PUT as intervalRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/route";
import { PARENT_NOT_A_PI } from "@/lib/intervals/pi-lifecycle";

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
