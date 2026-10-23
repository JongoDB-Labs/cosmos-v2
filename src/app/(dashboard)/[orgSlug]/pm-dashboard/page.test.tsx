// @vitest-environment node
//
// The org PM Dashboard is linked from the sidebar, so it must (a) enforce the
// permission its nav entry declares and (b) roll up only the projects the
// viewer may see: a team-restricted project they aren't on stays out of every
// register and total.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { Permission } from "@/lib/rbac/permissions";

const { prisma, getAuthContext, getVisibleProjectIds, loaders } = vi.hoisted(() => {
  const rows = () => ({ findMany: vi.fn(async () => []) });
  return {
    prisma: {
      organization: { findUnique: vi.fn(async () => ({ name: "Acme" })) },
      project: { findMany: vi.fn(async () => [{ id: "p-open" }, { id: "p-restricted" }]) },
      goal: rows(),
      risk: rows(),
      deliverable: rows(),
      blocker: rows(),
      changeRequest: rows(),
    },
    getAuthContext: vi.fn(),
    getVisibleProjectIds: vi.fn(async () => new Set(["p-open"])),
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

import OrgPmDashboardPage from "./page";
import { PmDashboard } from "@/components/pm-dashboard/pm-dashboard";
import { PageShell } from "@/components/ui/page-shell";

const params = Promise.resolve({ orgSlug: "acme" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("org PM Dashboard", () => {
  it("rolls up only the projects the viewer may see", async () => {
    getAuthContext.mockResolvedValue({ orgId: "o1", userId: "u1", permissions: Permission.ANALYTICS_READ | Permission.PROJECT_READ });
    const el = (await OrgPmDashboardPage({ params })) as ReactElement;
    expect(isValidElement(el) && el.type).toBe(PmDashboard);

    expect(getVisibleProjectIds).toHaveBeenCalledWith(expect.anything(), ["p-open", "p-restricted"]);
    for (const load of Object.values(loaders)) expect(load).toHaveBeenCalledWith("o1", ["p-open"]);
    for (const model of ["goal", "risk", "deliverable", "blocker", "changeRequest"] as const) {
      const where = (prisma[model].findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
      expect(where).toMatchObject({ orgId: "o1", projectId: { in: ["p-open"] } });
    }
  });

  it("shows no-access, and loads nothing, without the nav entry's permission", async () => {
    getAuthContext.mockResolvedValue({ orgId: "o1", userId: "u1", permissions: Permission.PROJECT_READ });
    const el = (await OrgPmDashboardPage({ params })) as ReactElement;
    expect(isValidElement(el) && el.type).toBe(PageShell);
    expect(prisma.project.findMany).not.toHaveBeenCalled();
    expect(loaders.milestones).not.toHaveBeenCalled();
  });
});
