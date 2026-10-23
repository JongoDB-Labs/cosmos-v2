import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyBearer, parseKeyToken } from "../bearer";

describe("classifyBearer", () => {
  it.each([
    ["Bearer cosmos_a1b2c3_SeCrEt-x_y", "api_key"],
    ["  Bearer   cosmos_a1b2c3_s  ", "api_key"],
    // A key's secret is base64url and may contain anything after the hex
    // prefix, `_oat_` included. Only the prefix position decides the kind.
    ["Bearer cosmos_a1b2c3__oat_00_x", "api_key"],
    ["Bearer cosmos_oat_0f1e_secret", "oauth_access"],
    ["Bearer cosmos_ort_0f1e_secret", "oauth_refresh"],
    // Cosmos-shaped but not any credential we mint: refused, not ignored.
    ["Bearer cosmos_", "invalid"],
    ["Bearer cosmos_XYZ_secret", "invalid"],
    ["Bearer cosmos_oat_", "invalid"],
    ["Bearer cosmos_a1b2 c3_secret", "invalid"],
  ])("%s → %s", (header, kind) => {
    expect(classifyBearer(header)).toBe(kind);
  });

  it.each([null, undefined, "", "Bearer ", "Bearer sk-ant-oat01-x", "Basic Y29zbW9zXw==", "cosmos_a1_b"])(
    "%s carries no Cosmos bearer",
    (header) => {
      expect(classifyBearer(header)).toBeNull();
    },
  );
});

describe("parseKeyToken", () => {
  it("splits at the hex prefix and keeps the whole remainder as the secret", () => {
    expect(parseKeyToken("Bearer cosmos_a1b2c3_x_y-z")).toEqual({ prefix: "a1b2c3", secret: "x_y-z" });
  });

  it("never reads an OAuth token as a key", () => {
    // `oat` is not hex, so this cannot become prefix "oat"; were it to, an
    // access token would be looked up in api_keys under an attacker-chosen prefix.
    expect(parseKeyToken("Bearer cosmos_oat_0f1e_secret")).toBeNull();
  });
});

/**
 * The rule the three inline regexes enforced, kept now that there is one
 * classifier: a request presenting a Cosmos bearer is decided by that bearer.
 * Both auth entrypoints must refuse an unusable one rather than fall through
 * to the cookie, and the proxy must not hold it to cookie-only checks.
 */
describe("every bearer decision goes through classifyBearer", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it.each(["src/proxy.ts", "src/lib/auth/session.ts", "src/lib/auth/api-key.ts"])(
    "%s has no private copy of the token regex",
    (p) => {
      expect(src(p)).not.toMatch(/Bearer\\s\+cosmos_/);
      expect(src(p)).toContain("classifyBearer(");
    },
  );

  it("getAuthContext returns before the cookie for a bearer that is not a key", () => {
    const s = src("src/lib/auth/session.ts");
    const body = s.slice(s.indexOf("export const getAuthContext"));
    const branch = body.slice(0, body.indexOf("await getCurrentUser()"));
    expect(branch).toMatch(/if \(bearer !== "api_key"\) return null;/);
  });
});
