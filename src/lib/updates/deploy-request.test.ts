// @vitest-environment node
//
// Whether a deploy may be recorded at all.
//
// Every test here is a REFUSAL except one. That ratio is deliberate: this
// decides whether a button takes production down, and the interesting cases are
// all the ways it must say no. The happy path is a single line.
import { describe, it, expect } from "vitest";
import { decideDeploy, refusalStatus } from "./deploy-request";
import { evaluatePreflights, canApply, type PreflightFacts } from "./preflight";
import type { UpdateCheck } from "./check";

const pass = (id: string, title: string) => ({ id, title, status: "pass" as const, detail: "", blocking: true });

const READY: UpdateCheck = {
  configured: true,
  checkedAt: "2026-08-11T20:00:00.000Z",
  status: { current: "2.278.2", latest: "2.279.0", newer: ["2.279.0"], updateAvailable: true, ahead: false },
  candidateDigest: `sha256:${"a".repeat(64)}`,
  rebuildAvailable: null,
  candidateTag: "2.279.0-alpha",
  preflights: [pass("candidate-resolves", "Candidate image exists"), pass("sidecars-paired", "Plugin sidecar images")],
  notes: [],
  notesOmitted: 0,
  applyable: true,
  error: null,
};

describe("decideDeploy — the happy path", () => {
  it("permits the version the FRESH check just found", () => {
    expect(decideDeploy("2.279.0", READY)).toEqual({ ok: true, version: "2.279.0" });
  });
});

describe("decideDeploy — refusals", () => {
  it("REFUSES a version other than what the fresh check found", () => {
    // The whole reason the caller must name a version: a tab left open
    // overnight must not silently deploy something the operator never read.
    const d = decideDeploy("2.278.9", READY);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toBe("version-mismatch");
      expect(d.detail).toContain("2.279.0");
    }
  });

  it("REFUSES when the registry could not be read — unknown is not go-ahead", () => {
    const d = decideDeploy("2.279.0", { ...READY, error: "HTTP 401", status: null });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("check-failed");
  });

  it("REFUSES when there is nothing newer", () => {
    const d = decideDeploy("2.278.2", {
      ...READY,
      status: { current: "2.278.2", latest: "2.278.2", newer: [], updateAvailable: false, ahead: false },
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("no-update");
  });

  it("REFUSES when the instance is AHEAD of the registry — never a downgrade", () => {
    const d = decideDeploy("2.277.0", {
      ...READY,
      status: { current: "2.279.0", latest: "2.277.0", newer: [], updateAvailable: false, ahead: true },
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("no-update");
  });

  it("REFUSES on a failed blocking preflight, and names it", () => {
    const d = decideDeploy("2.279.0", {
      ...READY,
      applyable: false,
      preflights: [
        pass("candidate-resolves", "Candidate image exists"),
        { id: "sidecars-paired", title: "Plugin sidecar images", status: "fail", detail: "missing", blocking: true },
      ],
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toBe("preflight-blocked");
      expect(d.detail).toContain("Plugin sidecar images");
    }
  });

  it("REFUSES on an UNANSWERED blocking preflight, not just a failed one", () => {
    // unknown is not pass. A check that could not run must not be waved through
    // at the moment it would actually matter.
    const d = decideDeploy("2.279.0", {
      ...READY,
      applyable: false,
      preflights: [{ id: "disk-headroom", title: "Disk headroom", status: "unknown", detail: "", blocking: true }],
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("preflight-blocked");
  });

  it("PERMITS a blocking check that is DEFERRED to the host runner, though it is unanswered", () => {
    // The regression this exists to prevent, found by clicking the button on
    // production. `disk-headroom` is unanswerable from inside the container —
    // no host mount — so the check reports `unknown` and defers it to the
    // runner, which re-evaluates it with real facts immediately before acting.
    //
    // Deferred is NOT a softer `unknown`: the case above must still refuse.
    // What separates them is `deferredTo`, and this decision has to read it the
    // same way `blockers()` does. When it did not, the page showed an enabled
    // Install button and every POST behind it returned 422 — on every host,
    // permanently, because that check can never be answered here.
    const d = decideDeploy("2.279.0", {
      ...READY,
      preflights: [
        pass("candidate-resolves", "Candidate image exists"),
        {
          id: "disk-headroom",
          title: "Disk headroom for the image and backup",
          status: "unknown",
          detail: "Checked on the host immediately before the deploy runs.",
          blocking: true,
          deferredTo: "host-runner",
        },
      ],
    });
    expect(d).toEqual({ ok: true, version: "2.279.0" });
  });

  it("ignores a non-blocking warning — a warn must not stop an operator", () => {
    const d = decideDeploy("2.279.0", {
      ...READY,
      preflights: [
        pass("candidate-resolves", "Candidate image exists"),
        { id: "healthy-baseline", title: "Healthy baseline", status: "warn", detail: "", blocking: false },
      ],
    });
    expect(d.ok).toBe(true);
  });

  it("REFUSES when update checking is not configured at all", () => {
    const d = decideDeploy("2.279.0", { ...READY, configured: false, status: null });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("not-configured");
  });
});

describe("the page and the decision must agree — composed, not hand-built", () => {
  // WHY THIS EXISTS. The escaped bug was not that either module was wrong on
  // its own. `evaluatePreflights` + `canApply` were right, `decideDeploy` was
  // wrong, and BOTH were tested — against preflight arrays written by hand in
  // each test file. Hand-built fixtures agree with whatever the author was
  // thinking that day, so no test ever asked the one question that mattered:
  // does the decision accept what the page actually produces?
  //
  // These run the REAL producer and feed its output straight into the decision.
  // Nothing here is typed out by hand, so the two cannot drift apart again
  // without a named failure.
  const IN_CONTAINER: PreflightFacts = {
    currentVersion: "2.278.2",
    candidateVersion: "2.279.0",
    ahead: false,
    candidateDigest: `sha256:${"a".repeat(64)}`,
    migrateImagePresent: true,
    missingSidecars: [],
    sidecarCount: 2,
    candidateRegistryHost: "registry.example.com",
    expectedRegistryHost: "registry.example.com",
    dbReachable: true,
    currentHealthOk: true,
    // The whole point: an app container has no host mount and cannot see disk.
    // This is not a contrived fixture — it is the ONLY shape production ever has.
    hostDiskFreeBytes: null,
    estimatedRequiredBytes: null,
  };

  const checkFrom = (facts: PreflightFacts): UpdateCheck => {
    const preflights = evaluatePreflights(facts);
    return {
      ...READY,
      preflights,
      applyable: preflights.length > 0 && canApply(preflights), // exactly as check.ts builds it
    };
  };

  it("accepts the deploy on the facts a real container reports", () => {
    const check = checkFrom(IN_CONTAINER);

    // Guard the premise: if this stops being deferred, the test below stops
    // testing anything and would pass vacuously.
    const disk = check.preflights.find((p) => p.id === "disk-headroom");
    expect(disk).toMatchObject({ status: "unknown", blocking: true, deferredTo: "host-runner" });

    expect(check.applyable).toBe(true);
    expect(decideDeploy("2.279.0", check)).toEqual({ ok: true, version: "2.279.0" });
  });

  it("still refuses on facts that genuinely fail, so the gate is not merely permissive", () => {
    // The mirror image. If the test above passed because the decision stopped
    // refusing anything at all, this one fails.
    const check = checkFrom({ ...IN_CONTAINER, dbReachable: false });
    expect(check.applyable).toBe(false);
    const d = decideDeploy("2.279.0", check);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("preflight-blocked");
  });

  it("never accepts what the page would have refused, across every one-fact failure", () => {
    // The invariant, stated once: `applyable` is what enables the button, so
    // acceptance by the decision must never be broader than it.
    const variations: PreflightFacts[] = [
      IN_CONTAINER,
      { ...IN_CONTAINER, dbReachable: false },
      { ...IN_CONTAINER, dbReachable: null },
      { ...IN_CONTAINER, migrateImagePresent: false },
      { ...IN_CONTAINER, missingSidecars: ["whiteboard-sidecar"] },
      { ...IN_CONTAINER, ahead: true },
      { ...IN_CONTAINER, expectedRegistryHost: "other.example.com" },
      { ...IN_CONTAINER, currentHealthOk: false },
      { ...IN_CONTAINER, currentHealthOk: null },
      { ...IN_CONTAINER, hostDiskFreeBytes: 1_000, estimatedRequiredBytes: 4_000_000_000 },
    ];

    for (const facts of variations) {
      const check = checkFrom(facts);
      expect({ applyable: check.applyable, accepted: decideDeploy("2.279.0", check).ok }).toEqual({
        applyable: check.applyable,
        accepted: check.applyable,
      });
    }
  });
});

describe("refusalStatus — distinct codes so the UI can react precisely", () => {
  it("separates 'no longer true' from 'refused on the merits' from 'upstream down'", () => {
    expect(refusalStatus("version-mismatch")).toBe(409);
    expect(refusalStatus("preflight-blocked")).toBe(422);
    expect(refusalStatus("no-update")).toBe(422);
    expect(refusalStatus("check-failed")).toBe(503);
    expect(refusalStatus("not-configured")).toBe(501);
  });
});
