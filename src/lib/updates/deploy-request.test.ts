// @vitest-environment node
//
// Whether a deploy may be recorded at all.
//
// Every test here is a REFUSAL except one. That ratio is deliberate: this
// decides whether a button takes production down, and the interesting cases are
// all the ways it must say no. The happy path is a single line.
import { describe, it, expect } from "vitest";
import { decideDeploy, refusalStatus } from "./deploy-request";
import type { UpdateCheck } from "./check";

const pass = (id: string, title: string) => ({ id, title, status: "pass" as const, detail: "", blocking: true });

const READY: UpdateCheck = {
  configured: true,
  checkedAt: "2026-08-11T20:00:00.000Z",
  status: { current: "2.278.2", latest: "2.279.0", newer: ["2.279.0"], updateAvailable: true, ahead: false },
  candidateDigest: `sha256:${"a".repeat(64)}`,
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

describe("refusalStatus — distinct codes so the UI can react precisely", () => {
  it("separates 'no longer true' from 'refused on the merits' from 'upstream down'", () => {
    expect(refusalStatus("version-mismatch")).toBe(409);
    expect(refusalStatus("preflight-blocked")).toBe(422);
    expect(refusalStatus("no-update")).toBe(422);
    expect(refusalStatus("check-failed")).toBe(503);
    expect(refusalStatus("not-configured")).toBe(501);
  });
});
