import type { ProductProfile } from "@/lib/product/profiles";
import type { EntitlementsRow } from "./index";
import { ALL_MODULE_KEYS, SECTORS } from "./modules";

/**
 * Parse a comma-separated allowlist env against a fixed vocabulary.
 *   - `undefined`            → `undefined` (caller falls back to the profile).
 *   - `""` / whitespace-only → `[]` (an explicit "restrict everything" allowlist).
 *   - otherwise             → trimmed, lowercased, de-duped tokens that are in
 *                             `vocab`; unknown tokens are dropped (a warning is
 *                             the caller's job so it can name the env var).
 * Pure.
 */
export function parseEnabledCsv(
  raw: string | undefined,
  vocab: readonly string[],
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (raw.trim() === "") return [];
  const set = new Set(vocab);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const tok = part.trim().toLowerCase();
    if (tok === "" || seen.has(tok) || !set.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/** The raw env inputs (so the resolver is pure + injectable in tests). */
export type EntitlementEnv = {
  modulesEnv: string | undefined; // DEFAULT_ENABLED_MODULES
  sectorsEnv: string | undefined; // DEFAULT_ENABLED_SECTORS
};

/**
 * Resolve the create-input for a new org's default entitlements, with the env
 * CSVs overriding the profile defaults per axis.
 *   - For each axis: an env-provided list (incl. empty `[]`) becomes an explicit
 *     allowlist; an UNSET env inherits the profile's `defaultEnabled*` (`null` =
 *     all-on, a list = allowlist).
 *   - Returns `null` ONLY when BOTH axes resolve to "restrict nothing" (all-on),
 *     so the caller can leave the org row-free (= all enabled) exactly as today.
 * Pure (no DB). Invalid env tokens are dropped with a `console.warn`.
 */
export function resolveDefaultEntitlements(
  env: EntitlementEnv,
  profile: ProductProfile,
): EntitlementsRow | null {
  const mods = resolveAxis(
    env.modulesEnv,
    ALL_MODULE_KEYS,
    profile.defaultEnabledModules,
    "DEFAULT_ENABLED_MODULES",
  );
  const secs = resolveAxis(
    env.sectorsEnv,
    SECTORS,
    profile.defaultEnabledSectors,
    "DEFAULT_ENABLED_SECTORS",
  );
  if (mods === null && secs === null) return null;
  return {
    moduleAllowlistEnabled: mods !== null,
    enabledModules: mods ?? [],
    sectorAllowlistEnabled: secs !== null,
    enabledSectors: secs ?? [],
  };
}

/**
 * Resolve one axis to `null` (all-on) or an allowlist array.
 * env list (incl. `[]`) wins; unset → profile default (`null` or list).
 */
function resolveAxis(
  raw: string | undefined,
  vocab: readonly string[],
  profileDefault: readonly string[] | null,
  envName: string,
): string[] | null {
  const parsed = parseEnabledCsv(raw, vocab);
  if (parsed === undefined) {
    return profileDefault === null ? null : [...profileDefault];
  }
  // Warn if any provided token was dropped as invalid.
  if (raw !== undefined && raw.trim() !== "") {
    const provided = raw
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const dropped = provided.filter((t) => !parsed.includes(t));
    if (dropped.length > 0) {
      console.warn(
        `[entitlements] ${envName}: ignored unknown token(s): ${[...new Set(dropped)].join(", ")}`,
      );
    }
  }
  return parsed;
}
