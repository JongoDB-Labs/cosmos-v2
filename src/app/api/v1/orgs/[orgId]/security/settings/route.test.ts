import { describe, it, expect } from "vitest";
import { AccountRequestMode } from "@prisma/client";
import {
  clampGovRetentionDays,
  GOV_AUDIT_RETENTION_FLOOR_DAYS,
  allowlistWithoutDomains,
} from "./route";

describe("clampGovRetentionDays (AU-11 gov retention floor)", () => {
  it("coerces a GOV tenant below the 3yr floor up to 1095 days", () => {
    expect(clampGovRetentionDays("GOV", 30)).toBe(GOV_AUDIT_RETENTION_FLOOR_DAYS);
    expect(clampGovRetentionDays("GOV", 1094)).toBe(1095);
  });

  it("leaves a GOV tenant at or above the floor unchanged", () => {
    expect(clampGovRetentionDays("GOV", 1095)).toBe(1095);
    expect(clampGovRetentionDays("GOV", 3650)).toBe(3650);
  });

  it("does not clamp commercial tenants below the gov floor", () => {
    expect(clampGovRetentionDays("COMMERCIAL", 30)).toBe(30);
    expect(clampGovRetentionDays("COMMERCIAL", 90)).toBe(90);
  });

  it("passes through undefined (no retention change requested)", () => {
    expect(clampGovRetentionDays("GOV", undefined)).toBeUndefined();
    expect(clampGovRetentionDays("COMMERCIAL", undefined)).toBeUndefined();
  });
});

describe("allowlistWithoutDomains (a restriction that would accept everyone)", () => {
  it("refuses ALLOWLIST with no usable domains", () => {
    expect(allowlistWithoutDomains(AccountRequestMode.ALLOWLIST, [])).toBe(true);
    expect(allowlistWithoutDomains(AccountRequestMode.ALLOWLIST, ["  ", ""])).toBe(true);
  });

  it("allows ALLOWLIST once a domain is configured", () => {
    expect(allowlistWithoutDomains(AccountRequestMode.ALLOWLIST, ["corp.test"])).toBe(false);
  });

  it("does not interfere with the other modes, where an empty list is meaningless", () => {
    for (const mode of [AccountRequestMode.OFF, AccountRequestMode.OPEN, undefined]) {
      expect(allowlistWithoutDomains(mode, [])).toBe(false);
    }
  });
});
