// @vitest-environment node
//
// Program Management is linked from the sidebar, so it must (a) enforce the
// permission its nav entry declares, (b) roll up only the projects the viewer
// may see -- a team-restricted project they aren't on stays out of every
// register and total -- and (c) keep contract money behind its own permission,
// which is new here and is the reason most of this file exists.
//
// The ?project= scope is tested against an UNREADABLE key as well as a valid
// one. Scoping by a key from the URL is a read of someone else's data if the
// key is honoured without checking it first, and the check is one `.find` on a
// list that is easy to build from the wrong array.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { Permission } from "@/lib/rbac/permissions";

const { prisma, getAuthContext, getVisibleProjectIds, loaders } = vi.hoisted(() => {
  const rows = () => ({ findMany: vi.fn(async () => []) });
  return {
    prisma: {
      organization: { findUnique: vi.fn(async () => ({ name: "Acme" })) },
      project: {
        findMany: vi.fn(async () => [
          { id: "p-open", key: "OPEN", name: "Open project" },
          { id: "p-other", key: "OTHER", name: "Other project" },
          { id: "p-restricted", key: "SECRET", name: "Restricted project" },
        ]),
      },
      goal: rows(),
      risk: rows(),
      deliverable: rows(),
      blocker: rows(),
      changeRequest: rows(),
    },
    getAuthContext: vi.fn(),
    // TWO visible: with one, a page that ignored ?project= entirely would
    // produce the same ids as one that narrowed correctly.
    getVisibleProjectIds: vi.fn(async () => new Set(["p-open", "p-other"])),
    loaders: {
      milestones: vi.fn(async () => []),
      kpis: vi.fn(async () => []),
      clins: vi.fn(async () => []),
    },
  };
});

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/rbac/project-access", () => ({ getVisibleProjectIds }));
vi.mock("@/lib/pm/schedule", () => ({ loadMilestonesWithDerived: loaders.milestones }));
vi.mock("@/lib/pm/kpi-derive", () => ({ loadKpisWithDerived: loaders.kpis }));
vi.mock("@/lib/pm/burn", () => ({ loadClinsWithBurn: loaders.clins }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("redirect");
  }),
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));
vi.mock("@/components/pm-dashboard/pm-dashboard", () => ({ PmDashboard: () => null }));
vi.mock("@/components/ui/page-shell", () => ({ PageShell: () => null }));
vi.mock("@/components/ui/no-page-access", () => ({ NoPageAccess: () => null }));
vi.mock("./project-picker", () => ({ ProjectPicker: () => null }));
vi.mock("./embedded-dashboard", () => ({ EmbeddedDashboard: () => null }));

import { ProgramManagementContent } from "./page";
import { PageShell } from "@/components/ui/page-shell";

const params = Promise.resolve({ orgSlug: "acme" });
const noQuery = Promise.resolve({});

/** Everything the page needs EXCEPT the money permission. */
const PROGRAM_ONLY = Permission.ANALYTICS_READ | Permission.PROJECT_READ;

function signedInWith(permissions: bigint) {
  getAuthContext.mockResolvedValue({ orgId: "o1", userId: "u1", permissions });
}

/** The `projectId.in` list every register was queried with. */
function scopedIds(): unknown {
  const call = prisma.risk.findMany.mock.calls[0] as unknown as [
    { where: { projectId: { in: string[] } } },
  ];
  return call[0].where.projectId.in;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PROGRAM_MANAGEMENT_EMBED_URL;
  delete process.env.PROGRAM_MANAGEMENT_SIGN_IN_URL;
});

afterEach(() => {
  delete process.env.PROGRAM_MANAGEMENT_EMBED_URL;
  delete process.env.PROGRAM_MANAGEMENT_SIGN_IN_URL;
});

describe("Program Management — scope", () => {
  it("rolls up only the projects the viewer may see", async () => {
    signedInWith(PROGRAM_ONLY);
    await ProgramManagementContent({ params, searchParams: noQuery });

    expect(getVisibleProjectIds).toHaveBeenCalledWith(expect.anything(), [
      "p-open",
      "p-other",
      "p-restricted",
    ]);
    for (const load of Object.values(loaders)) {
      // clins is gated separately; the other two take the visible set.
      if (load === loaders.clins) continue;
      expect(load).toHaveBeenCalledWith("o1", ["p-open", "p-other"]);
    }
    for (const model of ["goal", "risk", "deliverable", "blocker", "changeRequest"] as const) {
      const where = (
        prisma[model].findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }]
      )[0].where;
      expect(where).toMatchObject({ orgId: "o1", projectId: { in: ["p-open", "p-other"] } });
    }
  });

  it("narrows to one project when ?project= names a readable one", async () => {
    signedInWith(PROGRAM_ONLY);
    await ProgramManagementContent({
      params,
      searchParams: Promise.resolve({ project: "OPEN" }),
    });
    expect(scopedIds()).toEqual(["p-open"]);
  });

  it("ignores ?project= naming a project the viewer may NOT see", async () => {
    // The whole point: SECRET is a real key, and it is in the list this page
    // loaded from the database -- it is only absent from the VISIBLE list. A
    // `.find` over the wrong array here would scope the page to someone
    // else's program and read as working.
    signedInWith(PROGRAM_ONLY);
    await ProgramManagementContent({
      params,
      searchParams: Promise.resolve({ project: "SECRET" }),
    });
    expect(scopedIds()).toEqual(["p-open", "p-other"]);
    expect(scopedIds()).not.toContain("p-restricted");
  });

  it("falls back to the portfolio for a key that matches nothing", async () => {
    signedInWith(PROGRAM_ONLY);
    await ProgramManagementContent({
      params,
      searchParams: Promise.resolve({ project: "GONE" }),
    });
    expect(scopedIds()).toEqual(["p-open", "p-other"]);
  });
});

describe("Program Management — contract money is gated separately from the page", () => {
  it("does not even query CLIN burn without a finance permission", async () => {
    signedInWith(PROGRAM_ONLY);
    await ProgramManagementContent({ params, searchParams: noQuery });
    expect(loaders.clins).not.toHaveBeenCalled();
  });

  it("withholds a change request's cost impact but keeps its schedule impact", async () => {
    prisma.changeRequest.findMany.mockResolvedValueOnce([
      {
        id: "c1",
        code: "CR-1",
        title: "Add a sensor",
        type: "SCOPE",
        status: "APPROVED",
        costImpact: 125000,
        scheduleDaysImpact: 14,
      },
    ] as never);
    signedInWith(PROGRAM_ONLY);
    const el = (await ProgramManagementContent({
      params,
      searchParams: noQuery,
    })) as ReactElement;

    const change = dashboardData(el).changes[0];
    expect(change.costImpact).toBeNull();
    // Positive control: the row itself is still there, and the part of it that
    // is NOT money still arrives. A test that only asserted the null would
    // pass just as happily against a page that dropped the row entirely.
    expect(change.code).toBe("CR-1");
    expect(change.scheduleDaysImpact).toBe(14);
  });

  it("control: with a finance permission, the money loads and the figure survives", async () => {
    prisma.changeRequest.findMany.mockResolvedValueOnce([
      {
        id: "c1",
        code: "CR-1",
        title: "Add a sensor",
        type: "SCOPE",
        status: "APPROVED",
        costImpact: 125000,
        scheduleDaysImpact: 14,
      },
    ] as never);
    signedInWith(PROGRAM_ONLY | Permission.FINANCE_READ);
    const el = (await ProgramManagementContent({
      params,
      searchParams: noQuery,
    })) as ReactElement;

    expect(loaders.clins).toHaveBeenCalledWith("o1", ["p-open", "p-other"]);
    expect(dashboardData(el).changes[0].costImpact).toBe(125000);
  });

  it("ACCOUNTING_READ opens it too, as it does on the Accounting pages", async () => {
    signedInWith(PROGRAM_ONLY | Permission.ACCOUNTING_READ);
    await ProgramManagementContent({ params, searchParams: noQuery });
    expect(loaders.clins).toHaveBeenCalledWith("o1", ["p-open", "p-other"]);
  });
});

describe("Program Management — page permission", () => {
  it("shows no-access, and loads nothing, without the nav entry's permission", async () => {
    signedInWith(Permission.PROJECT_READ);
    const el = (await ProgramManagementContent({
      params,
      searchParams: noQuery,
    })) as ReactElement;
    expect(isValidElement(el) && el.type).toBe(PageShell);
    expect(prisma.project.findMany).not.toHaveBeenCalled();
    expect(loaders.milestones).not.toHaveBeenCalled();
    expect(loaders.clins).not.toHaveBeenCalled();
  });
});

describe("Program Management — an outside dashboard, when the instance sets one", () => {
  const URL_SET = "https://pm.example.com/";

  it("frames the configured dashboard instead of the built-in page", async () => {
    process.env.PROGRAM_MANAGEMENT_EMBED_URL = URL_SET;
    signedInWith(PROGRAM_ONLY);
    const el = (await ProgramManagementContent({ params, searchParams: noQuery })) as ReactElement;

    const frame = findByDisplayName(el, "EmbeddedDashboard");
    expect(frame?.props).toEqual({ src: URL_SET, signInSrc: URL_SET });
    expect(findByDisplayName(el, "PmDashboard")).toBeNull();
    // Nothing the built-in page needs is read for a page that will not show it.
    expect(prisma.project.findMany).not.toHaveBeenCalled();
    expect(loaders.milestones).not.toHaveBeenCalled();
    expect(prisma.risk.findMany).not.toHaveBeenCalled();
  });

  it("opens sign-in at the dashboard's sign-in start when the instance names one", async () => {
    process.env.PROGRAM_MANAGEMENT_EMBED_URL = URL_SET;
    process.env.PROGRAM_MANAGEMENT_SIGN_IN_URL = "https://pm.example.com/auth/start?next=/home";
    signedInWith(PROGRAM_ONLY);
    const el = (await ProgramManagementContent({ params, searchParams: noQuery })) as ReactElement;
    expect(findByDisplayName(el, "EmbeddedDashboard")?.props).toEqual({
      src: URL_SET,
      signInSrc: "https://pm.example.com/auth/start?next=/home",
    });
  });

  it("ignores a sign-in URL on another site, opening the dashboard instead", async () => {
    process.env.PROGRAM_MANAGEMENT_EMBED_URL = URL_SET;
    process.env.PROGRAM_MANAGEMENT_SIGN_IN_URL = "https://elsewhere.example.net/auth/start";
    signedInWith(PROGRAM_ONLY);
    const el = (await ProgramManagementContent({ params, searchParams: noQuery })) as ReactElement;
    expect(findByDisplayName(el, "EmbeddedDashboard")?.props).toEqual({ src: URL_SET, signInSrc: URL_SET });
  });

  it("still enforces the page's permission: no access means no frame", async () => {
    process.env.PROGRAM_MANAGEMENT_EMBED_URL = URL_SET;
    signedInWith(Permission.PROJECT_READ);
    const el = (await ProgramManagementContent({ params, searchParams: noQuery })) as ReactElement;
    expect(findByDisplayName(el, "EmbeddedDashboard")).toBeNull();
    expect(findByDisplayName(el, "NoPageAccess")).not.toBeNull();
  });

  it("falls back to the built-in page when the URL is unusable", async () => {
    // Plain http to a real host is refused (src/lib/pm/embed.ts), and the
    // page must then be the built-in one, not an empty frame.
    process.env.PROGRAM_MANAGEMENT_EMBED_URL = "http://pm.example.com/";
    signedInWith(PROGRAM_ONLY);
    const el = (await ProgramManagementContent({ params, searchParams: noQuery })) as ReactElement;
    expect(findByDisplayName(el, "EmbeddedDashboard")).toBeNull();
    expect(findByDisplayName(el, "PmDashboard")).not.toBeNull();
  });

  it("control: unset, the built-in page renders as before", async () => {
    signedInWith(PROGRAM_ONLY);
    const el = (await ProgramManagementContent({ params, searchParams: noQuery })) as ReactElement;
    expect(findByDisplayName(el, "PmDashboard")).not.toBeNull();
    expect(findByDisplayName(el, "EmbeddedDashboard")).toBeNull();
  });
});

/**
 * Dig the PmDashboard `data` prop out of the rendered tree. The page returns a
 * PageShell whose children are the notice and the dashboard, so this walks to
 * the dashboard rather than assuming a position.
 */
function dashboardData(el: ReactElement): {
  changes: { code: string; costImpact: number | null; scheduleDaysImpact: number }[];
} {
  const found = findByDisplayName(el, "PmDashboard");
  if (!found) throw new Error("PmDashboard was not rendered");
  return (found.props as { data: ReturnType<typeof dashboardData> }).data;
}

function findByDisplayName(node: unknown, name: string): ReactElement | null {
  if (!isValidElement(node)) return null;
  const type = node.type as { name?: string; displayName?: string } | string;
  if (typeof type !== "string" && (type.displayName === name || type.name === name)) {
    return node;
  }
  const kids = (node.props as { children?: unknown }).children;
  for (const child of Array.isArray(kids) ? kids : [kids]) {
    const hit = findByDisplayName(child, name);
    if (hit) return hit;
  }
  return null;
}
