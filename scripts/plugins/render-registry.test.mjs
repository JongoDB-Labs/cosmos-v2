import { describe, it, expect } from "vitest";
import { renderRegistryIndex, renderRegistryServer } from "./render-registry.mjs";

/**
 * The generated composition files turn a plugin SLUG into a JS IDENTIFIER. A
 * kebab-case slug interpolated raw emits `import { pi-planningManifest } …`,
 * which is a syntax error that fails the entire composed build — and that
 * shipped undetected because every slug in use happened to be a single word.
 *
 * These tests assert the invariant GENERALLY (every emitted identifier is a
 * valid JS identifier, for every slug shape the slug rule permits) rather than
 * spot-checking one slug, so a future slug that breaks it fails here loudly.
 */

/** Slug rule from registry-invariants.test.ts: /^[a-z0-9][a-z0-9-]*$/ */
const SLUGS = ["foreman", "pi-planning", "a-b-c", "v2-sync", "x", "a1-b2-c3"];

const entry = (slug) => ({
  slug,
  importPath: `@/plugins/${slug}/manifest`,
  serverPath: `@/plugins/${slug}/server`,
});

const JS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Every binding the generated module imports, registers, or dereferences. */
function emittedIdentifiers(code) {
  return [
    ...[...code.matchAll(/import\s*\{\s*([^}]+?)\s*\}/g)].map((m) => m[1].trim()),
    ...[...code.matchAll(/\.register\(([^)]+)\)/g)].map((m) => m[1].trim()),
    ...[...code.matchAll(/of\s+([A-Za-z0-9_$-]+)\.integrations/g)].map((m) => m[1].trim()),
  ];
}

describe("generated registry composition", () => {
  it("emits only valid JS identifiers, for every permitted slug shape", () => {
    for (const slug of SLUGS) {
      for (const code of [renderRegistryIndex([entry(slug)]), renderRegistryServer([entry(slug)])]) {
        const ids = emittedIdentifiers(code);
        expect(ids.length, `no identifiers found for "${slug}" — the extractor missed something`).toBeGreaterThan(0);
        for (const id of ids) {
          expect(id, `slug "${slug}" emitted the invalid identifier "${id}"`).toMatch(JS_IDENTIFIER);
        }
      }
    }
  });

  it("never leaks a raw hyphenated slug into an identifier position", () => {
    const code = renderRegistryIndex([entry("pi-planning")]) + renderRegistryServer([entry("pi-planning")]);
    // The slug is legitimate inside the quoted import PATH, so assert on the
    // identifier suffixes specifically.
    expect(code).not.toMatch(/pi-planningManifest/);
    expect(code).not.toMatch(/pi-planningServerHooks/);
    expect(code).toContain("piPlanningManifest");
    expect(code).toContain("piPlanningServerHooks");
  });

  it("keeps the import path as the raw slug (paths are not identifiers)", () => {
    const code = renderRegistryIndex([entry("pi-planning")]);
    expect(code).toContain('from "@/plugins/pi-planning/manifest"');
  });

  it("composes several plugins, registering each exactly once", () => {
    const code = renderRegistryServer([entry("foreman"), entry("pi-planning")]);
    expect(code.match(/PluginServerRegistry\.register\(/g)).toHaveLength(2);
    expect(code).toContain("foremanServerHooks");
    expect(code).toContain("piPlanningServerHooks");
    for (const id of emittedIdentifiers(code)) expect(id).toMatch(JS_IDENTIFIER);
  });

  it("renders nothing registrable when no plugins are composed (neutral core)", () => {
    expect(renderRegistryIndex([])).not.toContain("PluginRegistry.register(");
    expect(renderRegistryServer([])).not.toContain("PluginServerRegistry.register(");
  });
});
