import { describe, it, expect } from "vitest";
import { canManageAllowances, timeOffBalance, timeOffPolicy } from "./time-off-balance";
import { Permission } from "@/lib/rbac/permissions";

// 2026-03-02 is a Monday. A Mon–Fri week at 8h/day is 40h.
const week = (start: string, end: string, status: string, kind = "VACATION") => ({
  kind,
  status,
  startDate: start,
  endDate: end,
  hoursPerDay: 8,
});
const opts = { year: 2026, today: "2026-06-15", countedKinds: ["VACATION"], allowance: 120 };

describe("timeOffBalance", () => {
  it("splits approved leave into used (to today) and still to come, and subtracts both from the allowance", () => {
    const b = timeOffBalance(
      [week("2026-03-02", "2026-03-06", "APPROVED"), week("2026-08-03", "2026-08-07", "APPROVED")],
      opts,
    );
    expect(b).toEqual({ requested: 0, approved: 40, used: 40, allowance: 120, remaining: 40 });
  });

  it("a request spanning today is part used, part to come", () => {
    // Mon 15 June (today) to Fri 19 June: Monday used, Tue–Fri to come.
    const b = timeOffBalance([week("2026-06-15", "2026-06-19", "APPROVED")], opts);
    expect(b.used).toBe(8);
    expect(b.approved).toBe(32);
  });

  it("pending is reported, but NOT taken off the remaining figure — nobody has agreed to it", () => {
    const b = timeOffBalance([week("2026-09-07", "2026-09-11", "PENDING")], opts);
    expect(b.requested).toBe(40);
    expect(b.remaining).toBe(120);
  });

  it("denied and withdrawn requests never happened", () => {
    const b = timeOffBalance(
      [week("2026-03-02", "2026-03-06", "DENIED"), week("2026-03-09", "2026-03-13", "WITHDRAWN")],
      opts,
    );
    expect(b).toMatchObject({ requested: 0, approved: 0, used: 0, remaining: 120 });
  });

  it("only the counted kinds draw on the allowance", () => {
    const b = timeOffBalance([week("2026-03-02", "2026-03-06", "APPROVED", "SICK")], opts);
    expect(b.used).toBe(0);
    expect(b.remaining).toBe(120);
  });

  it("a request across New Year counts only its days in this year", () => {
    // Mon 28 Dec 2026 – Fri 1 Jan 2027: 4 working days in 2026, 1 in 2027.
    const r = [week("2026-12-28", "2027-01-01", "APPROVED")];
    expect(timeOffBalance(r, opts).approved).toBe(32);
    expect(timeOffBalance(r, { ...opts, year: 2027, today: "2026-06-15" }).approved).toBe(8);
  });

  it("a past year is all used; a future year is all to come", () => {
    const r = [week("2025-03-03", "2025-03-07", "APPROVED")];
    expect(timeOffBalance(r, { ...opts, year: 2025 })).toMatchObject({ used: 40, approved: 0 });
    const f = [week("2027-03-01", "2027-03-05", "APPROVED")];
    expect(timeOffBalance(f, { ...opts, year: 2027 })).toMatchObject({ used: 0, approved: 40 });
  });

  it("no allowance: no remaining figure, rather than a fake zero", () => {
    expect(timeOffBalance([], { ...opts, allowance: null }).remaining).toBeNull();
  });

  it("overdrawn reads negative", () => {
    const b = timeOffBalance([week("2026-03-02", "2026-03-06", "APPROVED")], { ...opts, allowance: 16 });
    expect(b.remaining).toBe(-24);
  });
});

describe("timeOffPolicy", () => {
  it("defaults: no allowance, vacation counts", () =>
    expect(timeOffPolicy({})).toEqual({ annualAllowanceHours: null, countedKinds: ["VACATION"] }));
  it("reads the org's policy", () =>
    expect(timeOffPolicy({ time: { timeOff: { annualAllowanceHours: 160, countedKinds: ["VACATION", "OTHER"] } } })).toEqual({
      annualAllowanceHours: 160,
      countedKinds: ["VACATION", "OTHER"],
    }));
  it("ignores an unknown kind rather than counting nothing", () =>
    expect(timeOffPolicy({ time: { timeOff: { countedKinds: ["NAP"] } } }).countedKinds).toEqual(["VACATION"]));
});

describe("canManageAllowances", () => {
  it("needs BOTH org-wide time access and approval rights", () => {
    expect(canManageAllowances(Permission.TIME_READ_ALL | Permission.TIME_APPROVE)).toBe(true);
    expect(canManageAllowances(Permission.TIME_APPROVE)).toBe(false);
    expect(canManageAllowances(Permission.TIME_READ_ALL)).toBe(false);
  });
});
