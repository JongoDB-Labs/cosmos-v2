// scripts/cutover/lib/exposability.ts
//
// THE EXPOSABILITY-MAP SNAPSHOT + GOV SIGN-OFF GATE (cutover finisher §9 step 9).
//
// The field-level default-deny exposability map is "a security control authored by a
// script" — the floor on what a CUI-blind commercial model is allowed to SEE for each
// tool result. Before a GOV tenant's cutover flip, a human must REVIEW the exact map and
// SIGN OFF on it (with a passing leak-test), so the gate's behavior is auditable and
// approved rather than silently shipped. This module:
//
//   1. ASSEMBLES the COMPLETE effective exposability map from the LIVE code — the SAME
//      merged maps the egress gate actually enforces (projection.ts's EXPOSABLE_FIELDS /
//      HANDLEABLE_FIELDS / TOOL_ENTITY, which already merge the connector registry's
//      `connectorEgressMaps()` contributions) — never a re-hardcoded copy that could
//      drift. {@link getExposabilityMap}.
//   2. Produces a CANONICAL, STABLE serialization (sorted keys + sorted arrays) and a
//      sha256 {@link exposabilityHash} over it. Same map ⇒ same hash; any field change ⇒
//      a different hash. The hash is what a sign-off is BOUND to.
//   3. {@link requireExposabilitySignoff} — the GOV-flip gate: a GOV tenant requires a
//      sign-off record whose `mapHash === exposabilityHash()` (the CURRENT map) AND
//      `leakTestPassed === true`; missing / stale-hash / leak-failed ⇒ FAIL (fail-closed).
//      A COMMERCIAL tenant needs no sign-off (pass).
//
// Imported by exposability-snapshot.mjs + orchestrate.mjs (run under tsx). PURE w.r.t.
// the map assembly + hashing (no I/O); the sign-off reader takes an injectable loader so
// it is unit-testable without the filesystem.

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPOSABLE_FIELDS,
  HANDLEABLE_FIELDS,
  TOOL_ENTITY,
} from "../../../src/lib/ai/egress/projection";
import { getConnectorDescriptors } from "../../../src/lib/ai/connectors";
import type { TenantClass } from "../../../src/lib/ai/egress/types";

/** A connector tool's tenant availability, mirrored from its descriptor (D5 axis). */
export type Availability = "all" | "commercial-only";

/** One entity type's effective exposure (what the model may READ / REFERENCE for it). */
export interface EntityExposure {
  /** The structural entity type (e.g. "work_item", "github_issue"). */
  entityType: string;
  /** Allowlisted structural scalar fields the model may READ (sorted). Everything else is WITHHELD. */
  exposableFields: string[];
  /** Allowlisted CUI string fields surfaced ONLY as an opaque handle the model may REFERENCE (sorted). */
  handleableFields: string[];
  /** The tool names whose result maps to this entity type (sorted). */
  tools: string[];
  /**
   * Tenant availability of this entity's exposure: "commercial-only" if EVERY tool that
   * maps to it belongs to a commercial-only connector (a gov tenant never reaches it);
   * "all" otherwise (native or an "all"-availability connector). NATIVE entities are
   * always "all".
   */
  availability: Availability;
}

/** A tool family that maps to NO entity type ⇒ full withhold (default-deny) for gov. */
export interface WithheldToolFamily {
  /** The connector provider (or "native") whose tools these are. */
  provider: string;
  /** This provider's tenant availability. */
  availability: Availability;
  /** The tool names with no TOOL_ENTITY mapping ⇒ full withhold (sorted). */
  tools: string[];
}

/**
 * The COMPLETE effective exposability map — assembled from the LIVE merged maps the
 * egress gate enforces. This is the artifact a security reviewer reads + signs off.
 */
export interface ExposabilityMap {
  /** Schema/format version of this snapshot (bump if the SHAPE changes — invalidates hashes). */
  version: 1;
  /** Per-entity exposure, sorted by entityType. */
  entities: EntityExposure[];
  /**
   * Tool families that map to NO entity type ⇒ FULL WITHHOLD (default-deny). Captured
   * from the connector registry so a reviewer sees explicitly which tool surfaces expose
   * nothing structural to the model (Google/Nango today). Sorted by provider.
   */
  withheldToolFamilies: WithheldToolFamily[];
}

/** Stable, deduped, lexicographically sorted copy of a string list. */
function sortedUnique(xs: readonly string[]): string[] {
  return Array.from(new Set(xs)).sort();
}

/**
 * Reverse-index TOOL_ENTITY: entityType → its tool names. The merged TOOL_ENTITY is the
 * SAME map the loop uses (native ∪ connector-registry contributions).
 */
function toolsByEntity(): Map<string, string[]> {
  const byEntity = new Map<string, string[]>();
  for (const [tool, entity] of Object.entries(TOOL_ENTITY)) {
    const list = byEntity.get(entity) ?? [];
    list.push(tool);
    byEntity.set(entity, list);
  }
  return byEntity;
}

/**
 * tool name → owning connector's availability, from the LIVE descriptor list. A tool not
 * owned by any connector is NATIVE ⇒ "all". This binds the snapshot's availability flag
 * to the same descriptor `availability` the registry's gov-block enforces (D5).
 */
function toolAvailability(): Map<string, Availability> {
  const map = new Map<string, Availability>();
  for (const d of getConnectorDescriptors()) {
    const avail: Availability = d.availability === "commercial-only" ? "commercial-only" : "all";
    for (const t of d.toolDefs) map.set(t.name, avail);
  }
  return map;
}

/**
 * Assemble the COMPLETE effective exposability map from the LIVE merged egress maps.
 * Deterministic: entities + every inner array are sorted, so the SAME effective map
 * always yields the SAME object (and therefore the same canonical JSON + hash).
 */
export function getExposabilityMap(): ExposabilityMap {
  const byEntity = toolsByEntity();
  const availOf = toolAvailability();

  const entities: EntityExposure[] = Object.keys(EXPOSABLE_FIELDS)
    .sort()
    .map((entityType) => {
      const tools = sortedUnique(byEntity.get(entityType) ?? []);
      // An entity is gov-reachable unless EVERY tool that maps to it is commercial-only.
      // (With no mapping tool the field allowlist is unreachable from any tool, but it is
      // still a NATIVE-style "all" entry by construction — treat as "all".)
      const allCommercialOnly =
        tools.length > 0 && tools.every((t) => availOf.get(t) === "commercial-only");
      return {
        entityType,
        exposableFields: sortedUnique(EXPOSABLE_FIELDS[entityType] ?? []),
        handleableFields: sortedUnique(HANDLEABLE_FIELDS[entityType] ?? []),
        tools,
        availability: allCommercialOnly ? "commercial-only" : "all",
      };
    });

  // Tool families that map to NO entity type ⇒ full withhold (default-deny). Derived from
  // the connector descriptors so the snapshot explicitly records every tool surface that
  // exposes NOTHING structural to the model (Google/Nango: empty egress).
  const withheldByProvider = new Map<string, { availability: Availability; tools: string[] }>();
  for (const d of getConnectorDescriptors()) {
    const avail: Availability = d.availability === "commercial-only" ? "commercial-only" : "all";
    const withheld = d.toolDefs
      .map((t) => t.name)
      .filter((name) => TOOL_ENTITY[name] === undefined);
    if (withheld.length === 0) continue;
    const entry = withheldByProvider.get(d.provider) ?? { availability: avail, tools: [] };
    entry.tools.push(...withheld);
    withheldByProvider.set(d.provider, entry);
  }
  const withheldToolFamilies: WithheldToolFamily[] = Array.from(withheldByProvider.entries())
    .map(([provider, { availability, tools }]) => ({
      provider,
      availability,
      tools: sortedUnique(tools),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));

  return { version: 1, entities, withheldToolFamilies };
}

/**
 * Canonical, STABLE JSON serialization of the exposability map. Recursively sorts object
 * keys so the byte output depends ONLY on the map's content, never on insertion order.
 * (Arrays are already content-sorted by getExposabilityMap; their ORDER is significant
 * and preserved.) This is the exact string the hash is taken over.
 */
export function canonicalize(map: ExposabilityMap): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sortKeys((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(map));
}

/**
 * sha256 (hex) over the canonical serialization of the CURRENT effective exposability
 * map. Same map ⇒ same hash; any field/availability/tool change ⇒ a different hash. A
 * gov sign-off is bound to this value, so a map change invalidates the sign-off (stale).
 */
export function exposabilityHash(map: ExposabilityMap = getExposabilityMap()): string {
  return createHash("sha256").update(canonicalize(map)).digest("hex");
}

// ── Sign-off record + GOV-flip gate ───────────────────────────────────────────────────

/**
 * A per-gov-tenant exposability sign-off record. Lives at
 * `compliance/exposability/signoff/<orgSlug>.json`. A reviewer produces it AFTER reading
 * the snapshot markdown for the CURRENT map hash and confirming the leak tests pass.
 */
export interface ExposabilitySignoff {
  /** The org slug this sign-off authorizes (matches the file name). */
  orgSlug: string;
  /** The exposability map hash the reviewer signed off on (must equal the CURRENT hash). */
  mapHash: string;
  /** Who reviewed + signed (name / id — auditable). */
  reviewer: string;
  /** ISO-8601 timestamp of the sign-off. */
  signedAt: string;
  /**
   * The golden-egress + projection-contract leak tests passed at sign-off time (they prove
   * no CUI/free-text field is ever exposed). Required true — the gate fails on false.
   */
  leakTestPassed: boolean;
}

/** Result of the gov-flip exposability gate. `ok:false` carries a clear, audit-safe reason. */
export interface SignoffGateResult {
  ok: boolean;
  /** The CURRENT effective map hash the gate evaluated against. */
  currentHash: string;
  /** Human-readable reason (always set; on pass it states why it passed). */
  reason: string;
}

/** Validate that a parsed value is a well-formed ExposabilitySignoff (defensive). */
function isSignoff(v: unknown): v is ExposabilitySignoff {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.orgSlug === "string" &&
    typeof r.mapHash === "string" &&
    typeof r.reviewer === "string" &&
    typeof r.signedAt === "string" &&
    typeof r.leakTestPassed === "boolean"
  );
}

/**
 * THE GOV-FLIP EXPOSABILITY GATE — fail-closed.
 *
 *   - COMMERCIAL tenant ⇒ PASS, no sign-off required (the exposability map is the gov
 *     default-deny floor; commercial flows under the gate's commercial branch as before).
 *   - GOV tenant ⇒ require a sign-off record for `orgSlug` whose `mapHash` equals the
 *     CURRENT {@link exposabilityHash} AND whose `leakTestPassed === true`. ANY of:
 *       • no sign-off file              ⇒ FAIL (must be reviewed + signed first)
 *       • mapHash ≠ current hash (stale) ⇒ FAIL (map changed since sign-off — re-review)
 *       • leakTestPassed !== true        ⇒ FAIL (leak test must be green at sign-off)
 *     ⇒ a clear, audit-safe reason (NEVER any CUI — only slugs, hashes, booleans).
 *
 * `loadSignoff` is injected so this is unit-testable without the filesystem; the .mjs
 * caller passes a reader that loads `compliance/exposability/signoff/<orgSlug>.json`.
 */
export function requireExposabilitySignoff(
  orgSlug: string,
  tenantClass: TenantClass,
  loadSignoff: (orgSlug: string) => unknown | null,
  currentHash: string = exposabilityHash(),
): SignoffGateResult {
  if (tenantClass === "commercial") {
    return {
      ok: true,
      currentHash,
      reason: `commercial tenant "${orgSlug}" — no exposability sign-off required (gate not applicable)`,
    };
  }

  // GOV — fail-closed.
  let raw: unknown | null;
  try {
    raw = loadSignoff(orgSlug);
  } catch (e) {
    return {
      ok: false,
      currentHash,
      reason: `gov tenant "${orgSlug}" — failed to read the exposability sign-off: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  if (raw === null || raw === undefined) {
    return {
      ok: false,
      currentHash,
      reason: `gov tenant "${orgSlug}" — NO exposability sign-off found (expected compliance/exposability/signoff/${orgSlug}.json). Snapshot → security review → leak-test → sign-off required before a gov flip.`,
    };
  }

  if (!isSignoff(raw)) {
    return {
      ok: false,
      currentHash,
      reason: `gov tenant "${orgSlug}" — exposability sign-off is malformed (need {orgSlug, mapHash, reviewer, signedAt, leakTestPassed}).`,
    };
  }

  if (raw.orgSlug !== orgSlug) {
    return {
      ok: false,
      currentHash,
      reason: `gov tenant "${orgSlug}" — sign-off orgSlug "${raw.orgSlug}" does not match (wrong file for this tenant).`,
    };
  }

  if (raw.leakTestPassed !== true) {
    return {
      ok: false,
      currentHash,
      reason: `gov tenant "${orgSlug}" — sign-off has leakTestPassed=${raw.leakTestPassed} (the golden-egress/projection leak tests must be green at sign-off).`,
    };
  }

  if (raw.mapHash !== currentHash) {
    return {
      ok: false,
      currentHash,
      reason: `gov tenant "${orgSlug}" — STALE sign-off: signed for map hash ${raw.mapHash.slice(0, 12)}… but the CURRENT map hash is ${currentHash.slice(0, 12)}…. The exposability map changed since sign-off — re-snapshot, re-review, and re-sign.`,
    };
  }

  return {
    ok: true,
    currentHash,
    reason: `gov tenant "${orgSlug}" — exposability sign-off valid: hash matches (${currentHash.slice(0, 12)}…), leak test passed, reviewer "${raw.reviewer}" @ ${raw.signedAt}.`,
  };
}

// ── On-disk sign-off store ─────────────────────────────────────────────────────────────

/** The repo-relative directory the per-gov-tenant sign-off files live in. */
export const SIGNOFF_DIR = "compliance/exposability/signoff";

/** Absolute path to this repo's sign-off directory (resolved from this module's location). */
function signoffDirAbs(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // scripts/cutover/lib
  return path.resolve(here, "../../..", SIGNOFF_DIR);
}

/** Absolute path to a given org's sign-off file. Slug is validated to a path-safe token. */
export function signoffPath(orgSlug: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(orgSlug)) {
    throw new Error(`refusing to resolve a sign-off path for an unsafe slug "${orgSlug}".`);
  }
  return path.join(signoffDirAbs(), `${orgSlug}.json`);
}

/**
 * Default disk loader for {@link requireExposabilitySignoff}: read + JSON-parse
 * `compliance/exposability/signoff/<orgSlug>.json`, or `null` when it does not exist.
 * A present-but-unreadable/unparseable file THROWS (the gate turns that into a
 * fail-closed reason). The orchestrator passes this as the loader for a gov flip.
 */
export function loadSignoffFromDisk(orgSlug: string): unknown | null {
  const p = signoffPath(orgSlug);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}
