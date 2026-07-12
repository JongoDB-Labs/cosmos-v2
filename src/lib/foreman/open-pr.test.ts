import { describe, it, expect } from "vitest";
import { isPrAlreadyExistsError, resolveExistingPr } from "./open-pr";

describe("isPrAlreadyExistsError", () => {
  // The verbatim shape `gh pr create` exits non-zero with when the head branch
  // already carries an OPEN PR — the failure this whole fallback exists to recover.
  const ghAlreadyExists =
    'a pull request for branch "auto/COSMOS-103" into branch "main" already exists:\nhttps://github.com/org/repo/pull/42';

  it("detects gh's already-exists message on the rejected error's stderr", () => {
    expect(isPrAlreadyExistsError({ stderr: ghAlreadyExists })).toBe(true);
  });

  it("detects it on the error's message when stderr is empty", () => {
    expect(
      isPrAlreadyExistsError(new Error(`Command failed: gh pr create\n${ghAlreadyExists}`)),
    ).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isPrAlreadyExistsError({ stderr: "ALREADY EXISTS" })).toBe(true);
  });

  it("does NOT match an unrelated create failure (that must still re-throw)", () => {
    expect(
      isPrAlreadyExistsError({ stderr: "pull request create failed: Head sha can't be blank" }),
    ).toBe(false);
    expect(isPrAlreadyExistsError(new Error("gh: authentication required"))).toBe(false);
  });

  it("tolerates a non-error value without throwing", () => {
    expect(isPrAlreadyExistsError(null)).toBe(false);
    expect(isPrAlreadyExistsError(undefined)).toBe(false);
    // a bare string carries neither .stderr nor .message, so it never matches
    expect(isPrAlreadyExistsError("already exists")).toBe(false);
  });
});

describe("resolveExistingPr", () => {
  const url = "https://github.com/org/repo/pull/42";

  it("reuses an OPEN PR (the force-push already updated its head)", () => {
    expect(resolveExistingPr(JSON.stringify({ url, state: "OPEN" }))).toEqual({ kind: "reuse", url });
  });

  it("reuses a MERGED PR rather than attempting a reopen", () => {
    expect(resolveExistingPr(JSON.stringify({ url, state: "MERGED" }))).toEqual({ kind: "reuse", url });
  });

  it("reopens a CLOSED-without-merge PR (same branch + URL, not a suffixed branch)", () => {
    expect(resolveExistingPr(JSON.stringify({ url, state: "CLOSED" }))).toEqual({ kind: "reopen", url });
  });

  it("matches state case-insensitively", () => {
    expect(resolveExistingPr(JSON.stringify({ url, state: "closed" }))).toEqual({ kind: "reopen", url });
  });

  it("trims a surrounding-whitespace url", () => {
    expect(resolveExistingPr(JSON.stringify({ url: `  ${url}  `, state: "OPEN" }))).toEqual({
      kind: "reuse",
      url,
    });
  });

  it("reuses (never reopens) on an unknown/absent state that still carries a url", () => {
    expect(resolveExistingPr(JSON.stringify({ url, state: "DRAFT" }))).toEqual({ kind: "reuse", url });
    expect(resolveExistingPr(JSON.stringify({ url }))).toEqual({ kind: "reuse", url });
  });

  it("returns none for a blank or missing url", () => {
    expect(resolveExistingPr(JSON.stringify({ url: "", state: "OPEN" }))).toEqual({ kind: "none" });
    expect(resolveExistingPr(JSON.stringify({ url: "   ", state: "OPEN" }))).toEqual({ kind: "none" });
    expect(resolveExistingPr(JSON.stringify({ state: "OPEN" }))).toEqual({ kind: "none" });
  });

  it("returns none for malformed JSON (gh printed nothing / an error line)", () => {
    expect(resolveExistingPr("")).toEqual({ kind: "none" });
    expect(resolveExistingPr("no pull requests found for branch auto/COSMOS-103")).toEqual({
      kind: "none",
    });
    expect(resolveExistingPr("{ broken")).toEqual({ kind: "none" });
  });

  it("returns none for a non-object JSON payload (null / array / scalar)", () => {
    expect(resolveExistingPr("null")).toEqual({ kind: "none" });
    expect(resolveExistingPr("[]")).toEqual({ kind: "none" });
    expect(resolveExistingPr("42")).toEqual({ kind: "none" });
  });

  it("treats a non-string url as absent", () => {
    expect(resolveExistingPr(JSON.stringify({ url: 42, state: "OPEN" }))).toEqual({ kind: "none" });
  });
});
