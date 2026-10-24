// COSMOS-202 T1 d: COSMOS_PUBLIC_URL is an https origin (plain http only for
// localhost), or nothing: a bad value turns the feature off, never widens it.
import { describe, it, expect, afterEach } from "vitest";
import { configuredPublicOrigin } from "./hosts";

afterEach(() => {
  delete process.env.COSMOS_PUBLIC_URL;
});

describe("configuredPublicOrigin", () => {
  it("is the origin of an https URL, without path or trailing slash", () => {
    process.env.COSMOS_PUBLIC_URL = "https://cosmos.example.com/some/path/";
    expect(configuredPublicOrigin()).toBe("https://cosmos.example.com");
  });

  it("allows http only for localhost", () => {
    process.env.COSMOS_PUBLIC_URL = "http://localhost:3000";
    expect(configuredPublicOrigin()).toBe("http://localhost:3000");
    process.env.COSMOS_PUBLIC_URL = "http://cosmos.example.com";
    expect(configuredPublicOrigin()).toBeNull();
  });

  it("is null when unset, blank or not a URL", () => {
    expect(configuredPublicOrigin()).toBeNull();
    process.env.COSMOS_PUBLIC_URL = "  ";
    expect(configuredPublicOrigin()).toBeNull();
    process.env.COSMOS_PUBLIC_URL = "cosmos.example.com";
    expect(configuredPublicOrigin()).toBeNull();
  });
});
