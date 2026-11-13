// @vitest-environment jsdom
//
// (e2e DB) Every widget type, drawn from what the REAL routes return to a
// viewer, and nothing those routes would not.
//
// The widgets do not fetch. A dashboard loads its project's work items,
// sprints and members once, through the same routes (and the same project,
// team, classification and policy gates) as every other board, and hands each
// widget the bag derived from them. So the question "can a widget show data
// the viewer cannot see" is: can the bag hold it? This test builds the bag the
// way the dashboard does — from the route responses, as a plain member — puts
// one of every widget type on a grid, and checks:
//
//   * POSITIVE: each data widget shows the project's real items (so a probe
//     that saw nothing cannot pass the negative check below);
//   * NEGATIVE: nothing from the projects this member cannot read appears
//     anywhere in the rendered grid — not a title, a key, a sprint, a person,
//     or a custom field value planted to be caught by the sector registers;
//   * the routes themselves refuse the restricted projects, so no bag for them
//     can be built at all.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { render, cleanup, within, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextRequest } from "next/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/PA/boards/b1",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/rate-limit/guard", () => ({ checkRateLimit: () => null }));

import { prisma } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { seedWorld, type World } from "@/lib/query/__tests__/cql-fixture";
import { updateWorkItems } from "@/lib/work-items/write.server";
import { GET as getItems } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/route";
import { GET as getIntervals } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/route";
import { GET as getBoards } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/route";
import { GET as getMembers } from "@/app/api/v1/orgs/[orgId]/members/route";
import { projectStatusColumns } from "@/lib/boards/project-statuses";
import { deriveBoardWidgetData } from "../dashboard-derive";
import { WidgetGrid } from "../widget-grid";
import { IMPLEMENTED_WIDGET_TYPES } from "./board-widgets";
import { addDays, localDayKey } from "./widget-parts";
import type { BoardWidgetData } from "@/lib/boards/widget-data";
import type { BoardColumn, BuilderWidget, Interval, OrgMember, WorkItem } from "@/types/models";

let w: World;
let secrets: string[];
let data: BoardWidgetData;

const member = (): AuthContext => ({
  ...w.ctx({ denyP3: true }),
  permissions: RolePermissions.MEMBER,
  basePermissions: RolePermissions.MEMBER,
});

const TODAY = localDayKey(new Date());
const day = (n: number) => new Date(`${addDays(TODAY, n)}T00:00:00.000Z`);

async function call(
  handler: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
  path: string,
  params: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const res = await handler(new NextRequest(`http://localhost${path}`), {
    params: Promise.resolve(params),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON: a refusal body */
  }
  return { status: res.status, body };
}

/** What `jsonFetch` hands the board: the `data` of a `{ data }` envelope, else the body. */
const unwrap = <T,>(body: unknown): T =>
  body && typeof body === "object" && !Array.isArray(body) && "data" in body && Object.keys(body).length === 1
    ? ((body as { data: T }).data)
    : (body as T);

async function projectData(projectId: string) {
  const base = `/api/v1/orgs/${w.orgA}/projects/${projectId}`;
  const p = { orgId: w.orgA, projectId };
  return {
    items: await call(getItems as never, `${base}/work-items`, p),
    intervals: await call(getIntervals as never, `${base}/intervals`, p),
    boards: await call(getBoards as never, `${base}/boards`, p),
  };
}

beforeAll(async () => {
  w = await seedWorld();
  getAuthContext.mockImplementation(async () => member());
  const A = w.orgA;

  // Give the readable project something for every widget to show.
  const incident = await prisma.workItemType.create({ data: { orgId: A, key: "ops.incident", name: "Incident" } });
  await updateWorkItems(prisma, [w.items["p1-login-bug"].id], {
    startDate: day(-2),
    dueDate: day(3),
    customFields: { "aec.rfi-number": "RFI-101" },
  }, { actorId: null, source: "SYSTEM" });
  await updateWorkItems(prisma, [w.items["p1-coowned"].id], {
    workItemTypeId: incident.id,
    dueDate: day(-1),
  }, { actorId: null, source: "SYSTEM" });
  await updateWorkItems(prisma, [w.items["p1-done"].id], {
    customFields: { "aec.submittal-status": "approved" },
  }, { actorId: null, source: "SYSTEM" });
  await prisma.interval.update({
    where: { id: w.sprintP1Done },
    data: { report: { velocity: 3, totalStoryPoints: 5 } },
  });

  // …and plant, on the restricted twins, exactly the values the sector
  // registers and the time widgets would pick up if they ever reached them.
  const p2Secret = Object.entries(w.items).find(([k]) => k.startsWith("p2-secret"))![1].id;
  const p3Denied = Object.entries(w.items).find(([k]) => k.startsWith("p3-denied"))![1].id;
  const rfiSecret = `RFI-SECRET-${w.stamp}`;
  const p3Title = `Deniedtitle ${w.stamp}`;
  await updateWorkItems(prisma, [p2Secret], {
    workItemTypeId: incident.id,
    startDate: day(-1),
    dueDate: day(1),
    customFields: { "aec.rfi-number": rfiSecret, "aec.submittal-status": "approved" },
  }, { actorId: null, source: "SYSTEM" });
  await updateWorkItems(prisma, [p3Denied], {
    title: p3Title,
    startDate: day(-1),
    dueDate: day(1),
    customFields: { "aec.rfi-number": rfiSecret },
  }, { actorId: null, source: "SYSTEM" });
  secrets = [...w.secrets, rfiSecret, p3Title];

  // The bag, built exactly as the dashboard builds it.
  const p1 = await projectData(w.P1.id);
  expect(p1.items.status).toBe(200);
  expect(p1.intervals.status).toBe(200);
  expect(p1.boards.status).toBe(200);
  const members = await call(getMembers as never, `/api/v1/orgs/${A}/members`, { orgId: A });
  expect(members.status).toBe(200);
  const columns = projectStatusColumns(unwrap<Array<{ columns?: BoardColumn[] }>>(p1.boards.body) as never) as BoardColumn[];
  data = deriveBoardWidgetData({
    items: unwrap<WorkItem[]>(p1.items.body),
    columns,
    members: unwrap<OrgMember[]>(members.body),
    intervals: unwrap<Interval[]>(p1.intervals.body),
    projectKey: w.P1.key,
    now: new Date(),
  });
}, 60_000);

afterEach(cleanup);
afterAll(async () => {
  await w?.cleanup();
});

function renderAll() {
  const widgets: BuilderWidget[] = IMPLEMENTED_WIDGET_TYPES.map((type, i) => ({
    id: `w${i}`,
    type,
    config:
      type === "link-list"
        ? { links: "Docs|https://example.com/docs" }
        : type === "text-block"
          ? { content: "Standup notes" }
          : {},
    layout: { x: (i % 2) * 6, y: Math.floor(i / 2) * 8, w: 6, h: 8 },
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <WidgetGrid widgets={widgets} data={data} orgId={w.orgA} projectId={w.P1.id} boardId="b1" />
    </QueryClientProvider>,
  );
  const tileOf = (type: string) => {
    const id = `w${IMPLEMENTED_WIDGET_TYPES.indexOf(type as never)}`;
    for (const el of screen.getAllByTestId(`widget-body-${id}`)) {
      if (el.closest(".react-grid-item")) return el;
    }
    throw new Error(`no tile for ${type}`);
  };
  return { ...view, tileOf };
}

describe("every widget, over what the routes return to a member (e2e DB)", () => {
  it("draws the project's real items", () => {
    const { tileOf } = renderAll();
    const key = (name: string) => `${w.P1.key}-${w.items[name].ticketNumber}`;

    // Five live items (the archived one is not on a board).
    expect(within(tileOf("counter")).getByText("5")).toBeTruthy();
    expect(tileOf("table").textContent).toContain("p1-login-bug");
    expect(tileOf("list").textContent).toContain(key("p1-unassigned"));
    expect(tileOf("grouped-list").textContent).toContain("p1-coowned");
    expect(tileOf("checklist").textContent).toContain("p1-done");
    expect(tileOf("activity-feed").textContent).toContain(key("p1-login-bug"));
    expect(tileOf("deadline-list").textContent).toContain(key("p1-login-bug"));
    expect(tileOf("gantt").textContent).toContain(key("p1-login-bug"));
    expect(tileOf("timeline-widget").textContent).toContain(key("p1-coowned"));
    expect(tileOf("aec.rfi-tracker").textContent).toContain("RFI-101");
    expect(tileOf("aec.submittal-log").textContent).toContain(key("p1-done"));
    expect(tileOf("ops.incident-summary").textContent).toContain("p1-coowned");
    expect(within(tileOf("gauge")).getByRole("img").getAttribute("aria-label")).toBe(
      "Completed: 20% (1 of 5)",
    );
    // The velocity chart's bars are SVG that jsdom does not lay out, so its
    // input is checked where the widget reads it.
    expect(data.velocity).toEqual([
      { id: w.sprintP1Done, name: "Sprint 0", completed: 3, committed: 5 },
    ]);
    expect(within(tileOf("quick-action")).getByRole("button", { name: /New work item/ })).toBeTruthy();
  });

  it("shows nothing from a project the member cannot read", () => {
    const { container } = renderAll();
    const html = container.innerHTML;
    // Positive control for the probe: the readable project's key IS in there.
    expect(html).toContain(w.P1.key);
    for (const secret of secrets) {
      expect(html, `leaked: ${secret}`).not.toContain(secret);
    }
    // And the bag itself holds nothing from elsewhere.
    expect(JSON.stringify(data)).not.toMatch(new RegExp(secrets.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")));
  });

  it("cannot be built for a restricted project: its routes refuse", async () => {
    for (const [label, projectId] of [
      ["team-scoped P2", w.P2.id],
      ["policy-denied P3", w.P3.id],
    ] as const) {
      const r = await projectData(projectId);
      expect([403, 404], `${label} work-items`).toContain(r.items.status);
      expect(JSON.stringify(r.items.body)).not.toContain("RFI-SECRET");
    }
    // P2's sprints are refused too (P3's policy denies items, not sprints).
    expect([403, 404]).toContain((await projectData(w.P2.id)).intervals.status);
  });
});
