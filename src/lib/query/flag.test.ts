// The CQL switch defaults ON.
//
// It shipped per-org "until the whole feature is in, then the switch is
// deleted" — and the feature went in, but nothing in the product could ever
// set it: `withCqlEnabled` existed only in test files. The result was a
// subsystem nobody could reach, discovered when the assistant told a user CQL
// was unavailable for their org. Unset must therefore mean ON; an org that
// genuinely wants it off has to say so.
import { describe, it, expect } from "vitest";
import { cqlEnabled, withCqlEnabled } from "./flag";

describe("cqlEnabled", () => {
  it("is on for an org that has never been configured", () => {
    expect(cqlEnabled(undefined)).toBe(true);
    expect(cqlEnabled(null)).toBe(true);
    expect(cqlEnabled({})).toBe(true);
    expect(cqlEnabled({ cql: {} })).toBe(true);
    // Other settings present, no `cql` key — the real shape of a live org.
    expect(cqlEnabled({ navLayout: { hidden: [] }, intakeLimits: {} })).toBe(true);
  });

  it("is off only when an org explicitly says false", () => {
    expect(cqlEnabled({ cql: { enabled: false } })).toBe(false);
  });

  it("stays on when explicitly true, and round-trips through withCqlEnabled", () => {
    expect(cqlEnabled({ cql: { enabled: true } })).toBe(true);
    expect(cqlEnabled(withCqlEnabled({}, false))).toBe(false);
    expect(cqlEnabled(withCqlEnabled(withCqlEnabled({}, false), true))).toBe(true);
  });

  it("keeps the rest of an org's settings when the switch is written", () => {
    const before = { navLayout: { hidden: ["x"] }, intakeLimits: { perOrgPerRun: 50 } };
    expect(withCqlEnabled(before, false)).toMatchObject(before);
  });
});
