import { describe, it, expect } from "vitest";
import { touchesForemanRuntime, shouldArmSelfRestart, readyToRestart } from "./self-restart";

const COMMIT = "abc1234";

describe("touchesForemanRuntime (diff trigger)", () => {
  it("triggers on a scripts/foreman change", () => {
    expect(touchesForemanRuntime(["scripts/foreman/run.mts"])).toBe(true);
  });
  it("triggers on a src/lib/foreman change", () => {
    expect(touchesForemanRuntime(["src/lib/foreman/approve-decision.ts"])).toBe(true);
  });
  it("triggers when a foreman file rides alongside unrelated files", () => {
    expect(touchesForemanRuntime(["src/components/x.tsx", "scripts/foreman/ship.mts"])).toBe(true);
  });
  it("does not trigger on a change that leaves Foreman's runtime untouched", () => {
    expect(touchesForemanRuntime(["src/components/x.tsx", "src/lib/changelog.ts"])).toBe(false);
  });
  it("does not trigger on a substring near-miss (e.g. a foreman page/route)", () => {
    expect(touchesForemanRuntime(["src/app/(dashboard)/foreman/page.tsx"])).toBe(false);
  });
});

describe("shouldArmSelfRestart (diff trigger + loop guard)", () => {
  it("arms on a fresh foreman-touching ship", () => {
    expect(
      shouldArmSelfRestart({ files: ["scripts/foreman/run.mts"], shippedCommit: COMMIT, lastRestartCommit: null }),
    ).toBe(true);
  });
  it("does not arm when the diff leaves Foreman's runtime untouched", () => {
    expect(
      shouldArmSelfRestart({ files: ["src/components/x.tsx"], shippedCommit: COMMIT, lastRestartCommit: null }),
    ).toBe(false);
  });
  it("loop guard: does not re-arm for a commit already restarted for", () => {
    expect(
      shouldArmSelfRestart({ files: ["scripts/foreman/run.mts"], shippedCommit: COMMIT, lastRestartCommit: COMMIT }),
    ).toBe(false);
  });
  it("arms again once a DIFFERENT foreman-touching commit ships", () => {
    expect(
      shouldArmSelfRestart({ files: ["src/lib/foreman/risk.ts"], shippedCommit: "def5678", lastRestartCommit: COMMIT }),
    ).toBe(true);
  });
  it("never arms without a commit identity (git hiccup) — the loop guard would be blind", () => {
    expect(
      shouldArmSelfRestart({ files: ["scripts/foreman/run.mts"], shippedCommit: "", lastRestartCommit: null }),
    ).toBe(false);
  });
});

describe("readyToRestart (defer until idle)", () => {
  it("restarts once armed and the daemon is fully idle", () => {
    expect(readyToRestart({ armed: true, inFlightBuilds: 0, inFlightRegistry: 0 })).toBe(true);
  });
  it("defers while a build still holds a worker slot", () => {
    expect(readyToRestart({ armed: true, inFlightBuilds: 1, inFlightRegistry: 1 })).toBe(false);
  });
  it("defers while a ship is still queued/running (registry non-empty, no build slot)", () => {
    expect(readyToRestart({ armed: true, inFlightBuilds: 0, inFlightRegistry: 1 })).toBe(false);
  });
  it("never restarts when not armed, even when idle", () => {
    expect(readyToRestart({ armed: false, inFlightBuilds: 0, inFlightRegistry: 0 })).toBe(false);
  });
});
