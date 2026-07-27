/**
 * A plugin slug is kebab-case (`registry-invariants.test.ts` enforces
 * /^[a-z0-9][a-z0-9-]*$/), but its Prisma models are PascalCase-prefixed and the
 * generated client exposes them camelCased — `model PiPlanningCard` is reached
 * through the client accessor `piPlanningCard`.
 *
 * Anything that matches plugin-owned model accessors BY SLUG must go through
 * this. Building `prisma.${slug}` directly yields `prisma.pi-planning`, which can
 * never match a real accessor, so the match silently never fires — which is how
 * the isolation guard came to pass vacuously for hyphenated slugs.
 */
export function pluginModelPrefix(slug: string): string {
  return slug.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}
