// @vitest-environment node
//
// The licence is the only unforgeable input the plugin gate has. These
// assertions are what "unforgeable" means in practice — most of them are about
// what must be REFUSED, because a licence check that only proves the happy path
// works is a licence check that has never been attacked.
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  verifyEntitlement,
  entitles,
  signingInput,
  ANY,
  type EntitlementClaims,
} from "./entitlement";

const NOW = 1_800_000_000;

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
    priv: privateKey,
  };
}

const VENDOR = keypair();
/** Someone else's key — the forger's. */
const ATTACKER = keypair();

const claims = (over: Partial<EntitlementClaims> = {}): EntitlementClaims => ({
  v: 1,
  lid: "11111111-1111-4111-a111-111111111111",
  orgId: "org-1",
  instance: ANY,
  plugins: ["whiteboard"],
  iat: NOW - 100,
  exp: NOW + 86_400,
  ...over,
});

function mint(c: EntitlementClaims, key = VENDOR.priv): string {
  const payload = Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
  const sig = sign(null, signingInput(payload), key).toString("base64url");
  return `cosmos-lic.v1.${payload}.${sig}`;
}

describe("a licence this vendor issued", () => {
  it("verifies, and returns its claims", () => {
    const r = verifyEntitlement(mint(claims()), VENDOR.pub, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims.plugins).toEqual(["whiteboard"]);
  });

  it("survives a round trip through whitespace, as a paste would", () => {
    expect(verifyEntitlement(`\n  ${mint(claims())}  \n`, VENDOR.pub, NOW).ok).toBe(true);
  });
});

describe("a licence this vendor did NOT issue", () => {
  it("is refused when signed by another key", () => {
    // The whole point of asymmetric: holding the image, and therefore the public
    // key, must not let anyone mint a licence.
    const r = verifyEntitlement(mint(claims(), ATTACKER.priv), VENDOR.pub, NOW);
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("is refused when the claims are edited after signing", () => {
    // The attack the signature exists to stop: take a real licence for one
    // plugin and repoint it at another.
    const token = mint(claims({ plugins: ["whiteboard"] }));
    const [, , payload, sig] = token.split(".");
    const edited = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    edited.plugins = ["whiteboard", "pi-planning"];
    const tampered = `cosmos-lic.v1.${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${sig}`;

    expect(verifyEntitlement(tampered, VENDOR.pub, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("is refused when the signature is simply removed", () => {
    const [, , payload] = mint(claims()).split(".");
    expect(verifyEntitlement(`cosmos-lic.v1.${payload}.`, VENDOR.pub, NOW).ok).toBe(false);
    expect(verifyEntitlement(`cosmos-lic.v1.${payload}`, VENDOR.pub, NOW).ok).toBe(false);
  });

  it("refuses unsigned JSON that merely looks like claims", () => {
    const payload = Buffer.from(JSON.stringify(claims())).toString("base64url");
    expect(verifyEntitlement(`cosmos-lic.v1.${payload}.AAAA`, VENDOR.pub, NOW).ok).toBe(false);
  });
});

describe("time", () => {
  it("refuses an expired licence", () => {
    const r = verifyEntitlement(mint(claims({ exp: NOW - 3600 })), VENDOR.pub, NOW);
    expect(r).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses one that is not valid yet", () => {
    const r = verifyEntitlement(mint(claims({ iat: NOW + 3600, exp: NOW + 7200 })), VENDOR.pub, NOW);
    expect(r).toEqual({ ok: false, reason: "not_yet_valid" });
  });

  it("tolerates a few minutes of clock skew in both directions", () => {
    // Air-gapped boxes drift and some have no NTP. An outage caused by our own
    // strictness would be worse than the risk, which is nil — a forger still has
    // to produce a signature.
    expect(verifyEntitlement(mint(claims({ exp: NOW - 60 })), VENDOR.pub, NOW).ok).toBe(true);
    expect(verifyEntitlement(mint(claims({ iat: NOW + 60 })), VENDOR.pub, NOW).ok).toBe(true);
  });

  it("does NOT tolerate skew beyond the allowance", () => {
    expect(verifyEntitlement(mint(claims({ exp: NOW - 3600 })), VENDOR.pub, NOW).ok).toBe(false);
  });
});

describe("malformed input never throws out of the gate", () => {
  it.each([
    ["", "malformed"],
    ["not-a-token", "malformed"],
    ["cosmos-lic.v1.@@@.###", "malformed"],
    ["cosmos-lic.v9.aaaa.bbbb", "unsupported_version"],
    ["other-thing.v1.aaaa.bbbb", "malformed"],
  ])("%s → %s", (token, reason) => {
    expect(verifyEntitlement(token, VENDOR.pub, NOW)).toEqual({ ok: false, reason });
  });

  it.each([null, undefined, 42, {}, []])("refuses non-string %s", (bad) => {
    expect(verifyEntitlement(bad as never, VENDOR.pub, NOW).ok).toBe(false);
  });

  it("refuses a valid signature over a payload that is not claims", () => {
    const payload = Buffer.from(JSON.stringify({ hello: "world" })).toString("base64url");
    const sig = sign(null, signingInput(payload), VENDOR.priv).toString("base64url");
    expect(verifyEntitlement(`cosmos-lic.v1.${payload}.${sig}`, VENDOR.pub, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("reports a missing public key distinctly — that is an operator error", () => {
    expect(verifyEntitlement(mint(claims()), null, NOW)).toEqual({
      ok: false,
      reason: "no_public_key",
    });
  });

  it("does not throw on a garbage public key", () => {
    expect(() => verifyEntitlement(mint(claims()), "not a pem", NOW)).not.toThrow();
    expect(verifyEntitlement(mint(claims()), "not a pem", NOW).ok).toBe(false);
  });
});

describe("what a verified licence actually entitles", () => {
  it("covers the named org and the named plugin", () => {
    expect(entitles(claims(), { orgId: "org-1", slug: "whiteboard" })).toBe(true);
  });

  it("does NOT leak to another org", () => {
    // A real licence for someone else is still a real licence; scope is a
    // separate question from authenticity, which is why it is a separate function.
    expect(entitles(claims(), { orgId: "org-2", slug: "whiteboard" })).toBe(false);
  });

  it("does NOT leak to an unlisted plugin", () => {
    expect(entitles(claims(), { orgId: "org-1", slug: "pi-planning" })).toBe(false);
  });

  it("honours a site licence for every org", () => {
    expect(entitles(claims({ orgId: ANY }), { orgId: "anything", slug: "whiteboard" })).toBe(true);
  });

  it("honours a wildcard plugin list", () => {
    expect(entitles(claims({ plugins: [ANY] }), { orgId: "org-1", slug: "anything" })).toBe(true);
  });

  it("binds to an instance when the licence names one", () => {
    const c = claims({ instance: "alpha" });
    expect(entitles(c, { orgId: "org-1", slug: "whiteboard", instance: "alpha" })).toBe(true);
    expect(entitles(c, { orgId: "org-1", slug: "whiteboard", instance: "beta" })).toBe(false);
  });

  it("applies an instance-bound licence where the deployment names no instance", () => {
    // Refusing here would strand every install that has not set COSMOS_INSTANCE,
    // which is most of them — a licence must not be defeated by an unset hint.
    const c = claims({ instance: "alpha" });
    expect(entitles(c, { orgId: "org-1", slug: "whiteboard", instance: null })).toBe(true);
  });
});
