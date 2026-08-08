import { readFileSync } from "node:fs";
import {
  verifyEntitlement,
  entitles,
  type EntitlementClaims,
  type VerifyResult,
} from "./entitlement";

/**
 * Where this deployment's licence comes from, and what it currently entitles.
 *
 * The IMPURE half of ADR 0004 Tier 1 — environment, filesystem and caching —
 * kept apart from `entitlement.ts` so the decision itself stays testable without
 * any of it.
 *
 * ## Fail-closed, but strictly additive
 *
 * A plugin is only ever checked here when its manifest says
 * `requiresEntitlement: true`. Every plugin that does not declare it behaves
 * exactly as it did before this file existed. That is deliberate: switching on
 * licence enforcement for plugins already running in the field, in a release
 * that was supposed to add a mechanism, would be an outage dressed up as a
 * feature. Marking a plugin paid is then a single, visible, reviewable edit.
 *
 * ## Configuration
 *
 *   COSMOS_LICENSE_PUBLIC_KEY  PEM Ed25519 public key(s). The vendor's. Public by
 *                              definition, so it is safe in an image layer.
 *                              Concatenate two PEMs during a key rotation; any
 *                              one of them may verify. Remove the old one to
 *                              finish the rotation — a key left in the bundle is
 *                              a key still trusted.
 *   COSMOS_LICENSE             the licence token itself, or
 *   COSMOS_LICENSE_FILE        a path to read it from (better: it can be a
 *                              mounted secret, and it survives a token longer
 *                              than an env var comfortably holds).
 *   COSMOS_INSTANCE            optional deployment slug, for instance-bound
 *                              licences.
 *
 * No network access on any path. See `entitlement.ts` for why.
 */

/** Re-read at most this often. A licence changes when an operator changes it. */
const CACHE_TTL_MS = 60_000;

type Snapshot = {
  at: number;
  result: VerifyResult;
  /** Present only when the token verified — the thing gates actually consult. */
  claims: EntitlementClaims | null;
};

let cache: Snapshot | null = null;

function readToken(): string | null {
  const inline = process.env.COSMOS_LICENSE?.trim();
  if (inline) return inline;

  const path = process.env.COSMOS_LICENSE_FILE?.trim();
  if (!path) return null;
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    // An unreadable path is the same as no licence: refused, not crashed. The
    // admin screen reports it; a request that happened to be first must not 500.
    return null;
  }
}

/** One PEM block. Deliberately non-greedy so a bundle yields several. */
const PEM_BLOCK = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g;

/**
 * The public keys this deployment will accept, newest-first by convention.
 *
 * `COSMOS_LICENSE_PUBLIC_KEY` holds ONE key normally and TWO during a rotation,
 * concatenated exactly as a CA bundle is — no separator, no JSON, no second
 * variable. An operator who has ever appended to a `fullchain.pem` already knows
 * the format, and a scheme nobody has to learn is a scheme nobody gets wrong.
 */
function publicKeys(): string[] {
  const raw = process.env.COSMOS_LICENSE_PUBLIC_KEY?.trim();
  if (!raw) return [];
  // Env vars routinely carry PEMs with their newlines escaped; unescape BEFORE
  // splitting, or the bundle is one long line and the block regex finds nothing.
  const pem = raw.replace(/\\n/g, "\n");
  // Fall back to the whole value: an unrecognised shape is better handed to the
  // key parser, which will say so, than silently dropped here.
  return pem.match(PEM_BLOCK) ?? [pem];
}

/**
 * The current licence state, cached briefly.
 *
 * Exported so the Settings screen can show WHY a licence was refused — an admin
 * staring at a disabled plugin needs "expired" or "issued for another org", not
 * silence.
 */
export function licenseStatus(now: number = Date.now()): Snapshot {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache;

  const result = verifyEntitlement(readToken(), publicKeys(), Math.floor(now / 1000));
  cache = { at: now, result, claims: result.ok ? result.claims : null };
  return cache;
}

/** Drop the cache. For tests, and for the moment an admin installs a licence. */
export function resetLicenseCache(): void {
  cache = null;
}

/**
 * Is this org licensed for this plugin on this deployment?
 *
 * Answers only the LICENCE question. Whether the org has switched the plugin on
 * is `OrgPluginState`'s job, and both must pass — a licence is permission to
 * enable, never enablement itself.
 */
export function isPluginEntitled(orgId: string, slug: string, now: number = Date.now()): boolean {
  const { claims } = licenseStatus(now);
  if (!claims) return false;
  return entitles(claims, {
    orgId,
    slug,
    instance: process.env.COSMOS_INSTANCE?.trim() || null,
  });
}
