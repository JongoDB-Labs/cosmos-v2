import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";

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

  it("shared code never queries plugin-owned Prisma models (prisma.pontis*)", () => {
    const offenders = sharedFiles.filter((rel) => {
      const text = readFileSync(join(ROOT, rel), "utf8");
      return /\bprisma\.pontis[A-Z]/.test(text);
    });
    expect(
      offenders,
      `Plugin-owned models are queried only inside src/plugins/**:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the plugin framework itself stays brand/client-neutral", () => {
    const FRAMEWORK = [
      "src/lib/plugins/registry.ts",
      "src/lib/plugins/enablement.ts",
      "src/lib/plugins/default-env.ts",
      "src/components/layouts/nav-plugins.ts",
    ];
    const offenders: string[] = [];
    for (const rel of FRAMEWORK) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      // "Pontis"/ESO may appear in the two composition files' import lines only —
      // the framework proper must not know any client's name.
      if (/ĒSO|ESO\b|Pontis/i.test(text)) offenders.push(rel);
    }
    expect(
      offenders,
      `Client names belong in src/plugins/** or the composition files, not the framework:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
