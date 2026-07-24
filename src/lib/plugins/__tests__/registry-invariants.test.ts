import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PluginRegistry, PluginServerRegistry, PLUGIN_API_VERSION } from "../registry";
import "@/lib/plugins/registry/server"; // registers manifests + server hooks
import { ALL_MODULE_KEYS, FIXED_MODULES, SECTORS } from "@/lib/entitlements/modules";
import { SIDEBAR_NAV } from "@/components/layouts/nav-config";

/** Minimal semver ≥ check (major.minor.patch, numeric). */
function semverGte(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return true;
}

describe("plugin registry invariants", () => {
  const manifests = PluginRegistry.getAll();

  it("registry is wired and loads (neutral core may register zero plugins)", () => {
    // The PUBLIC core ships with an empty registry (fail-closed). The composed
    // per-client build asserts that its plugins actually registered; here we
    // only guarantee the framework loads and the registry is enumerable.
    expect(Array.isArray(manifests)).toBe(true);
  });

  it("slugs are unique, lowercase, url-safe", () => {
    const slugs = manifests.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it("apiVersion matches the framework", () => {
    for (const m of manifests) expect(m.apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it("module keys and nav ids/hrefs are disjoint from the core IA", () => {
    const coreIds = new Set<string>([
      ...ALL_MODULE_KEYS,
      ...FIXED_MODULES,
      ...SIDEBAR_NAV.map((e) => e.id),
    ]);
    const coreHrefs = new Set(
      SIDEBAR_NAV.flatMap((e) => (e.type === "group" ? e.children.map((c) => c.href) : [e.href])),
    );
    for (const m of manifests) {
      for (const mod of m.modules) {
        expect(mod.nav.id, `${m.slug}: module nav id must equal module key`).toBe(mod.key);
        expect(coreIds.has(mod.key), `${m.slug}: module key "${mod.key}" collides with core`).toBe(false);
        const hrefs =
          mod.nav.type === "group" ? mod.nav.children.map((c) => c.href) : [mod.nav.href];
        for (const href of hrefs) {
          expect(coreHrefs.has(href), `${m.slug}: href "${href}" collides with core nav`).toBe(false);
        }
      }
    }
  });

  it("declared sectors exist in the sector vocabulary", () => {
    for (const m of manifests) {
      for (const s of m.sectors ?? []) {
        expect(SECTORS as readonly string[], `${m.slug}: unknown sector "${s}"`).toContain(s);
      }
    }
  });

  it("minCosmosVersion (when declared) is satisfied by package.json", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    for (const m of manifests) {
      if (!m.minCosmosVersion) continue;
      expect(
        semverGte(pkg.version, m.minCosmosVersion),
        `${m.slug}: minCosmosVersion ${m.minCosmosVersion} > package.json ${pkg.version}`,
      ).toBe(true);
    }
  });

  it("every manifest's server hooks (when present) use the same slug", () => {
    for (const h of PluginServerRegistry.getAll()) {
      expect(PluginRegistry.get(h.slug), `server hooks for unknown plugin "${h.slug}"`).toBeDefined();
    }
  });
});
