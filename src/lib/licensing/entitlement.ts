import { createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * Offline-verifiable entitlement licences (ADR 0004, Tier 1).
 *
 * PURE and dependency-free on purpose: parsing and signature checking are
 * separated from where a licence is found and what is done about it, so the
 * decision can be exercised without an environment, a database or a filesystem.
 *
 * ## Why asymmetric, and why this is not optional
 *
 * `OrgPluginState` already gates every plugin surface fail-closed. What it lacks
 * is an UNFORGEABLE input: today an operator with database access can flip
 * `enabled` and switch on anything. Any symmetric scheme reproduces that hole —
 * an HMAC secret has to ship inside the image to be verified there, and a secret
 * on the customer's disk is a secret the customer can sign with. So the vendor
 * signs with a private key that never leaves the vendor, and the image carries
 * only the PUBLIC key.
 *
 * Ed25519 specifically: small keys and signatures, no parameter choices to get
 * wrong, no RNG needed at verification time, and it is in Node's standard
 * library — so this adds no dependency to a platform that ships to air-gapped
 * environments.
 *
 * ## Why a SET of public keys, not one
 *
 * Verification accepts several keys and succeeds if any of them matches. That is
 * the whole of the rotation story, and it has to exist before there are licences
 * in the field rather than after.
 *
 * With a single key, rotating means every deployment must swap its key at the
 * same instant every licence is reissued — impossible to coordinate across
 * air-gapped installs, so in practice it means an outage. With a set, rotation is
 * an overlap window: publish the new key ALONGSIDE the old, reissue licences at
 * whatever pace the customers allow, then drop the old key once nothing is signed
 * by it. This is the same shape as a CA bundle or a JWKS document, for the same
 * reason.
 *
 * A retired key must be REMOVED to be retired. Leaving it in the set means
 * anything it ever signed still verifies — which is exactly the point during an
 * overlap, and exactly the danger after a compromise.
 *
 * ## No phone-home, ever
 *
 * This platform runs air-gapped. A licence that needs the internet is a licence
 * that fails in exactly the deployments that matter most, so verification is a
 * local signature check and nothing else. Revocation is therefore expiry-driven:
 * issue short, reissue routinely. A licence server would be simpler and is the
 * wrong trade here.
 */

/** Wire format marker. Bump only for an INCOMPATIBLE payload change. */
const TOKEN_PREFIX = "cosmos-lic.v1";

/** Wildcard accepted in `orgId` / `instance` for a site-wide licence. */
export const ANY = "*";

export interface EntitlementClaims {
  /** Payload schema version, independent of the wire prefix. */
  v: 1;
  /** Licence id — the handle a revocation list or a support ticket refers to. */
  lid: string;
  /** Org this licence is for, or `*` for every org on the instance. */
  orgId: string;
  /** Instance/deployment slug this is bound to, or `*` for any. */
  instance: string;
  /** Plugin slugs this licence entitles. `*` entitles all of them. */
  plugins: string[];
  /** Free-text plan name, for display only — never for a gate. */
  plan?: string;
  /** Issued-at and expiry, seconds since the epoch. */
  iat: number;
  exp: number;
}

export type VerifyFailure =
  | "malformed"
  | "unsupported_version"
  | "bad_signature"
  | "expired"
  | "not_yet_valid"
  | "no_public_key"
  /**
   * Keys ARE configured, and not one of them could be parsed. Distinct from
   * `bad_signature` on purpose: that reason accuses the customer's licence, and
   * telling an admin their licence "was not issued by us" when the real fault is
   * a PEM this deployment mangled sends them to the wrong place entirely.
   */
  | "unusable_public_key";

export type VerifyResult =
  | { ok: true; claims: EntitlementClaims }
  | { ok: false; reason: VerifyFailure };

/**
 * Clock skew allowance, both directions.
 *
 * Air-gapped boxes drift, and some have no NTP at all. Refusing a licence issued
 * four minutes ago because this machine's clock runs slow would be an outage
 * caused entirely by our own strictness. Five minutes is small enough to be
 * meaningless to an attacker — who would have to forge a signature anyway.
 */
const SKEW_SECONDS = 300;

/** Base64url → Buffer, rejecting anything that is not valid base64url. */
function fromB64Url(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    return Buffer.from(s, "base64url");
  } catch {
    return null;
  }
}

function isClaims(value: unknown): value is EntitlementClaims {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    c.v === 1 &&
    typeof c.lid === "string" &&
    typeof c.orgId === "string" &&
    typeof c.instance === "string" &&
    Array.isArray(c.plugins) &&
    c.plugins.every((p) => typeof p === "string") &&
    typeof c.iat === "number" &&
    typeof c.exp === "number" &&
    (c.plan === undefined || typeof c.plan === "string")
  );
}

/** The exact bytes that are signed: prefix and payload, never the signature. */
export function signingInput(payloadB64: string): Buffer {
  return Buffer.from(`${TOKEN_PREFIX}.${payloadB64}`, "utf8");
}

/** Every PEM the caller offered, blanks dropped. */
function keyList(input: string | readonly string[] | null | undefined): string[] {
  if (!input) return [];
  const all = typeof input === "string" ? [input] : input;
  return all.filter((k): k is string => typeof k === "string").map((k) => k.trim()).filter(Boolean);
}

/**
 * Verify a licence token against one or more PEM-encoded Ed25519 public keys.
 *
 * Signature FIRST, claims after. Checking expiry before the signature would let
 * an attacker learn which forged payloads are well-formed by timing the
 * different rejection paths — and, more practically, would mean an unsigned
 * blob could produce a "expired" message that reads as though it was ever real.
 *
 * `now` is injected so the boundary cases are testable without touching the
 * system clock.
 */
export function verifyEntitlement(
  token: unknown,
  publicKeyPem: string | readonly string[] | null | undefined,
  now: number,
): VerifyResult {
  const pems = keyList(publicKeyPem);
  if (pems.length === 0) return { ok: false, reason: "no_public_key" };
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "malformed" };
  }

  const parts = token.trim().split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };

  const [name, version, payloadB64, sigB64] = parts;
  if (name !== "cosmos-lic") return { ok: false, reason: "malformed" };
  if (version !== "v1") return { ok: false, reason: "unsupported_version" };

  const payloadBytes = fromB64Url(payloadB64);
  const sig = fromB64Url(sigB64);
  if (!payloadBytes || !sig) return { ok: false, reason: "malformed" };

  const signed = signingInput(payloadB64);
  let verified = false;
  let usable = 0;
  for (const pem of pems) {
    try {
      const key = createPublicKey(pem);
      usable++;
      // `null` algorithm: Ed25519 signs the message directly, no pre-hash.
      if (cryptoVerify(null, signed, key, sig)) {
        verified = true;
        break;
      }
    } catch {
      // One unparseable PEM must not disqualify the others sitting beside it in
      // the bundle: during a rotation a typo in the new key would otherwise take
      // down every licence still signed by the perfectly good old one.
      continue;
    }
  }
  // Nothing threw out of the gate either way — a licence that cannot be verified
  // is simply not a licence.
  if (usable === 0) return { ok: false, reason: "unusable_public_key" };
  if (!verified) return { ok: false, reason: "bad_signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isClaims(parsed)) return { ok: false, reason: "malformed" };

  if (parsed.exp + SKEW_SECONDS < now) return { ok: false, reason: "expired" };
  if (parsed.iat - SKEW_SECONDS > now) return { ok: false, reason: "not_yet_valid" };

  return { ok: true, claims: parsed };
}

/**
 * Does a VERIFIED licence entitle this org to this plugin on this instance?
 *
 * Separate from `verifyEntitlement` because they answer different questions and
 * fail for different reasons: one asks "is this a real licence", the other "does
 * it cover this". Folding them together is how a valid licence for another org
 * ends up entitling this one.
 */
export function entitles(
  claims: EntitlementClaims,
  target: { orgId: string; slug: string; instance?: string | null },
): boolean {
  if (claims.orgId !== ANY && claims.orgId !== target.orgId) return false;
  // An instance-bound licence must match when the deployment declares a slug.
  // When the deployment declares none, an instance-bound licence still applies —
  // refusing there would strand every install that has not set the variable.
  if (claims.instance !== ANY && target.instance && claims.instance !== target.instance) {
    return false;
  }
  return claims.plugins.includes(ANY) || claims.plugins.includes(target.slug);
}

/** Human-readable reason, for an admin screen. Never shown to an end user. */
export const FAILURE_MESSAGE: Record<VerifyFailure, string> = {
  malformed: "This licence is not readable. Check it was pasted in full.",
  unsupported_version: "This licence was issued for a newer version of Cosmos.",
  bad_signature: "This licence failed its signature check and was not issued by us.",
  expired: "This licence has expired.",
  not_yet_valid: "This licence is not valid yet.",
  no_public_key: "This deployment has no licence public key configured.",
  unusable_public_key:
    "This deployment's licence public key could not be read. Check COSMOS_LICENSE_PUBLIC_KEY is a complete PEM.",
};
