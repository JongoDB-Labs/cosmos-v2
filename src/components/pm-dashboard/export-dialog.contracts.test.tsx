import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// The vendor register is one row per contract, CRM data, and the export leaves
// it out without CRM_READ. The dialog must not offer what the server drops.
const perms = vi.hoisted(() => ({ crm: true }));
vi.mock("@/components/providers/permissions-provider", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/providers/permissions-provider")>();
  return {
    ...real,
    usePermissions: () => ({ can: (bit: bigint) => bit !== real.Permission.CRM_READ || perms.crm }),
  };
});

import { PmDashboard, type PmDashboardData } from "./pm-dashboard";

const empty: PmDashboardData = {
  milestones: [], kpis: [], goals: [], risks: [], deliverables: [], blockers: [], changes: [], clins: [],
};
const scope = { kind: "project" as const, orgId: "o1", projectId: "p1", projectKey: "KEY", projectName: "Proj" };

function openExport() {
  render(<PmDashboard scope={scope} data={empty} />);
  fireEvent.click(screen.getByRole("button", { name: /Export Excel/ }));
}

describe("the tracker export dialog and the vendor register", () => {
  it("does not offer the vendor register without CRM access, and says why", () => {
    perms.crm = false;
    openExport();
    // The other registers are offered: the dialog is open and populated.
    expect(screen.getByText("Deliverable Register")).toBeTruthy();
    expect(screen.queryByText("Vendors & Subs")).toBeNull();
    expect(screen.getByText(/vendor register is left out because you don't have CRM access/)).toBeTruthy();
  });

  it("control: with CRM access it is offered", () => {
    perms.crm = true;
    openExport();
    expect(screen.getByText("Vendors & Subs")).toBeTruthy();
    expect(screen.queryByText(/don't have CRM access/)).toBeNull();
  });
});
