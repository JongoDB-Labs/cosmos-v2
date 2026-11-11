// @vitest-environment node
import { describe, it, expect } from "vitest";
import { programManagementEmbedOrigin, programManagementEmbedUrl } from "./embed";

describe("programManagementEmbedUrl", () => {
  it("accepts an https URL", () => {
    expect(programManagementEmbedUrl("https://pm.example.com/")?.href).toBe("https://pm.example.com/");
  });

  it("is null when unset or blank", () => {
    expect(programManagementEmbedUrl(undefined)).toBeNull();
    expect(programManagementEmbedUrl("   ")).toBeNull();
  });

  it("is null for a malformed value, so the built-in page shows instead", () => {
    expect(programManagementEmbedUrl("pm.example.com")).toBeNull();
    expect(programManagementEmbedUrl("not a url")).toBeNull();
  });

  it("refuses plain http to a real host", () => {
    expect(programManagementEmbedUrl("http://pm.example.com/")).toBeNull();
  });

  it("allows plain http on loopback, for a local copy", () => {
    expect(programManagementEmbedUrl("http://localhost:4000/")?.origin).toBe("http://localhost:4000");
    expect(programManagementEmbedUrl("http://127.0.0.1:4000/")).not.toBeNull();
  });

  it("refuses other schemes", () => {
    expect(programManagementEmbedUrl("javascript:alert(1)")).toBeNull();
    expect(programManagementEmbedUrl("data:text/html,hi")).toBeNull();
  });

  it("refuses a URL carrying credentials rather than putting them in the page", () => {
    expect(programManagementEmbedUrl("https://user:pass@pm.example.com/")).toBeNull();
  });
});

describe("programManagementEmbedOrigin", () => {
  it("is the origin only", () => {
    expect(programManagementEmbedOrigin("https://pm.example.com/a/b?c=1")).toBe("https://pm.example.com");
  });
});
