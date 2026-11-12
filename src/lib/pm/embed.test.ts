// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  programManagementEmbedOrigin,
  programManagementEmbedUrl,
  programManagementSameSiteOrigin,
  programManagementSignInUrl,
} from "./embed";

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

// The loop this guards was measured on a live instance served at an old and a
// new domain: the dashboard stayed signed in only in a frame on its own site.
describe("programManagementSameSiteOrigin", () => {
  const EMBED = "https://pm.example.dev/";
  const BOTH = "cosmos.example.net, cosmos.example.dev";
  const from = (here: string, addresses: string | undefined = BOTH, embed: string | undefined = EMBED) =>
    programManagementSameSiteOrigin(here, embed, addresses);

  it("sends a page on another site to this instance's address on the dashboard's site", () => {
    expect(from("https://cosmos.example.net")).toBe("https://cosmos.example.dev");
  });

  it("control: a page already on the dashboard's site stays", () => {
    expect(from("https://cosmos.example.dev")).toBeNull();
    // Another subdomain of the same site is the same site.
    expect(from("https://other.example.dev")).toBeNull();
  });

  it("stays when no listed address shares the dashboard's site", () => {
    expect(from("https://cosmos.example.net", "cosmos.example.net")).toBeNull();
    // Called directly: `undefined` would take the helper's own default.
    expect(programManagementSameSiteOrigin("https://cosmos.example.net", EMBED, undefined)).toBeNull();
    expect(from("https://cosmos.example.net", "")).toBeNull();
  });

  it("reads Caddy's address forms, and skips the ones naming no host", () => {
    expect(from("https://cosmos.example.net", "cosmos.example.net cosmos.example.dev")).toBe("https://cosmos.example.dev");
    expect(from("https://cosmos.example.net", '"cosmos.example.net, cosmos.example.dev"')).toBe("https://cosmos.example.dev");
    expect(from("https://cosmos.example.net", "https://cosmos.example.dev:8443")).toBe("https://cosmos.example.dev:8443");
    expect(from("https://cosmos.example.net", ":80")).toBeNull();
    expect(from("https://cosmos.example.net", "*.example.dev")).toBeNull();
    // Plain http to a real host is never a target: it is not the same site as
    // an https dashboard.
    expect(from("https://cosmos.example.net", "http://cosmos.example.dev")).toBeNull();
  });

  it("compares scheme too: a browser treats http and https as different sites", () => {
    // Same registrable domain, plain http: cross-site to an https dashboard.
    expect(from("http://cosmos.example.dev", "cosmos.example.dev")).toBe("https://cosmos.example.dev");
    expect(from("http://localhost:3000", "http://localhost:3001", "http://localhost:4000/")).toBeNull();
    expect(from("http://127.0.0.1:3000", "http://localhost:3000", "http://localhost:4000/")).toBe("http://localhost:3000");
  });

  it("does nothing without a dashboard, or with an unreadable current address", () => {
    expect(from("https://cosmos.example.net", BOTH, "")).toBeNull();
    expect(from("not an origin")).toBeNull();
  });
});
