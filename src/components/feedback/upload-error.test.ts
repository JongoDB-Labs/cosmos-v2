import { describe, it, expect } from "vitest";
import { describeUploadError, networkUploadError } from "./upload-error";

const FILE = "Screenshot 2026-07-10 at 2:27:10 PM.png";

describe("describeUploadError", () => {
  it("reports a too-large file with the byte cap in MB", () => {
    const msg = describeUploadError({
      filename: FILE,
      status: 413,
      code: "too_large",
      maxBytes: 8 * 1024 * 1024,
    });
    expect(msg).toContain(FILE);
    expect(msg).toContain("8 MB");
    expect(msg.toLowerCase()).toContain("too large");
  });

  it("names the supported types on an unsupported mime", () => {
    const msg = describeUploadError({
      filename: FILE,
      status: 415,
      code: "unsupported_mime",
    });
    expect(msg).toContain(FILE);
    expect(msg).toContain("PNG");
    expect(msg).not.toContain("Couldn't upload");
  });

  it("explains rate limiting", () => {
    const msg = describeUploadError({ filename: FILE, status: 429, code: "rate_limited" });
    expect(msg.toLowerCase()).toContain("too quickly");
  });

  it("prompts re-auth on a 401 with no code", () => {
    const msg = describeUploadError({ filename: FILE, status: 401, code: null });
    expect(msg.toLowerCase()).toContain("session");
  });

  it("falls back on status when the body has an unknown code, keeping the code diagnosable", () => {
    const msg = describeUploadError({ filename: FILE, status: 500, code: "boom" });
    expect(msg).toContain(FILE);
    expect(msg).toContain("500");
  });

  it("maps a bare 413/415 status (non-JSON body) to a specific reason", () => {
    expect(describeUploadError({ filename: FILE, status: 413 }).toLowerCase()).toContain("too large");
    expect(describeUploadError({ filename: FILE, status: 415 })).toContain("supported file type");
  });

  it("keeps a fractional cap readable", () => {
    const msg = describeUploadError({
      filename: FILE,
      status: 413,
      code: "too_large",
      maxBytes: Math.round(7.5 * 1024 * 1024),
    });
    expect(msg).toContain("7.5 MB");
  });
});

describe("networkUploadError", () => {
  it("tells the user to check their connection", () => {
    const msg = networkUploadError(FILE);
    expect(msg).toContain(FILE);
    expect(msg.toLowerCase()).toContain("connection");
  });
});
