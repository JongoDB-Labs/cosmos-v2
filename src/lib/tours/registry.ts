import type { PluginManifest } from "@/lib/plugins/registry";
import type { Tour } from "./types";

/**
 * Tours that ship with CORE — walks through features core itself added.
 *
 * Empty today, and that is not an oversight: the releases with something worth
 * walking through so far have been plugin features, and core cannot name a
 * plugin's routes. A core tour goes here; a plugin's goes in its own manifest
 * (PluginManifest.tours), beside the feature it describes.
 */
export const CORE_TOURS: Tour[] = [];

/**
 * Every tour on offer for a version: core's, plus those of plugins the org has
 * ENABLED.
 *
 * Pure, so the enablement set is the caller's to supply and this stays
 * unit-testable — the same shape as slotContributions, and deliberately so:
 * one notion of "enabled" across every surface that reads it.
 *
 * A disabled plugin's tour is withheld rather than shown-and-broken. Its pages
 * are unreachable for that org, so every step would navigate into a wall.
 */
export function toursForVersion(
  version: string,
  manifests: readonly PluginManifest[],
  enabled: ReadonlySet<string>,
): Tour[] {
  const fromPlugins = manifests
    .filter((p) => enabled.has(p.slug))
    .flatMap((p) => p.tours ?? []);
  return [...CORE_TOURS, ...fromPlugins].filter((t) => t.version === version);
}
