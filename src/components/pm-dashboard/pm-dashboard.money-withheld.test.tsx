import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/providers/permissions-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/providers/permissions-provider")>()),
  usePermissions: () => ({ can: () => true }),
}));

import { PmDashboard, type PmDashboardData } from "./pm-dashboard";

const empty: PmDashboardData = {
  milestones: [],
  kpis: [],
  goals: [],
  risks: [],
  deliverables: [],
  blockers: [],
  changes: [],
  clins: [],
};
const scope = { kind: "org" as const, orgId: "o1", orgName: "Acme" };

describe("CLIN burn the viewer may not see", () => {
  it("says the figures need a finance permission, not that there are none", () => {
    // An empty panel reading "No CLINs yet." tells someone without finance
    // access that the contract has no CLINs -- the exact misreading the
    // Program Management page's under-construction notice exists to prevent.
    render(<PmDashboard scope={scope} data={empty} moneyWithheld />);
    expect(screen.getByText(/needs Finance access/i)).toBeTruthy();
    expect(screen.queryByText("No CLINs yet.")).toBeNull();
  });

  it("control: with the figures loaded and none on file, it says there are none", () => {
    render(<PmDashboard scope={scope} data={empty} />);
    expect(screen.getByText("No CLINs yet.")).toBeTruthy();
  });
});
