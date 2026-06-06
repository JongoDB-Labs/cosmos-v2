import { describe, expect, it } from "vitest";
import type { TargetAndTransition } from "framer-motion";
import { motion, fadeIn, slideUp, stagger, staggerChildren } from "./motion";

describe("motion tokens", () => {
  it("snap duration is 150ms", () => {
    expect(motion.snap.duration).toBe(0.15);
  });

  it("smooth duration is 240ms", () => {
    expect(motion.smooth.duration).toBe(0.24);
  });

  it("linger duration is 420ms", () => {
    expect(motion.linger.duration).toBe(0.42);
  });

  it("spring uses stiffness 260 / damping 28", () => {
    expect(motion.spring.stiffness).toBe(260);
    expect(motion.spring.damping).toBe(28);
  });
});

describe("variants", () => {
  it("fadeIn hides at opacity 0, shows at opacity 1", () => {
    expect((fadeIn.hidden as TargetAndTransition).opacity).toBe(0);
    expect((fadeIn.visible as TargetAndTransition).opacity).toBe(1);
  });

  it("slideUp offsets 8px on hidden", () => {
    expect((slideUp.hidden as TargetAndTransition).y).toBe(8);
    expect((slideUp.visible as TargetAndTransition).y).toBe(0);
  });
});

describe("staggerChildren", () => {
  it("cap is exposed as maxStaggered = 6", () => {
    expect(stagger.maxStaggered).toBe(6);
  });

  it("returns delay = index * 40ms for small indices", () => {
    expect(staggerChildren(0).delay).toBe(0);
    expect(staggerChildren(1).delay).toBeCloseTo(0.04);
    expect(staggerChildren(3).delay).toBeCloseTo(0.12);
  });

  it("caps delay at 6 * 40ms for any index >= 6", () => {
    expect(staggerChildren(6).delay).toBeCloseTo(0.24);
    expect(staggerChildren(10).delay).toBeCloseTo(0.24);
    expect(staggerChildren(100).delay).toBeCloseTo(0.24);
  });

  it("never returns negative delay", () => {
    expect(staggerChildren(-1).delay).toBeGreaterThanOrEqual(0);
    expect(staggerChildren(-100).delay).toBeGreaterThanOrEqual(0);
  });
});
