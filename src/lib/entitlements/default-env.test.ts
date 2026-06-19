import { describe, expect, it, vi } from "vitest";
import { parseEnabledCsv, resolveDefaultEntitlements } from "./default-env";
import { ALL_MODULE_KEYS, SECTORS } from "./modules";
import { PRODUCT_PROFILES } from "@/lib/product/profiles";

describe("parseEnabledCsv", () => {
  const vocab = SECTORS as readonly string[];

  it("returns undefined when the raw value is undefined (unset)", () => {
    expect(parseEnabledCsv(undefined, vocab)).toBeUndefined();
  });

  it("returns an empty array for an empty / whitespace string (restrict all)", () => {
    expect(parseEnabledCsv("", vocab)).toEqual([]);
    expect(parseEnabledCsv("   ", vocab)).toEqual([]);
  });

  it("splits, trims, lowercases, and de-dupes valid tokens", () => {
    expect(parseEnabledCsv(" aec, AEC ,software ", vocab)).toEqual(["aec", "software"]);
  });

  it("drops tokens not in the vocab (invalid ignored)", () => {
    // "banana" is not a sector → dropped; "aec" kept.
    expect(parseEnabledCsv("aec,banana", vocab)).toEqual(["aec"]);
  });
});

describe("resolveDefaultEntitlements", () => {
  const cosmos = PRODUCT_PROFILES.cosmos; // defaults: null / null
  const pontis = PRODUCT_PROFILES.pontis; // defaults: null modules / ["aec"] sectors

  it("falls back to the profile when both envs are unset (cosmos → null = all)", () => {
    expect(
      resolveDefaultEntitlements({ modulesEnv: undefined, sectorsEnv: undefined }, cosmos),
    ).toBeNull();
  });

  it("falls back to the profile when both envs are unset (pontis → aec sectors)", () => {
    const row = resolveDefaultEntitlements(
      { modulesEnv: undefined, sectorsEnv: undefined },
      pontis,
    );
    expect(row).toEqual({
      moduleAllowlistEnabled: false,
      enabledModules: [],
      sectorAllowlistEnabled: true,
      enabledSectors: ["aec"],
    });
  });

  it("the sectors env overrides the profile sector default", () => {
    const row = resolveDefaultEntitlements(
      { modulesEnv: undefined, sectorsEnv: "software,ops" },
      pontis,
    );
    expect(row).toEqual({
      moduleAllowlistEnabled: false,
      enabledModules: [],
      sectorAllowlistEnabled: true,
      enabledSectors: ["software", "ops"],
    });
  });

  it("the modules env overrides the profile module default", () => {
    const row = resolveDefaultEntitlements(
      { modulesEnv: "crm,projects", sectorsEnv: undefined },
      cosmos,
    );
    expect(row).toEqual({
      moduleAllowlistEnabled: true,
      enabledModules: ["crm", "projects"],
      sectorAllowlistEnabled: false,
      enabledSectors: [],
    });
  });

  it("an empty-string env restricts that axis to nothing (allowlist on, empty)", () => {
    const row = resolveDefaultEntitlements(
      { modulesEnv: "", sectorsEnv: undefined },
      cosmos,
    );
    expect(row).toEqual({
      moduleAllowlistEnabled: true,
      enabledModules: [],
      sectorAllowlistEnabled: false,
      enabledSectors: [],
    });
  });

  it("invalid env tokens are dropped + a warning is emitted", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const row = resolveDefaultEntitlements(
      { modulesEnv: "crm,bogus", sectorsEnv: undefined },
      cosmos,
    );
    expect(row?.enabledModules).toEqual(["crm"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("explicit DEFAULT_ENABLED_SECTORS=aec on pontis matches the profile default (idempotent)", () => {
    // The ĒSO deploy sets DEFAULT_ENABLED_SECTORS=aec explicitly even though the
    // pontis profile already defaults to ["aec"] — the result must be identical.
    const row = resolveDefaultEntitlements(
      { modulesEnv: undefined, sectorsEnv: "aec" },
      pontis,
    );
    expect(row).toEqual({
      moduleAllowlistEnabled: false,
      enabledModules: [],
      sectorAllowlistEnabled: true,
      enabledSectors: ["aec"],
    });
  });

  it("module env validates against ALL_MODULE_KEYS (time-tracking is valid)", () => {
    const row = resolveDefaultEntitlements(
      { modulesEnv: "time-tracking", sectorsEnv: undefined },
      cosmos,
    );
    expect(row?.enabledModules).toEqual(["time-tracking"]);
    expect(ALL_MODULE_KEYS).toContain("time-tracking");
  });
});
