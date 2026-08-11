// @vitest-environment node
//
// The orchestration, with every I/O injected.
//
// The load-bearing test in this file is "a registry we cannot read is an
// UNKNOWN, not up-to-date". Reporting no-update-available when the check itself
// failed is precisely the failure this feature was written in response to: a
// deploy gate that could not see its registry and answered "not built yet"
// forever, in a branch classified as healthy, so nothing ever escalated.
import { describe, it, expect, vi } from "vitest";
import { checkForUpdates, updateConfigFromEnv, candidateTags, type CheckDeps, type UpdateConfig } from "./check";

const CONFIG: UpdateConfig = {
  repo: "registry.example.com/cosmos/assembly/alpha",
  migrateRepo: "registry.example.com/cosmos/assembly/alpha-migrate",
  suffix: "alpha",
  notesRepo: "registry.example.com/cosmos/assembly/alpha",
};

const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = new Date("2026-08-11T12:00:00.000Z");

const deps = (over: Partial<CheckDeps> = {}): CheckDeps => ({
  listTags: vi.fn(async () => ["2.275.0-alpha", "2.276.8-alpha", "latest"]),
  resolveDigest: vi.fn(async () => DIGEST),
  fetchReleaseNotes: vi.fn(async () => ({ notes: [], omitted: 0 })),
  probeDb: vi.fn(async () => true),
  probeHealth: vi.fn(async () => true),
  now: () => NOW,
  ...over,
}) as CheckDeps;

describe("updateConfigFromEnv", () => {
  it("is null when unconfigured, which disables the feature rather than guessing", () => {
    expect(updateConfigFromEnv({})).toBeNull();
  });

  it("derives the migrate repo and the suffix from the app repo", () => {
    const c = updateConfigFromEnv({
      COSMOS_UPDATE_IMAGE_REPO: "registry.example.com/cosmos/assembly/alpha",
    });
    expect(c?.migrateRepo).toBe("registry.example.com/cosmos/assembly/alpha-migrate");
    expect(c?.suffix).toBe("alpha");
  });

  it("derives an EMPTY suffix for the neutral core, which tags bare versions", () => {
    const c = updateConfigFromEnv({
      COSMOS_UPDATE_IMAGE_REPO: "ghcr.io/acme/cosmos-v2",
    });
    expect(c?.suffix).toBe("");
  });

  it("handles the legacy ghcr composed spelling too", () => {
    const c = updateConfigFromEnv({
      COSMOS_UPDATE_IMAGE_REPO: "ghcr.io/acme/cosmos-v2-alpha",
    });
    expect(c?.suffix).toBe("alpha");
  });
});

describe("candidateTags mirrors the deploy script", () => {
  it("tries the suffixed tag first, then the bare version", () => {
    expect(candidateTags("2.276.8", "alpha")).toEqual(["2.276.8-alpha", "2.276.8"]);
    expect(candidateTags("2.276.8", "")).toEqual(["2.276.8"]);
  });
});

describe("checkForUpdates", () => {
  it("reports not-configured without touching the network", async () => {
    const d = deps();
    const out = await checkForUpdates("2.275.0", null, d);
    expect(out.configured).toBe(false);
    expect(out.error).toBeNull();
    expect(d.listTags).not.toHaveBeenCalled();
  });

  it("finds a newer release and resolves it at the suffixed tag", async () => {
    const out = await checkForUpdates("2.275.0", CONFIG, deps());
    expect(out.status?.updateAvailable).toBe(true);
    expect(out.status?.latest).toBe("2.276.8");
    expect(out.candidateTag).toBe("2.276.8-alpha");
    expect(out.candidateDigest).toBe(DIGEST);
  });

  it("a registry it cannot read is an ERROR, never 'up to date'", async () => {
    const out = await checkForUpdates(
      "2.275.0",
      CONFIG,
      deps({ listTags: vi.fn(async () => { throw new Error("HTTP 403"); }) as unknown as CheckDeps["listTags"] }),
    );
    expect(out.error).toMatch(/403/);
    expect(out.status).toBeNull();
    expect(out.applyable).toBe(false);
    // The distinction that matters: this is NOT the same shape as "no update".
    expect(out.status?.updateAvailable).not.toBe(false);
  });

  it("never leaks credentials into the surfaced error", async () => {
    const out = await checkForUpdates(
      "2.275.0",
      { ...CONFIG, username: "u", password: "hunter2" },
      deps({ listTags: vi.fn(async () => { throw new Error("HTTP 401"); }) as unknown as CheckDeps["listTags"] }),
    );
    expect(out.error).not.toMatch(/hunter2/);
  });

  it("REFUSES to pair an app image with a missing migration image", async () => {
    const resolveDigest = vi.fn(async (repo: string) =>
      repo.includes("-migrate") ? null : DIGEST,
    ) as unknown as CheckDeps["resolveDigest"];
    const out = await checkForUpdates("2.275.0", CONFIG, deps({ resolveDigest }));
    const paired = out.preflights.find((p) => p.id === "migrate-image-paired");
    expect(paired?.status).toBe("fail");
    expect(out.applyable).toBe(false);
  });

  it("falls through to the bare tag when the suffixed one is absent", async () => {
    const resolveDigest = vi.fn(async (_repo: string, tag: string) =>
      tag === "2.276.8" ? DIGEST : null,
    ) as unknown as CheckDeps["resolveDigest"];
    const out = await checkForUpdates("2.275.0", CONFIG, deps({ resolveDigest }));
    expect(out.candidateTag).toBe("2.276.8");
  });

  it("runs no preflights and offers nothing when already current", async () => {
    const out = await checkForUpdates("2.276.8", CONFIG, deps());
    expect(out.status?.updateAvailable).toBe(false);
    expect(out.preflights).toEqual([]);
    expect(out.applyable).toBe(false);
  });

  it("is NOT applyable from inside the app, because disk is unobservable there", async () => {
    // This is the honest outcome, not a bug: the app container has no host
    // mount, the disk preflight is `unknown`, and unknown does not pass. It is
    // also the structural reason actuation belongs to the host-side runner.
    const out = await checkForUpdates("2.275.0", CONFIG, deps());
    expect(out.status?.updateAvailable).toBe(true);
    expect(out.applyable).toBe(false);
    expect(out.preflights.find((p) => p.id === "disk-headroom")?.status).toBe("unknown");
  });

  it("degrades to unknown — not fail — when a probe throws", async () => {
    const out = await checkForUpdates(
      "2.275.0",
      CONFIG,
      deps({ probeDb: vi.fn(async () => { throw new Error("boom"); }) }),
    );
    expect(out.preflights.find((p) => p.id === "db-reachable")?.status).toBe("unknown");
  });

  it("stamps the check time from the injected clock", async () => {
    const out = await checkForUpdates("2.275.0", CONFIG, deps());
    expect(out.checkedAt).toBe(NOW.toISOString());
  });
});
