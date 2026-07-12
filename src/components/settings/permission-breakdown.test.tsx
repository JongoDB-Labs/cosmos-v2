import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PermissionBreakdown } from "./permission-breakdown";
import { ALL_PERMISSIONS } from "@/lib/rbac/permission-groups";
import type { PermissionKey } from "@/lib/rbac/permissions";

afterEach(cleanup);

// ITEM_READ + ITEM_UPDATE humanize/group with FINANCE_READ to give us two
// groups ("Item", "Finance") and a mix of repeated + distinct badge labels
// ("Read" appears under both groups; "Update" only under "Item").
const GRANTED: PermissionKey[] = ["ITEM_READ", "ITEM_UPDATE", "FINANCE_READ"];

describe("PermissionBreakdown", () => {
  it('renders a summary line reading "<granted> of <total> permissions"', () => {
    render(<PermissionBreakdown permissions={GRANTED} />);
    expect(
      screen.getByText(`3 of ${ALL_PERMISSIONS.length} permissions`),
    ).toBeInTheDocument();
  });

  it("renders one group header per group with a granted permission", () => {
    render(<PermissionBreakdown permissions={GRANTED} />);
    expect(screen.getByText("Item")).toBeInTheDocument();
    expect(screen.getByText("Finance")).toBeInTheDocument();
  });

  it("omits groups that have zero granted permissions", () => {
    render(<PermissionBreakdown permissions={GRANTED} />);
    // OKR_* permissions aren't in GRANTED, so the "Okr" group must not render.
    expect(screen.queryByText("Okr")).not.toBeInTheDocument();
  });

  it("renders a badge per granted permission, humanized the same way the role editor does", () => {
    render(<PermissionBreakdown permissions={GRANTED} />);
    // ITEM_READ and FINANCE_READ both humanize to "Read"; ITEM_UPDATE to "Update".
    expect(screen.getAllByText("Read")).toHaveLength(2);
    expect(screen.getByText("Update")).toBeInTheDocument();
  });

  it("shows a zero-granted summary and no group headers for an empty permission set", () => {
    render(<PermissionBreakdown permissions={[]} />);
    expect(
      screen.getByText(`0 of ${ALL_PERMISSIONS.length} permissions`),
    ).toBeInTheDocument();
    expect(screen.queryByText("Item")).not.toBeInTheDocument();
    expect(screen.queryByText("Finance")).not.toBeInTheDocument();
  });

  it("ignores unrecognized permission keys and counts only known permissions", () => {
    const withFakeKey = [
      "ITEM_READ",
      "NOT_A_REAL_KEY",
    ] as unknown as PermissionKey[];
    render(<PermissionBreakdown permissions={withFakeKey} />);
    expect(
      screen.getByText(`1 of ${ALL_PERMISSIONS.length} permissions`),
    ).toBeInTheDocument();
    expect(screen.getByText("Item")).toBeInTheDocument();
    // The fake key should not render as a badge
    expect(screen.queryByText("NOT_A_REAL_KEY")).not.toBeInTheDocument();
  });

  it("passes a custom className through to the root element", () => {
    const { container } = render(
      <PermissionBreakdown permissions={GRANTED} className="custom-class" />,
    );
    expect(container.firstElementChild).toHaveClass("custom-class");
  });
});
