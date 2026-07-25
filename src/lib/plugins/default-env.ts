import type { ProductProfile } from "@/lib/product/profiles";
import { parseEnabledCsv } from "@/lib/entitlements/default-env";

/**
 * Resolve which plugins a NEW org should be provisioned with:
 * DEFAULT_ENABLED_PLUGINS env CSV (validated against the registered slugs)
 * overrides the product profile's defaultEnabledPlugins. Pure + injectable.
 *
 * Unlike entitlements there is no "null = all" state — plugins are fail-closed,
 * so the resolution is always a concrete (possibly empty) list of slugs.
 */
export function resolveDefaultPlugins(
  rawEnv: string | undefined,
  profile: Pick<ProductProfile, "defaultEnabledPlugins">,
  registeredSlugs: readonly string[],
): string[] {
  const parsed = parseEnabledCsv(rawEnv, registeredSlugs);
  if (parsed === undefined) {
    return profile.defaultEnabledPlugins.filter((s) => registeredSlugs.includes(s));
  }
  if (rawEnv !== undefined && rawEnv.trim() !== "") {
    const provided = rawEnv
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const dropped = provided.filter((t) => !parsed.includes(t));
    if (dropped.length > 0) {
      console.warn(
        `[plugins] DEFAULT_ENABLED_PLUGINS: ignored unknown token(s): ${[...new Set(dropped)].join(", ")}`,
      );
    }
  }
  return parsed;
}
