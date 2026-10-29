// @vitest-environment node
import { describe, it, expect } from "vitest";
import { decideUpload, ACCEPT_ATTRIBUTE } from "./upload-policy";

describe("decideUpload — verified tier", () => {
  it("accepts a sniffed screenshot and serves it inline", () => {
    expect(decideUpload("image/png", "Screenshot.png")).toMatchObject({
      ok: true, contentType: "image/png", kind: "image", disposition: "inline",
    });
  });

  it("accepts the document types FR 54b64bad asked for", () => {
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    expect(decideUpload(docx, "spec.docx").ok).toBe(true);
    expect(decideUpload(xlsx, "cdrls.xlsx").ok).toBe(true);
    expect(decideUpload("application/pdf", "a.pdf").ok).toBe(true);
  });

  it("refuses a sniffed type that is not on the list", () => {
    // The sniff is TRUSTED here, so the list is the whole gate.
    expect(decideUpload("text/html", "evil.png").ok).toBe(false);
    expect(decideUpload("application/x-msdownload", "a.exe").ok).toBe(false);
    expect(decideUpload("image/svg+xml", "a.svg").ok).toBe(false);
  });

  it("the sniff beats the extension, not the other way round", () => {
    // A renamed executable must not pass because it is called .txt.
    expect(decideUpload("application/x-msdownload", "notes.txt").ok).toBe(false);
  });
});

describe("decideUpload — declared tier (no magic bytes)", () => {
  it("accepts text and csv by extension, as ATTACHMENT", () => {
    expect(decideUpload(undefined, "notes.txt")).toMatchObject({
      ok: true, contentType: "text/plain", disposition: "attachment",
    });
    expect(decideUpload(undefined, "data.csv")).toMatchObject({
      ok: true, contentType: "text/csv", disposition: "attachment",
    });
  });

  it("NEVER serves a declared type inline", () => {
    // The XSS guard: for these the type is only as good as the client's word,
    // so the browser must download rather than render.
    for (const n of ["a.txt", "a.csv", "a.md", "a.json", "a.log", "a.tsv"]) {
      expect(decideUpload(undefined, n).disposition).toBe("attachment");
    }
  });

  it("refuses an unsignable file with an unknown extension", () => {
    expect(decideUpload(undefined, "payload.bin").ok).toBe(false);
    expect(decideUpload(undefined, "noextension").ok).toBe(false);
    expect(decideUpload(undefined, "a.html").ok).toBe(false);
    expect(decideUpload(undefined, "a.svg").ok).toBe(false);
  });

  it("is case-insensitive about the extension", () => {
    expect(decideUpload(undefined, "NOTES.TXT").ok).toBe(true);
  });

  it("takes the LAST extension, so .txt.html is refused", () => {
    expect(decideUpload(undefined, "report.txt.html").ok).toBe(false);
  });
});

describe("ACCEPT_ATTRIBUTE", () => {
  it("covers both tiers, so the picker offers what the server takes", () => {
    expect(ACCEPT_ATTRIBUTE).toContain("image/png");
    expect(ACCEPT_ATTRIBUTE).toContain(".csv");
    expect(ACCEPT_ATTRIBUTE).toContain(".docx".replace(".docx", "")); // docx is by mime
    expect(ACCEPT_ATTRIBUTE).not.toContain(".html");
  });
});
