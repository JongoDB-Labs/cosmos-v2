import { describe, expect, it } from "vitest";
import { clientIpConfigProblems, clientIpForRecords, trustedClientIp } from "../client-ip";

const h = (init: Record<string, string>) => new Headers(init);
const env = (vars: Record<string, string> = {}) => vars as NodeJS.ProcessEnv;

describe("trustedClientIp", () => {
  it("defaults to the right-most X-Forwarded-For entry: the one the edge wrote", () => {
    expect(trustedClientIp(h({ "x-forwarded-for": "203.0.113.9" }), env())).toBe("203.0.113.9");
    expect(trustedClientIp(h({ "x-forwarded-for": "198.51.100.7, 203.0.113.9" }), env())).toBe("203.0.113.9");
  });

  it("ignores headers the edge doesn't set, unless the deployment names one", () => {
    const req = h({ "cf-connecting-ip": "198.51.100.7", "x-real-ip": "198.51.100.8", "x-forwarded-for": "203.0.113.9" });
    expect(trustedClientIp(req, env())).toBe("203.0.113.9");
    expect(trustedClientIp(req, env({ TRUSTED_CLIENT_IP_HEADER: "CF-Connecting-IP" }))).toBe("198.51.100.7");
    expect(trustedClientIp(req, env({ TRUSTED_CLIENT_IP_HEADER: "x-real-ip" }))).toBe("198.51.100.8");
  });

  it("counts TRUSTED_PROXY_HOPS entries from the right", () => {
    const req = h({ "x-forwarded-for": "192.0.2.1, 198.51.100.7, 10.0.0.2" });
    expect(trustedClientIp(req, env({ TRUSTED_PROXY_HOPS: "2" }))).toBe("198.51.100.7");
    expect(trustedClientIp(req, env({ TRUSTED_PROXY_HOPS: "3" }))).toBe("192.0.2.1");
    // More hops than entries: the client wrote none of them, so there is no answer.
    expect(trustedClientIp(req, env({ TRUSTED_PROXY_HOPS: "4" }))).toBeNull();
  });

  it("answers nothing rather than guess: no header, not an address, or a bad hop count", () => {
    expect(trustedClientIp(h({}), env())).toBeNull();
    expect(trustedClientIp(h({ "x-forwarded-for": "unknown" }), env())).toBeNull();
    for (const hops of ["0", "-1", "1.5", "two"]) {
      expect(trustedClientIp(h({ "x-forwarded-for": "203.0.113.9" }), env({ TRUSTED_PROXY_HOPS: hops })), hops).toBeNull();
    }
  });

  it("reads IPv6", () => {
    expect(trustedClientIp(h({ "x-forwarded-for": "2001:db8::1" }), env())).toBe("2001:db8::1");
  });

  it("treats a blank setting as unset, not as zero hops or no header", () => {
    const req = h({ "x-forwarded-for": "198.51.100.7, 203.0.113.9" });
    for (const blank of ["", " ", "\t"]) {
      expect(trustedClientIp(req, env({ TRUSTED_PROXY_HOPS: blank })), JSON.stringify(blank)).toBe("203.0.113.9");
      expect(trustedClientIp(req, env({ TRUSTED_CLIENT_IP_HEADER: blank })), JSON.stringify(blank)).toBe("203.0.113.9");
    }
  });

  it("takes only a plain whole number of hops", () => {
    for (const hops of ["1e0", "0x1", "+1", "01x", " 2 x"]) {
      expect(trustedClientIp(h({ "x-forwarded-for": "203.0.113.9" }), env({ TRUSTED_PROXY_HOPS: hops })), hops).toBeNull();
    }
    expect(trustedClientIp(h({ "x-forwarded-for": "198.51.100.7, 203.0.113.9" }), env({ TRUSTED_PROXY_HOPS: " 2 " }))).toBe("198.51.100.7");
  });

  it("refuses an address written any way but the plain one, so it can't match a range it isn't in", () => {
    // 010.000.000.001 parses as octal (8.0.0.1) in some readers and decimal in others.
    for (const odd of ["010.000.000.001", "10.1", "0x0a.0.0.1", "203.0.113.9:443", "[2001:db8::1]"]) {
      expect(trustedClientIp(h({ "x-forwarded-for": odd }), env()), odd).toBeNull();
    }
  });

  it("answers an IPv4 client reached over IPv6 in its IPv4 form", () => {
    expect(trustedClientIp(h({ "x-forwarded-for": "::ffff:203.0.113.9" }), env())).toBe("203.0.113.9");
  });
});

describe("clientIpConfigProblems (checked at startup)", () => {
  it("finds nothing wrong with the defaults or with sound settings", () => {
    expect(clientIpConfigProblems(env())).toEqual([]);
    expect(clientIpConfigProblems(env({ TRUSTED_CLIENT_IP_HEADER: " ", TRUSTED_PROXY_HOPS: "" }))).toEqual([]);
    expect(clientIpConfigProblems(env({ TRUSTED_CLIENT_IP_HEADER: "CF-Connecting-IP", TRUSTED_PROXY_HOPS: "2" }))).toEqual([]);
  });

  it("names each setting it can't use", () => {
    const problems = clientIpConfigProblems(env({ TRUSTED_CLIENT_IP_HEADER: "x forwarded for", TRUSTED_PROXY_HOPS: "0" }));
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toMatch(/TRUSTED_CLIENT_IP_HEADER/);
    expect(problems.join("\n")).toMatch(/TRUSTED_PROXY_HOPS/);
  });
});

describe("clientIpForRecords (audit log, rate-limit buckets)", () => {
  it("is unchanged until the deployment names its edge's header: left-most X-Forwarded-For, then X-Real-IP", () => {
    expect(clientIpForRecords(h({ "x-forwarded-for": "198.51.100.7, 203.0.113.9" }), env())).toBe("198.51.100.7");
    expect(clientIpForRecords(h({ "x-real-ip": "198.51.100.8" }), env())).toBe("198.51.100.8");
    expect(clientIpForRecords(h({}), env())).toBeUndefined();
  });

  it("falls back to the old address, not to nothing, when the configured one can't be read", () => {
    // Otherwise every such caller would share a single rate-limit bucket.
    const req = h({ "x-forwarded-for": "198.51.100.7, 203.0.113.9" });
    expect(clientIpForRecords(req, env({ TRUSTED_CLIENT_IP_HEADER: "cf-connecting-ip" }))).toBe("198.51.100.7");
    expect(clientIpForRecords(req, env({ TRUSTED_PROXY_HOPS: "0" }))).toBe("198.51.100.7");
    expect(clientIpForRecords(h({ "x-real-ip": "198.51.100.8" }), env({ TRUSTED_PROXY_HOPS: "5" }))).toBe("198.51.100.8");
  });

  it("uses the trusted address once it is configured", () => {
    const req = h({ "x-forwarded-for": "198.51.100.7, 203.0.113.9", "cf-connecting-ip": "192.0.2.5" });
    expect(clientIpForRecords(req, env({ TRUSTED_PROXY_HOPS: "1" }))).toBe("203.0.113.9");
    expect(clientIpForRecords(req, env({ TRUSTED_CLIENT_IP_HEADER: "cf-connecting-ip" }))).toBe("192.0.2.5");
  });
});
