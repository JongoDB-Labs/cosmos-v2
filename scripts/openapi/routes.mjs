// scripts/openapi/routes.mjs
//
// Which v1 operations exist, and which have no contract yet.
//
// An operation is "METHOD /path" in OpenAPI form (`GET /orgs/{orgId}/projects`),
// read from the HTTP-method exports of every src/app/api/v1/**/route.ts.
// openapi/internal-routes.txt lists the ones without a contract. It's a
// RATCHET: src/lib/openapi/coverage.arch.test.ts fails if the list is stale, and
// CI fails if it grew. So a new v1 route ships with a route.contract.ts
// (`stability: "internal"` is enough to stay out of the public spec), and the
// list only ever shrinks as routes are documented.
//
//   node scripts/openapi/routes.mjs --write   regenerate the list (allowed to shrink only)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = "src/app/api/v1";
export const INTERNAL_ROUTES_FILE = "openapi/internal-routes.txt";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function walk(dir, name) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, name) : e.name === name ? [p] : [];
  });
}

/** `src/app/api/v1/orgs/[orgId]/x/route.ts` → `/orgs/{orgId}/x`. */
export function routePath(file) {
  const rel = path.relative(ROOT, path.dirname(file)).split(path.sep).filter(Boolean);
  const segs = rel
    .filter((s) => !/^\(.*\)$/.test(s)) // route groups don't appear in the URL
    .map((s) => s.replace(/^\[\[?(?:\.\.\.)?([^\]]+)\]?\]$/, "{$1}"));
  return "/" + segs.join("/");
}

/** HTTP methods a route module exports, including `export { PATCH as PUT }`. */
export function exportedMethods(source) {
  const found = new Set();
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+([A-Z]+)\b/gm)) {
    if (METHODS.includes(m[1])) found.add(m[1]);
  }
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}\s*;?\s*$/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && METHODS.includes(name)) found.add(name);
    }
  }
  return [...found];
}

export function routeFiles() {
  return walk(ROOT, "route.ts").map((f) => f.split(path.sep).join("/")).sort();
}

export function contractFiles() {
  return walk(ROOT, "route.contract.ts").map((f) => f.split(path.sep).join("/")).sort();
}

/** Every operation, as `{ key: "GET /orgs/{orgId}/projects", file }`. */
export function scanOperations() {
  return routeFiles().flatMap((file) =>
    exportedMethods(readFileSync(file, "utf8")).map((m) => ({ key: `${m} ${routePath(file)}`, file })),
  );
}

export const operationKey = (method, p) => `${method.toUpperCase()} ${p}`;

export function readInternalRoutes() {
  return readFileSync(INTERNAL_ROUTES_FILE, "utf8").split("\n").map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export function formatInternalRoutes(keys) {
  return [
    "# v1 operations with no route.contract.ts yet. Generated; only ever SHRINKS.",
    "# Converting one? Delete its line. Adding a route? Give it a contract instead.",
    "# See scripts/openapi/routes.mjs.",
    ...[...keys].sort(),
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--write")) {
  // Contract keys come from the contract FILES (method + path literals), so this
  // runs in plain node without loading TypeScript.
  const covered = new Set(
    contractFiles().flatMap((f) => {
      const src = readFileSync(f, "utf8");
      return [...src.matchAll(/method:\s*"(\w+)",\s*\n\s*path:\s*"([^"]+)"/g)].map((m) => operationKey(m[1], m[2]));
    }),
  );
  const uncovered = scanOperations().map((o) => o.key).filter((k) => !covered.has(k));
  writeFileSync(INTERNAL_ROUTES_FILE, formatInternalRoutes(uncovered));
  console.log(`routes: ${uncovered.length} operation(s) without a contract -> ${INTERNAL_ROUTES_FILE}`);
}
