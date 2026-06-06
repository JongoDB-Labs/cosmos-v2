import { describe, expect, it } from "vitest";
import { buildCrumbs } from "./breadcrumbs";

describe("buildCrumbs", () => {
  it("returns empty for root", () => {
    expect(buildCrumbs("/", [])).toEqual([]);
  });

  it("maps org slug to org name", () => {
    const orgs = [{ slug: "fsc", name: "Fighting Smart Cyber" }];
    expect(buildCrumbs("/fsc", orgs)).toEqual([
      { label: "Fighting Smart Cyber", href: "/fsc" },
    ]);
  });

  it("titlecases subsequent segments", () => {
    const orgs = [{ slug: "fsc", name: "Fighting Smart Cyber" }];
    expect(buildCrumbs("/fsc/time-tracking", orgs)).toEqual([
      { label: "Fighting Smart Cyber", href: "/fsc" },
      { label: "Time Tracking", href: "/fsc/time-tracking" },
    ]);
  });

  it("returns org chip even when no match found", () => {
    expect(buildCrumbs("/unknown", [])).toEqual([
      { label: "unknown", href: "/unknown" },
    ]);
  });

  it("applies acronym overrides instead of naive title-casing", () => {
    const orgs = [{ slug: "fsc", name: "Fighting Smart Cyber" }];
    expect(buildCrumbs("/fsc/crm", orgs)).toEqual([
      { label: "Fighting Smart Cyber", href: "/fsc" },
      { label: "CRM", href: "/fsc/crm" },
    ]);
  });
});
