// @vitest-environment node
//
// The public origin is read from headers the edge forwards. When a proxy
// appends to a header, the right-most value is the one the nearest proxy
// wrote; anything to its left came from the client. A value this code can't
// use as a host is refused: the Host header is used instead, then the
// request's own origin.
import { describe, expect, it } from "vitest";
import { getPublicOrigin, publicOriginFromHeaders } from "./public-url";

const at = (headers: Record<string, string>) => new Request("http://localhost:3000/acme", { headers });

describe("getPublicOrigin", () => {
  it("uses the forwarded host and scheme", () => {
    expect(getPublicOrigin(at({ "x-forwarded-host": "cosmos.example", "x-forwarded-proto": "https" }))).toBe(
      "https://cosmos.example",
    );
    expect(getPublicOrigin(at({ "x-forwarded-host": "cosmos.example:8443", "x-forwarded-proto": "https" }))).toBe(
      "https://cosmos.example:8443",
    );
  });

  it("uses the right-most of several forwarded hosts: the one the nearest proxy wrote", () => {
    expect(getPublicOrigin(at({ "x-forwarded-host": "evil.example, cosmos.example", "x-forwarded-proto": "https" }))).toBe(
      "https://cosmos.example",
    );
  });

  it("skips an empty value at the end, and trims", () => {
    expect(getPublicOrigin(at({ "x-forwarded-host": "cosmos.example, ", "x-forwarded-proto": "https" }))).toBe(
      "https://cosmos.example",
    );
    expect(getPublicOrigin(at({ "x-forwarded-host": "  cosmos.example  ", "x-forwarded-proto": "https" }))).toBe(
      "https://cosmos.example",
    );
  });

  it("uses the right-most forwarded scheme", () => {
    expect(getPublicOrigin(at({ "x-forwarded-host": "cosmos.example", "x-forwarded-proto": "http, https" }))).toBe(
      "https://cosmos.example",
    );
  });

  it("ignores a forwarded scheme that is not http or https, and infers it", () => {
    expect(getPublicOrigin(at({ "x-forwarded-host": "cosmos.example", "x-forwarded-proto": "javascript" }))).toBe(
      "https://cosmos.example",
    );
  });

  it("uses the Host header when nothing is forwarded, and infers the scheme", () => {
    expect(getPublicOrigin(at({ host: "cosmos.example" }))).toBe("https://cosmos.example");
    expect(getPublicOrigin(at({ host: "localhost:3000" }))).toBe("http://localhost:3000");
    // A container's service name.
    expect(getPublicOrigin(at({ host: "cosmos_web:3000" }))).toBe("https://cosmos_web:3000");
  });

  it.each([
    ["a path", "evil.example/x"],
    ["credentials", "user@evil.example"],
    ["a scheme", "https://evil.example"],
    ["a query", "evil.example?x=1"],
    ["a space", "evil example"],
    ["a port that is not a number", "evil.example:https"],
    ["a port no URL can hold", "evil.example:99999"],
  ])("refuses a forwarded host with %s, and uses the Host header", (_shape, forwarded) => {
    expect(getPublicOrigin(at({ "x-forwarded-host": forwarded, host: "cosmos.example" }))).toBe("https://cosmos.example");
  });

  it("falls back to the request's own origin when no header holds a host", () => {
    expect(getPublicOrigin(at({ "x-forwarded-host": "evil.example/x" }))).toBe("http://localhost:3000");
    expect(getPublicOrigin(at({ "x-forwarded-host": "evil.example/x", host: "user@evil.example" }))).toBe(
      "http://localhost:3000",
    );
  });
});

describe("publicOriginFromHeaders", () => {
  it("is null when there is no usable host, so the caller decides", () => {
    expect(publicOriginFromHeaders(new Headers())).toBeNull();
    expect(publicOriginFromHeaders(new Headers({ "x-forwarded-host": "a.example/b" }))).toBeNull();
  });
});
