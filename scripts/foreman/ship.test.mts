// Unit tests for the deploy GATE in ship.mts: the app image must deploy on the
// strength of the signed IMAGE existing in GHCR, NOT the whole release run's
// conclusion. Regression cover for COSMOS-122 — a failed non-essential
// downstream job (the Helm chart-publish) turned the run "failure" and made
// foreman retry the deploy forever even though the app image built + got signed.
import { describe, it, expect, vi } from "vitest";
import {
  selectReleaseRun,
  imageGate,
  waitForImage,
  type ReleaseRun,
  type WaitForImageDeps,
} from "./ship.mjs";

const run = (over: Partial<ReleaseRun> = {}): ReleaseRun => ({
  headBranch: "v2.204.4",
  status: "completed",
  conclusion: "success",
  displayTitle: "fix(release): decouple chart job (v2.204.4)",
  ...over,
});

describe("selectReleaseRun", () => {
  it("prefers the exact tag ref over displayTitle", () => {
    const runs = [
      run({ headBranch: "v2.204.4", conclusion: "failure", displayTitle: "wrong" }),
      run({ headBranch: "main", displayTitle: "contains 2.204.4 substring" }),
    ];
    expect(selectReleaseRun(runs, "2.204.4")?.conclusion).toBe("failure");
  });

  it("falls back to displayTitle substring when GitHub truncates the tag away", () => {
    // Long subject: display_title is truncated so headBranch is the only exact
    // handle — but if headBranch didn't come back, the substring still matches.
    const runs = [run({ headBranch: "main", displayTitle: "feat: big change (v2.204.4)" })];
    expect(selectReleaseRun(runs, "2.204.4")).toBeDefined();
  });

  it("returns undefined when no recent run is this version", () => {
    expect(selectReleaseRun([run({ headBranch: "v9.9.9", displayTitle: "other" })], "2.204.4")).toBeUndefined();
  });
});

describe("imageGate — the gate keys on the IMAGE, not the run conclusion", () => {
  it("ready: signed image present even though the run FAILED (chart job broke)", () => {
    expect(imageGate(run({ conclusion: "failure" }), true)).toBe("ready");
  });

  it("ready: green run needs no registry hit (merge's verify-after-sign guarantees it)", () => {
    expect(imageGate(run({ conclusion: "success" }), false)).toBe("ready");
  });

  it("not-ready: run finished with no signed image → genuine build/sign failure", () => {
    expect(imageGate(run({ conclusion: "failure" }), false)).toBe("not-ready");
  });

  it("pending: run still in progress and no image yet", () => {
    expect(imageGate(run({ status: "in_progress", conclusion: null }), false)).toBe("pending");
  });

  it("pending: no matching run found yet", () => {
    expect(imageGate(undefined, false)).toBe("pending");
  });

  it("ready: signed image present even while the run is still in progress", () => {
    expect(imageGate(run({ status: "in_progress", conclusion: null }), true)).toBe("ready");
  });
});

describe("waitForImage — integration over injected I/O", () => {
  const baseDeps = (): WaitForImageDeps => ({
    listReleaseRuns: vi.fn(async () => [run()]),
    imageSignedInGhcr: vi.fn(async () => false),
    sleep: vi.fn(async () => undefined),
    now: () => 0, // fixed clock: one loop iteration inside the deadline
  });

  it("deploys a green run WITHOUT touching the registry", async () => {
    const deps = baseDeps();
    deps.listReleaseRuns = vi.fn(async () => [run({ conclusion: "success" })]);
    await expect(waitForImage("2.204.4", 60_000, deps)).resolves.toBe(true);
    expect(deps.imageSignedInGhcr).not.toHaveBeenCalled();
  });

  it("deploys when the run FAILED but the signed image is present (COSMOS-122)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = baseDeps();
    deps.listReleaseRuns = vi.fn(async () => [run({ conclusion: "failure" })]);
    deps.imageSignedInGhcr = vi.fn(async () => true);
    await expect(waitForImage("2.204.4", 60_000, deps)).resolves.toBe(true);
    expect(deps.imageSignedInGhcr).toHaveBeenCalledWith("2.204.4");
    // Surfaced but non-blocking.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("does not gate the app deploy"));
    warn.mockRestore();
  });

  it("does NOT deploy when the run failed and no signed image exists", async () => {
    const deps = baseDeps();
    deps.listReleaseRuns = vi.fn(async () => [run({ conclusion: "failure" })]);
    deps.imageSignedInGhcr = vi.fn(async () => false);
    await expect(waitForImage("2.204.4", 60_000, deps)).resolves.toBe(false);
  });

  it("times out (false) if the run never leaves 'in_progress'", async () => {
    let clock = 0;
    const deps = baseDeps();
    deps.listReleaseRuns = vi.fn(async () => [run({ status: "in_progress", conclusion: null })]);
    deps.now = () => clock;
    deps.sleep = vi.fn(async () => {
      clock += 30_000; // advance past the deadline after one pending loop
    });
    await expect(waitForImage("2.204.4", 20_000, deps)).resolves.toBe(false);
    expect(deps.imageSignedInGhcr).not.toHaveBeenCalled();
  });
});
