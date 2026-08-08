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

describe("rotating the signing key", () => {
  // The property under test is the OVERLAP: during a rotation both keys are
  // trusted at once, which is the only way to reissue licences to air-gapped
  // installs without coordinating a simultaneous swap that cannot be
  // coordinated. Each assertion below is a step through one rotation.
  const OLD = VENDOR;
  const NEW = keypair();

  it("accepts a licence signed by the OLD key while both are trusted", () => {
    const r = verifyEntitlement(mint(claims(), OLD.priv), [NEW.pub, OLD.pub], NOW);
    expect(r.ok).toBe(true);
  });

  it("accepts a licence signed by the NEW key while both are trusted", () => {
    const r = verifyEntitlement(mint(claims(), NEW.priv), [NEW.pub, OLD.pub], NOW);
    expect(r.ok).toBe(true);
  });

  it("does not care which position in the set the matching key is in", () => {
    expect(verifyEntitlement(mint(claims(), OLD.priv), [OLD.pub, NEW.pub], NOW).ok).toBe(true);
    expect(verifyEntitlement(mint(claims(), NEW.priv), [OLD.pub, NEW.pub], NOW).ok).toBe(true);
  });

  it("stops accepting the old key once it is REMOVED — retirement is real", () => {
    // The half that matters after a compromise: dropping a key must actually
    // revoke everything it signed.
    const r = verifyEntitlement(mint(claims(), OLD.priv), [NEW.pub], NOW);
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("still refuses a key that was never in the set", () => {
    // Trusting several keys must not decay into trusting any key.
    const r = verifyEntitlement(mint(claims(), ATTACKER.priv), [NEW.pub, OLD.pub], NOW);
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("survives a mangled PEM sitting beside a good one", () => {
    // The realistic rotation accident: the new key is pasted in badly. It must
    // not take down every licence still signed by the good old one.
    expect(verifyEntitlement(mint(claims(), OLD.priv), ["-----BEGIN PUBLIC KEY-----oops", OLD.pub], NOW).ok).toBe(true);
    expect(verifyEntitlement(mint(claims(), OLD.priv), [OLD.pub, "not a pem at all"], NOW).ok).toBe(true);
  });

  it("blames the DEPLOYMENT, not the licence, when no key can be parsed", () => {
    // "not issued by us" would send an admin to argue with their vendor about a
    // licence that is perfectly good.
    expect(verifyEntitlement(mint(claims()), ["not a pem"], NOW)).toEqual({
      ok: false,
      reason: "unusable_public_key",
    });
    expect(verifyEntitlement(mint(claims()), "not a pem", NOW)).toEqual({
      ok: false,
      reason: "unusable_public_key",
    });
  });

  it("treats an empty or blank set as no key at all", () => {
    expect(verifyEntitlement(mint(claims()), [], NOW)).toEqual({ ok: false, reason: "no_public_key" });
    expect(verifyEntitlement(mint(claims()), ["", "   "], NOW)).toEqual({
      ok: false,
      reason: "no_public_key",
    });
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
