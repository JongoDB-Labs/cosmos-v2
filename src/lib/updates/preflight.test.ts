// @vitest-environment node
//
// Preflights, and one rule above all others: `unknown` is not `pass`.
//
// A gate that scores "I could not check" as "fine" is decoration. This codebase
// has already paid for that twice — a deploy gate that pointed at a registry
// nobody deployed from and reported health for months, and a plugin version
// badge that nothing compared and so sat wrong through nineteen releases. Most
// of the tests below exist to pin the refusals, not the happy path.
import { describe, it, expect } from "vitest";
import { evaluatePreflights, canApply, blockers, type PreflightFacts } from "./preflight";

const GOOD: PreflightFacts = {
  currentVersion: "2.275.0",
  candidateVersion: "2.276.8",
  ahead: false,
  candidateDigest: `sha256:${"a".repeat(64)}`,
  migrateImagePresent: true,
  missingSidecars: [],
  sidecarCount: 0,
  candidateRegistryHost: "registry.example.com",
  expectedRegistryHost: "registry.example.com",
  dbReachable: true,
  currentHealthOk: true,
  hostDiskFreeBytes: 20_000_000_000,
  estimatedRequiredBytes: 4_000_000_000,
};

const find = (f: PreflightFacts, id: string) => {
  const r = evaluatePreflights(f).find((x) => x.id === id);
  if (!r) throw new Error(`no preflight with id ${id}`);
  return r;
};

describe("the happy path is applyable", () => {
  it("passes every blocking check when all facts are good", () => {
    const results = evaluatePreflights(GOOD);
    expect(canApply(results)).toBe(true);
    expect(blockers(results)).toEqual([]);
  });
});

describe("unknown is not pass — the central rule", () => {
  it.each([
    ["migrateImagePresent", { migrateImagePresent: null }],
    ["dbReachable", { dbReachable: null }],
    ["hostDiskFreeBytes", { hostDiskFreeBytes: null }],
    ["expectedRegistryHost", { expectedRegistryHost: null }],
  ])("an unobservable %s blocks the upgrade rather than being waved through", (_name, over) => {
    const results = evaluatePreflights({ ...GOOD, ...(over as Partial<PreflightFacts>) });
    expect(canApply(results)).toBe(false);
    expect(blockers(results).length).toBeGreaterThan(0);
  });

  it("reports unknown rather than fail, so the UI can say 'could not check' honestly", () => {
    expect(find({ ...GOOD, dbReachable: null }, "db-reachable").status).toBe("unknown");
    expect(find({ ...GOOD, dbReachable: false }, "db-reachable").status).toBe("fail");
  });
});

describe("the in-app check cannot see the host, and says so", () => {
  it("marks disk unknown — not pass — when running where the host disk is invisible", () => {
    // The app container has no host mount. Scoring this as pass would be a lie
    // that survives all the way to a full disk during an upgrade.
    const r = find({ ...GOOD, hostDiskFreeBytes: null, estimatedRequiredBytes: null }, "disk-headroom");
    expect(r.status).toBe("unknown");
    expect(r.detail).toMatch(/host-side actuator/i);
  });

  it("fails when the disk genuinely will not fit, naming the rollback consequence", () => {
    const r = find({ ...GOOD, hostDiskFreeBytes: 1_000, estimatedRequiredBytes: 4_000_000_000 }, "disk-headroom");
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/rollback/i);
  });
});

describe("plugin sidecars — the images that ship WITH a release", () => {
  it("emits NO row when the deployment declares no sidecars", () => {
    // Not a silent skip: an instance with no sidecars has nothing to pair, and
    // a permanently-unknown blocking row would stop every such deployment.
    expect(evaluatePreflights(GOOD).find((r) => r.id === "sidecars-paired")).toBeUndefined();
    expect(canApply(evaluatePreflights(GOOD))).toBe(true);
  });

  it("passes when every declared sidecar exists at the release tag", () => {
    const f = { ...GOOD, sidecarCount: 2, missingSidecars: [] };
    expect(find(f, "sidecars-paired").status).toBe("pass");
    expect(canApply(evaluatePreflights(f))).toBe(true);
  });

  it("BLOCKS when a sidecar is missing, and says what breaks", () => {
    // Upgrading the app without its sidecar leaves the plugin's live service on
    // the old build: collaboration stops while everything else looks healthy.
    const f = { ...GOOD, sidecarCount: 2, missingSidecars: ["registry.example.com/o/whiteboard-sidecar"] };
    const r = find(f, "sidecars-paired");
    expect(r.status).toBe("fail");
    expect(r.blocking).toBe(true);
    expect(r.detail).toContain("whiteboard-sidecar");
    expect(canApply(evaluatePreflights(f))).toBe(false);
  });
});

describe("refusals that protect data", () => {
  it("REFUSES a downgrade, and explains it in terms of the schema", () => {
    const r = find({ ...GOOD, ahead: true }, "not-a-downgrade");
    expect(r.status).toBe("fail");
    expect(r.blocking).toBe(true);
    expect(r.detail).toMatch(/DOWNGRADE/);
    expect(canApply(evaluatePreflights({ ...GOOD, ahead: true }))).toBe(false);
  });

  it("REFUSES when the migration image is missing at the same tag", () => {
    // Deploying the app without its migrate image runs new code against an old
    // schema — the failure the paired-tag gate in ship.mts exists to prevent.
    const r = find({ ...GOOD, migrateImagePresent: false }, "migrate-image-paired");
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/unmigrated schema/i);
  });

  it("REFUSES an image from a registry this deployment is not configured for", () => {
    const r = find({ ...GOOD, candidateRegistryHost: "evil.example.com" }, "expected-registry");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("evil.example.com");
    expect(r.detail).toContain("registry.example.com");
  });

  it("REFUSES when the candidate tag resolved to no digest", () => {
    expect(find({ ...GOOD, candidateDigest: null }, "candidate-resolves").status).toBe("fail");
  });
});

describe("an unhealthy baseline warns without blocking", () => {
  it("warns, because the upgrade result becomes unreadable — but does not stop the operator", () => {
    const r = find({ ...GOOD, currentHealthOk: false }, "healthy-baseline");
    expect(r.status).toBe("warn");
    expect(r.blocking).toBe(false);
    // A warn must still leave the upgrade applyable: sometimes upgrading IS the fix.
    expect(canApply(evaluatePreflights({ ...GOOD, currentHealthOk: false }))).toBe(true);
  });
});

describe("no preflight detail leaks a credential", () => {
  it("details are operator-facing prose, never echoed configuration values", () => {
    for (const r of evaluatePreflights(GOOD)) {
      expect(r.detail).not.toMatch(/password|secret|token|Bearer|Basic /i);
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });
});
