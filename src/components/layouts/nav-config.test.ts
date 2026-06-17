import { describe, expect, it } from "vitest";
import { applyEntitlements, SIDEBAR_NAV } from "./nav-config";

const ids = (entries: { id: string }[]) => entries.map((e) => e.id);

describe("applyEntitlements", () => {
  it("returns everything when enabledModules is null (all on)", () => {
    expect(applyEntitlements(SIDEBAR_NAV, null)).toBe(SIDEBAR_NAV);
  });

  it("keeps only allowlisted modules plus the fixed anchors", () => {
    const out = applyEntitlements(SIDEBAR_NAV, ["crm"]);
    // overview + settings are FIXED (always kept); crm is allowlisted.
    expect(ids(out).sort()).toEqual(["crm", "overview", "settings"]);
  });

  it("drops a module that is not in the allowlist", () => {
    const out = applyEntitlements(SIDEBAR_NAV, ["projects"]);
    expect(ids(out)).not.toContain("analytics");
    expect(ids(out)).toContain("projects");
    expect(ids(out)).toContain("overview");
  });
});
