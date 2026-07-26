/**
 * A plugin slug is kebab-case (`registry-invariants.test.ts` enforces
 * /^[a-z0-9][a-z0-9-]*$/), but it gets used in two places that require a valid
 * JS identifier / camelCase name:
 *
 *   - the generated registry composition files, which import
 *     `<camelSlug>Manifest` and `<camelSlug>ServerHooks`;
 *   - the Prisma client accessor, where `model PiPlanningCard` is exposed as
 *     `prisma.piPlanningCard`.
 *
 * Interpolating a raw hyphenated slug produces `pi-planningManifest`, which is a
 * syntax error, and `prisma.pi-planning`, which silently matches nothing.
 *
 * MIRROR: src/lib/plugins/slug.ts (`pluginModelPrefix`) is the TypeScript twin,
 * used by the arch tests, which live under src/ and cannot import this .mjs.
 * slug.test.mjs imports BOTH and asserts they agree, so the two cannot drift.
 */
export function camelSlug(slug) {
  return slug.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}
