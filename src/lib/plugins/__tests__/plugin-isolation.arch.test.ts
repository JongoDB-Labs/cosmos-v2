import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { pluginModelPrefix } from "../slug";

/**
 * Plugin isolation guarantees (ADR 0003). Plugin code (src/plugins/**) may import
 * anything from shared code — that is the point, plugins REUSE the platform — but
 * shared code may reach INTO a plugin only through the sanctioned puncture points:
 *
 *   1. src/lib/plugins/registry/index.ts   (client-safe manifest composition)
 *   2. src/lib/plugins/registry/server.ts  (server-hook composition)
 *   3. thin route shims under src/app whose route path contains a
 *      "(plugin-<slug>)" route group (App Router requires routes to live in
 *      src/app; the shims re-export from the plugin and stay tiny)
 *
 * And shared code must never query plugin-owned Prisma models directly.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

const COMPOSITION_FILES = new Set([
  "src/lib/plugins/registry/index.ts",
  "src/lib/plugins/registry/server.ts",
]);

const ROUTE_SHIM_BASENAMES = new Set(["page.tsx", "layout.tsx", "loading.tsx", "route.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const allFiles = walk(SRC).map((p) => relative(ROOT, p));
const sharedFiles = allFiles.filter((p) => !p.startsWith("src/plugins/"));

// The composed plugin slugs (src/plugins/<slug>/). Empty in the neutral public
// core (src/plugins does not exist), so the plugin-specific guards below scope
// themselves to whatever is actually composed — without ever naming a client.
function pluginSlugs(): string[] {
  try {
    return readdirSync(join(SRC, "plugins")).filter((n) => {
      try {
        return statSync(join(SRC, "plugins", n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

const PLUGIN_IMPORT = /from\s+["'](@\/plugins\/|(?:\.\.?\/)+plugins\/)/;
const PLUGIN_IMPORT_BARE = /import\s+["'](@\/plugins\/|(?:\.\.?\/)+plugins\/)/;

function isPluginRouteShim(rel: string): boolean {
  return (
    rel.startsWith("src/app/") &&
    /\(plugin-[a-z0-9-]+\)/.test(rel) &&
    ROUTE_SHIM_BASENAMES.has(basename(rel))
  );
}

describe("plugin isolation (ADR 0003)", () => {
  it("shared code imports src/plugins/** only through the sanctioned puncture points", () => {
    const offenders = sharedFiles.filter((rel) => {
      if (COMPOSITION_FILES.has(rel) || isPluginRouteShim(rel)) return false;
      const text = readFileSync(join(ROOT, rel), "utf8");
      return PLUGIN_IMPORT.test(text) || PLUGIN_IMPORT_BARE.test(text);
    });
    expect(
      offenders,
      `Shared code must not import from src/plugins/** (register through src/lib/plugins/registry/{index,server}.ts or a (plugin-*) route shim):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("plugin route shims stay thin re-exports", () => {
    const shims = sharedFiles.filter(isPluginRouteShim);
    const offenders: string[] = [];
    for (const rel of shims) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      const lines = text.split("\n").filter((l) => l.trim() !== "");
      const codeLines = lines.filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"));
      if (codeLines.length > 20) {
        offenders.push(`${rel} (${codeLines.length} code lines)`);
        continue;
      }
      // A shim may import only from the plugin, react, or next.
      const importSources = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
      const bad = importSources.filter(
        (s) => !s.startsWith("@/plugins/") && s !== "react" && !s.startsWith("next/"),
      );
      if (bad.length > 0) offenders.push(`${rel} (imports: ${bad.join(", ")})`);
    }
    expect(
      offenders,
      `Plugin route shims must be ≤20 code lines and import only from @/plugins/**, react, or next/*:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("shared code never queries plugin-owned Prisma models (prisma.<slug>*)", () => {
    const slugs = pluginSlugs();
    // Neutral core: no composed plugins, so there are no plugin-owned models to
    // guard and the invariant holds vacuously. When a plugin composes in, its
    // <slug>-prefixed models must be queried only inside src/plugins/**.
    // camelCase the slug: Prisma exposes `model PiPlanningCard` as
    // `prisma.piPlanningCard`, so a raw hyphenated slug would never match.
    const patterns = slugs.map((s) => new RegExp(`\\bprisma\\.${pluginModelPrefix(s)}[A-Z]`));
    const offenders = sharedFiles.filter((rel) => {
      if (patterns.length === 0) return false;
      const text = readFileSync(join(ROOT, rel), "utf8");
      return patterns.some((re) => re.test(text));
    });
    expect(
      offenders,
      `Plugin-owned models are queried only inside src/plugins/**:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the plugin framework itself stays plugin/client-neutral", () => {
    const FRAMEWORK = [
      "src/lib/plugins/registry.ts",
      "src/lib/plugins/enablement.ts",
      "src/lib/plugins/default-env.ts",
      "src/components/layouts/nav-plugins.ts",
    ];
    const slugs = pluginSlugs();
    const offenders: string[] = [];
    for (const rel of FRAMEWORK) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      // The framework proper must neither import a plugin nor hardcode a specific
      // plugin's slug — client/vertical specifics live in src/plugins/** or the
      // composition files (registry/{index,server}.ts).
      if (/["'](@\/plugins\/|(?:\.\.?\/)+plugins\/)/.test(text)) {
        offenders.push(`${rel} (imports a plugin)`);
        continue;
      }
      const slugHit = slugs.find((s) => new RegExp(`["']${s}["']`).test(text));
      if (slugHit) offenders.push(`${rel} (hardcodes plugin slug "${slugHit}")`);
    }
    expect(
      offenders,
      `Plugin/client specifics belong in src/plugins/** or the composition files, not the framework:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
