// @vitest-environment node
//
// The public origin is read from headers the edge forwards. A header this code
// can't use as a host must not break the request: it falls back to the
// request's own origin.
import { describe, expect, it } from "vitest";
import { getPublicOrigin, publicOriginFromHeaders } from "./public-url";

const at = (headers: Record<string, string>) => new Request("http://localhost:3000/acme", { headers });

describe("getPublicOrigin", () => {
  it("uses the forwarded host and scheme", () => {
    expect(getPublicOrigin(at({ "x-forwarded-host": "cosmos.example.dev", "x-forwarded-proto": "https" }))).toBe(
      "https://cosmos.example.dev",
    );
    expect(getPublicOrigin(at({ "x-forwarded-host": "cosmos.example.dev:8443", "x-forwarded-proto": "https" }))).toBe(
      "https://cosmos.example.dev:8443",
    );
  });

  it("takes the first of several forwarded hosts and schemes, trimmed", () => {
    const origin = getPublicOrigin(
      at({ "x-forwarded-host": " cosmos.example.dev , internal.example", "x-forwarded-proto": "https, http" }),
    );
    expect(origin).toBe("https://cosmos.example.dev");
  });

  it("falls back to the host header, then infers the scheme", () => {
    expect(getPublicOrigin(at({ host: "cosmos.example.dev" }))).toBe("https://cosmos.example.dev");
    expect(getPublicOrigin(at({ host: "localhost:3000" }))).toBe("http://localhost:3000");
    // A container's service name.
    expect(getPublicOrigin(at({ host: "cosmos_web:3000" }))).toBe("https://cosmos_web:3000");
  });

  it.each([
    ["a path", "cosmos.example.dev/elsewhere"],
    ["credentials", "user@cosmos.example.dev"],
    ["a query", "cosmos.example.dev?x=1"],
    ["a space", "cosmos example.dev"],
    ["nothing before the comma", ", cosmos.example.dev"],
    ["a port that is not a number", "cosmos.example.dev:https"],
  ])("falls back to the request's own origin for a forwarded host with %s", (_shape, host) => {
    expect(getPublicOrigin(at({ "x-forwarded-host": host, "x-forwarded-proto": "https" }))).toBe("http://localhost:3000");
  });

  it("ignores a forwarded scheme that is not http or https", () => {
    expect(getPublicOrigin(at({ "x-forwarded-host": "cosmos.example.dev", "x-forwarded-proto": "javascript" }))).toBe(
      "https://cosmos.example.dev",
    );
  });
});

describe("publicOriginFromHeaders", () => {
  it("is null when there is no usable host, so the caller decides", () => {
    expect(publicOriginFromHeaders(new Headers())).toBeNull();
    expect(publicOriginFromHeaders(new Headers({ "x-forwarded-host": "a.example/b" }))).toBeNull();
  });
});
