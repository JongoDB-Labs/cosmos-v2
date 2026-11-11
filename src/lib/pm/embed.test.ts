// @vitest-environment node
import { describe, it, expect } from "vitest";
import { programManagementEmbedOrigin, programManagementEmbedUrl, programManagementSignInUrl } from "./embed";

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

describe("programManagementSignInUrl", () => {
  const EMBED = "https://pm.example.com/";
  const at = (signIn: string | undefined, embed: string | undefined = EMBED) =>
    programManagementSignInUrl(signIn, embed)?.href ?? null;

  it("is the configured sign-in start when it is on the dashboard's origin", () => {
    expect(at("https://pm.example.com/auth/start?next=/home")).toBe("https://pm.example.com/auth/start?next=/home");
  });

  it("falls back to the dashboard when unset, unusable, or on another origin", () => {
    expect(at(undefined)).toBe(EMBED);
    expect(at("not a url")).toBe(EMBED);
    // Same site, different origin: still refused. Cosmos opens this window.
    expect(at("https://auth.example.com/start")).toBe(EMBED);
    expect(at("https://evil.example.net/auth/start")).toBe(EMBED);
    // http to a real host is refused by the same rule as the embed itself.
    expect(at("http://pm.example.com/auth/start")).toBe(EMBED);
  });

  it("is null without a dashboard, whatever the sign-in setting says", () => {
    expect(programManagementSignInUrl("https://pm.example.com/auth/start", "")).toBeNull();
  });
});
