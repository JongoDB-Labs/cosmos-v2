import { afterEach, describe, expect, it } from "vitest";
import { getBus, _resetBusForTests } from "./bus";

afterEach(() => {
  _resetBusForTests();
  delete process.env.REALTIME_BUS;
});

describe("getBus", () => {
  it("returns the same instance across calls", () => {
    process.env.REALTIME_BUS = "memory";
    const a = getBus();
    const b = getBus();
    expect(a).toBe(b);
  });

  it("defaults to memory in non-production", () => {
    delete process.env.REALTIME_BUS;
    const a = getBus();
    expect(a.publish).toBeTypeOf("function");
    expect(a.subscribe).toBeTypeOf("function");
  });

  it("respects explicit REALTIME_BUS=memory", () => {
    process.env.REALTIME_BUS = "memory";
    const a = getBus();
    expect(a.publish).toBeTypeOf("function");
  });

  it("throws on unknown REALTIME_BUS value", () => {
    process.env.REALTIME_BUS = "invalid";
    expect(() => getBus()).toThrow(/Unknown REALTIME_BUS=invalid/);
  });
});
