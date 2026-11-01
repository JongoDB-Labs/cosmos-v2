// @vitest-environment node
//
// "The gate is in the function, so the function is gated."
//
// `list_objectives` and `query_intervals` each carried a real `assertProjectRead` call —
// and each put it inside `if (projectId)`. Omit the argument and the gate is not on the
// path the data takes. `project-scope.arch.test.ts` greps function bodies for a gate NAME,
// so both passed it: the guard looked at them, found the string, and never asked whether
// the branch holding it was reachable.
//
// Neither read exists in the product. There is no `GET /orgs/[orgId]/objectives` and no
// `GET /orgs/[orgId]/intervals` — both live only under `/projects/[projectId]/…`, behind
// `requireProjectRead`. The agent invented a cross-project read the app never had.
//
// These specs use TWO real members and a team-scoped project. A single-actor fixture cannot
// show this boundary, and an actor who can see everything cannot show it either — so the
// MEMBER below is deliberately NOT on the restricted project's team.
//
// Needs the local e2e DB: DATABASE_URL=postgresql://ci:ci@localhost:5441/ci
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { listObjectives } from "./okrs";
import { executeTool } from "@/lib/ai/tool-executor";
import { memberToolCtx } from "@/lib/testing/tool-auth";
import type { ToolContext } from "./_ctx";

describe("cross-project reads on the OMITTED-projectId path (e2e DB)", () => {
  const cleanup: string[] = [];
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup } } }).catch(() => undefined);
  });

  let openProjectId: string;
  let restrictedProjectId: string;
  /** An OWNER: sees every project. The control that proves the data is really there. */
  let owner: ToolContext;
  /** A MEMBER who is NOT on the restricted project's team. The actor under test. */
  let outsider: ToolContext;

  beforeAll(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const bob = await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `xproj ${stamp}`, slug: `xproj-${stamp}` },
    });
    cleanup.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: alice.id, role: "OWNER" } });
    await prisma.orgMember.create({ data: { orgId: org.id, userId: bob.id, role: "MEMBER" } });

    const open = await prisma.project.create({
      data: { orgId: org.id, key: `OP${stamp.slice(-4)}`, name: "Open project" },
    });
    // teamScopedAccess is what makes a project invisible to a non-member. Without it every
    // project is readable by every member and there is no boundary to test.
    const restricted = await prisma.project.create({
      data: {
        orgId: org.id, key: `RS${stamp.slice(-4)}`, name: "Restricted project",
        teamScopedAccess: true,
      },
    });
    openProjectId = open.id;
    restrictedProjectId = restricted.id;

    for (const [projectId, title] of [
      [openProjectId, "open-objective"],
      [restrictedProjectId, "restricted-objective"],
    ] as const) {
      await prisma.objective.create({
        data: { orgId: org.id, projectId, title, status: "ACTIVE" },
      });
    }

    let n = 0;
    for (const [projectId, name] of [
      [openProjectId, "open-interval"],
      [restrictedProjectId, "restricted-interval"],
    ] as const) {
      await prisma.interval.create({
        data: {
          orgId: org.id, projectId, name, number: ++n,
          startDate: new Date("2026-01-01"), endDate: new Date("2026-01-14"),
        },
      });
    }

    owner = await memberToolCtx(org.id, alice.id);
    outsider = await memberToolCtx(org.id, bob.id);
    expect(owner.auth).toBeDefined();
    expect(outsider.auth).toBeDefined();
  });

  // ── list_objectives ──────────────────────────────────────────────────────────────
  const objectiveTitles = async (ctx: ToolContext, input: Record<string, unknown> = {}) => {
    const out = (await listObjectives(input, ctx)) as {
      objectives?: { title: string }[]; error?: string;
    };
    expect(out.error).toBeUndefined();
    return (out.objectives ?? []).map((o) => o.title).sort();
  };

  it("CONTROL: an OWNER omitting projectId sees both projects' objectives", async () => {
    expect(await objectiveTitles(owner)).toEqual(["open-objective", "restricted-objective"]);
  });

  it("list_objectives: a non-member omitting projectId no longer sees the restricted one", async () => {
    expect(await objectiveTitles(outsider)).toEqual(["open-objective"]);
  });

  it("list_objectives: naming the restricted project is still refused outright", async () => {
    const out = (await listObjectives({ projectId: restrictedProjectId }, outsider)) as {
      error?: string; objectives?: unknown[];
    };
    expect(out.error).toBeDefined();
    expect(out.objectives).toBeUndefined();
  });

  it("list_objectives: naming a project the actor CAN read still works", async () => {
    expect(await objectiveTitles(outsider, { projectId: openProjectId })).toEqual(["open-objective"]);
  });

  // ── query_intervals ──────────────────────────────────────────────────────────────
  // Through `executeTool`, the real dispatch entry point: this tool lives in the
  // tool-executor switch, which the executors' arch test never reads.
  const intervalNames = async (ctx: ToolContext, input: Record<string, unknown> = {}) => {
    const out = (await executeTool("query_intervals", input, ctx)) as {
      intervals?: { name: string }[]; error?: string;
    };
    expect(out.error).toBeUndefined();
    return (out.intervals ?? []).map((i) => i.name).sort();
  };

  it("CONTROL: an OWNER omitting projectId sees both projects' intervals", async () => {
    expect(await intervalNames(owner)).toEqual(["open-interval", "restricted-interval"]);
  });

  it("query_intervals: a non-member omitting projectId no longer sees the restricted one", async () => {
    // Pre-fix this returned BOTH: `isOptionalUuid(undefined)` passed, the gate passed
    // vacuously against an arbitrary project, and Prisma dropped `projectId: undefined`
    // from the where entirely.
    expect(await intervalNames(outsider)).toEqual(["open-interval"]);
  });

  it("query_intervals: naming the restricted project is refused, not silently empty", async () => {
    const out = (await executeTool("query_intervals", { projectId: restrictedProjectId }, outsider)) as {
      error?: string; intervals?: unknown[];
    };
    expect(out.error).toBe("Project not found");
    expect(out.intervals).toBeUndefined();
  });

  it("query_intervals: naming a project the actor CAN read still works", async () => {
    expect(await intervalNames(outsider, { projectId: openProjectId })).toEqual(["open-interval"]);
  });
});
