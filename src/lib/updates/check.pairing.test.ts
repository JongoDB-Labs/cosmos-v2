// @vitest-environment node
//
// The two invariants the CLEANUP-22 deletions in check.ts stand on.
//
// Both deletions were justified by reasoning about the tag loop rather than by
// anything a test pinned, which is how a "dead" line turns out to have been
// load-bearing. These pin the reasoning:
//
//   1. `migrateImagePresent` is driven ENTIRELY by its initialiser plus the
//      paired-tag assignment. The removed `if (app && !migrate) ... = false`
//      could only ever re-assign the value the variable already held, because
//      the only write to `true` breaks out of the loop immediately. So the
//      not-paired answer must still be `false` (a refusal) and never `null`
//      (an unknown) — and a tag that half-matches must not poison a later tag
//      that pairs properly.
//
//   2. `candidateRegistryHost` and `expectedRegistryHost` both come from the
//      configured image repo. Collapsing the duplicated `parseImageRef` call
//      must not re-source either side from some other repo in the config —
//      `notesRepo` in particular is routinely on a different host, and wiring
//      it in here would turn the ordinary public-notes setup into a blocking
//      supply-chain refusal.
import { describe, it, expect, vi } from "vitest";
import { checkForUpdates, type CheckDeps, type UpdateConfig } from "./check";

const CONFIG: UpdateConfig = {
  repo: "registry.example.com/cosmos/assembly/alpha",
  migrateRepo: "registry.example.com/cosmos/assembly/alpha-migrate",
  suffix: "alpha",
  notesRepo: "registry.example.com/cosmos/assembly/alpha",
  sidecarRepos: [],
};

const DIGEST = `sha256:${"a".repeat(64)}`;

const deps = (over: Partial<CheckDeps> = {}): CheckDeps => ({
  listTags: vi.fn(async () => ["2.275.0-alpha", "2.276.8-alpha", "latest"]),
  resolveDigest: vi.fn(async () => DIGEST),
  fetchReleaseNotes: vi.fn(async () => ({ notes: [], omitted: 0 })),
  probeDb: vi.fn(async () => true),
  probeHealth: vi.fn(async () => true),
  now: () => new Date("2026-08-11T12:00:00.000Z"),
  ...over,
}) as CheckDeps;

const resolver = (fn: (repo: string, tag: string) => string | null) =>
  vi.fn(async (repo: string, tag: string) => fn(repo, tag)) as unknown as CheckDeps["resolveDigest"];

describe("the migrate-image pairing answer across the tag loop", () => {
  it("REFUSES with false, never unknown, when no tag pairs at all", async () => {
    // The not-paired case is a refusal the operator must see as a refusal.
    // `unknown` would read as "could not check" and is the wrong word: the
    // check ran, looked at every candidate tag, and found no migration image.
    const out = await checkForUpdates(
      "2.275.0",
      CONFIG,
      deps({ resolveDigest: resolver((repo) => (repo.includes("-migrate") ? null : DIGEST)) }),
    );
    const paired = out.preflights.find((p) => p.id === "migrate-image-paired");
    expect(paired?.status).toBe("fail");
    expect(paired?.detail).toMatch(/unmigrated schema/i);
    expect(out.applyable).toBe(false);
  });

  it("a half-matched suffixed tag does NOT poison the bare tag that pairs", async () => {
    // The app exists at both tags; the migration image only at the bare one.
    // The suffixed tag is tried first and half-matches. Falling through to a
    // tag where BOTH resolve is a genuine pairing and must be reported as one.
    const resolveDigest = resolver((repo, tag) => {
      if (repo.includes("-migrate")) return tag === "2.276.8" ? DIGEST : null;
      return DIGEST;
    });
    const out = await checkForUpdates("2.275.0", CONFIG, deps({ resolveDigest }));
    expect(out.candidateTag).toBe("2.276.8");
    expect(out.preflights.find((p) => p.id === "migrate-image-paired")?.status).toBe("pass");
    expect(out.applyable).toBe(true);
  });

  it("stops at the FIRST tag that pairs, without consulting the bare tag", async () => {
    // The suffixed tag pairs, so the loop breaks there. Nothing after it runs,
    // which is why a later re-assignment to false was unreachable.
    const resolveDigest = resolver((_repo, tag) => (tag === "2.276.8-alpha" ? DIGEST : null));
    const out = await checkForUpdates("2.275.0", CONFIG, deps({ resolveDigest }));
    expect(out.candidateTag).toBe("2.276.8-alpha");
    expect(out.preflights.find((p) => p.id === "migrate-image-paired")?.status).toBe("pass");
    const tagsTried = vi.mocked(resolveDigest).mock.calls.map((c) => c[1]);
    expect(tagsTried).not.toContain("2.276.8");
  });
});

describe("the expected-registry facts come from the configured IMAGE repo", () => {
  it("passes when the notes repo is on a completely different host", async () => {
    // The common supported setup: a private per-instance image registry plus
    // the public neutral-core repository for notes. The notes host is not a
    // candidate image source and must never be compared as though it were.
    const cfg = { ...CONFIG, notesRepo: "ghcr.io/acme/cosmos-v2" };
    const out = await checkForUpdates("2.275.0", cfg, deps());
    const registry = out.preflights.find((p) => p.id === "expected-registry");
    expect(registry?.status).toBe("pass");
    expect(registry?.detail).toContain("registry.example.com");
    expect(registry?.detail).not.toContain("ghcr.io");
    expect(out.applyable).toBe(true);
  });

  it("still routes notes credentials by the image repo's host", async () => {
    // Sharing one parsed host between the preflight facts and the notes-auth
    // decision must not change who the deploy token is handed to.
    const fetchReleaseNotes = vi.fn(async () => ({ notes: [], omitted: 0 })) as unknown as CheckDeps["fetchReleaseNotes"];
    const cfg = { ...CONFIG, notesRepo: "ghcr.io/acme/cosmos-v2", username: "u", password: "hunter2" };
    await checkForUpdates("2.275.0", cfg, deps({ fetchReleaseNotes }));
    expect(vi.mocked(fetchReleaseNotes).mock.calls[0][2]).toEqual({});
  });
});
