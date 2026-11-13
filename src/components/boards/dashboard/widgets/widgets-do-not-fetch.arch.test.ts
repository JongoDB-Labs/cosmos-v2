// A dashboard widget draws the board's widget bag and fetches nothing itself.
//
// That is the whole access-control argument for widgets: the dashboard loads
// its project's items, sprints and members through the gated routes ONCE, and
// every widget reads what those routes returned to this viewer, narrowed by the
// board's filter bar. A widget that fetched for itself would answer to its own
// gate — or to none — and would escape the filter bar too.
//
// So this is a fact about every file in this directory, not about one widget:
// no fetch, no query hook, no database, and no import from outside a short list
// of modules that are pure. A widget added later is covered without anyone
// remembering to extend a list.
//
// Parsed with the TypeScript compiler, not matched by regex, so every way of
// loading a module counts the same: either quote style, a relative path that
// climbs out of this directory, `export … from`, `require()` and a dynamic
// `import()`. Words in a comment or a string are never calls.
//
// ONE EXEMPTION, by name: the Quick Action widget renders the shared
// `NewWorkItemButton`, whose dialog reads the projects list and posts the new
// item through the same gated routes every board's "New work item" uses. It
// fetches nothing to DRAW; it is a button for the user to act through.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const SRC = resolve("src");
const DIR = resolve("src", "components", "boards", "dashboard", "widgets");

/** Imports a widget file may make: rendering, formatting and the widget bag. */
const ALLOWED_IMPORTS = new Set([
  "react",
  "next/link",
  "lucide-react",
  "@/lib/utils",
  "@/lib/format/stable-date",
  "@/lib/boards/widget-registry",
  "@/lib/boards/widget-data",
  "@/lib/boards/widget-definitions",
  "@/components/charts/lazy-recharts",
  // Backticks, not quotes: `src/types/exports-are-reachable.arch.test.ts`
  // counts every QUOTED mention of this module as an import statement, and an
  // allowlist entry is not one.
  `@/types/models`,
  // The shared "is this item settled" rules, for the strikethroughs
  // (`resolved-strikethrough.arch.test.ts`). Pure, no fetching.
  "@/lib/work-items/done-state",
  // Query KEYS and the client, for invalidating the board's own items after
  // the Quick Action creates one. Not a fetch (the hooks are refused below).
  "@/lib/query/keys",
  "@tanstack/react-query",
]);

const EXEMPT: Record<string, string[]> = {
  "content-widgets.tsx": ["@/components/boards/shared/new-work-item-button"],
};

/** Names a widget may not call or construct: fetching, query hooks, the database, sockets. */
const FORBIDDEN_NAME = /^(fetch|jsonFetch|prisma|EventSource|WebSocket|use(Suspense)?(Infinite)?Quer(y|ies)|use(Org)?Mutation)$/;

function parse(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * The module a specifier names, in the form the allowlist uses: a package name,
 * an `@/…` path, or "./…" for a file inside this directory. A relative path
 * that climbs out is rewritten to its `@/…` form, so `../../../../lib/db/client`
 * is judged as `@/lib/db/client` and not waved through as "relative".
 */
function moduleName(spec: string, dir: string): string {
  if (!spec.startsWith(".")) return spec;
  const abs = resolve(dir, spec);
  if (abs === dir || abs.startsWith(dir + sep)) return `./${relative(dir, abs)}`;
  if (abs.startsWith(SRC + sep)) return `@/${relative(SRC, abs).split(sep).join("/")}`;
  return `(outside src) ${abs}`;
}

/** Every module a source file loads, however it loads it. A computed `import()` is reported as such. */
export function loadedModules(source: string, fileName: string, dir = DIR): string[] {
  const sf = parse(source, fileName);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) out.push(moduleName(node.moduleSpecifier.text, dir));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const e = node.moduleReference.expression;
      out.push(ts.isStringLiteral(e) ? moduleName(e.text, dir) : "(computed require)");
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isImport || isRequire) {
        const [arg] = node.arguments;
        out.push(
          arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
            ? moduleName(arg.text, dir)
            : `(computed ${isImport ? "import()" : "require()"})`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Every forbidden name the file calls, constructs or mentions as code. */
export function forbiddenNames(source: string, fileName: string): string[] {
  const sf = parse(source, fileName);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && FORBIDDEN_NAME.test(node.text)) {
      out.push(`${node.text} at line ${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The modules a widget file may not load: anything outside this directory and the allowlist. */
export function outsideImports(source: string, fileName: string, dir = DIR): string[] {
  const base = fileName.split(/[\\/]/).pop()!;
  return loadedModules(source, fileName, dir)
    .filter((m) => !m.startsWith("./"))
    .filter((m) => !ALLOWED_IMPORTS.has(m))
    .filter((m) => !(EXEMPT[base] ?? []).includes(m));
}

const files = readdirSync(DIR)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f))
  .map((f) => ({ name: f, src: readFileSync(join(DIR, f), "utf8") }));

describe("dashboard widgets draw the bag and fetch nothing", () => {
  it("scans the widget files (positive control)", () => {
    const names = files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["board-widgets.tsx", "list-widgets.tsx", "time-widgets.tsx"]));
    // The scanner sees the imports that ARE there.
    expect(loadedModules(files.find((f) => f.name === "list-widgets.tsx")!.src, "list-widgets.tsx")).toEqual(
      expect.arrayContaining(["@/lib/boards/widget-data", "./widget-parts"]),
    );
  });

  it("catches every way of loading a module that is not allowed (planted fixtures)", () => {
    const planted = [
      ["single quotes", `import { prisma as db } from '@/lib/db/client';`, "@/lib/db/client"],
      ["a relative path out of this directory", `import { x } from "../../../../lib/db/client";`, "@/lib/db/client"],
      ["a relative path to a sibling directory", `import { y } from "../dashboard-derive";`, "@/components/boards/dashboard/dashboard-derive"],
      ["a dynamic import", `export async function f() { return import("@/lib/api-client"); }`, "@/lib/api-client"],
      ["a computed dynamic import", `const m = "x"; export const g = () => import(m);`, "(computed import())"],
      ["a re-export", `export { z } from '@/lib/query/fetchers';`, "@/lib/query/fetchers"],
      ["require", `const c = require("@/lib/db/client");`, "@/lib/db/client"],
    ] as const;
    for (const [why, src, expected] of planted) {
      expect(outsideImports(src, join(DIR, "planted.tsx")), why).toEqual([expected]);
    }
    // Positive control: what the widgets really do import passes.
    expect(
      outsideImports(
        `import { cn } from '@/lib/utils';\nimport { Caption } from "./widget-parts";\nimport type { WidgetItemRow } from "@/lib/boards/widget-data";`,
        join(DIR, "planted.tsx"),
      ),
    ).toEqual([]);
  });

  it("catches fetches and hooks as code, not as words (planted fixtures)", () => {
    expect(forbiddenNames(`export const a = () => fetch("/x");`, "p.ts")).toEqual(["fetch at line 1"]);
    expect(forbiddenNames(`export const b = () => useQuery({ queryKey: [] });`, "p.ts")).toEqual(["useQuery at line 1"]);
    expect(forbiddenNames(`export const c = new WebSocket("wss://x");`, "p.ts")).toEqual(["WebSocket at line 1"]);
    // A comment or a string naming them is not a call.
    expect(forbiddenNames(`// we never fetch here\nexport const d = "useQuery and fetch";`, "p.ts")).toEqual([]);
  });

  it("calls no fetch, query hook or database", () => {
    const hits = files.flatMap((f) => forbiddenNames(f.src, f.name).map((h) => `${f.name}: ${h}`));
    expect(hits).toEqual([]);
  });

  it("imports only pure modules, plus the one named exemption", () => {
    const outside = files.flatMap((f) =>
      outsideImports(f.src, join(DIR, f.name)).map((spec) => `${f.name} imports ${spec}`),
    );
    expect(outside).toEqual([]);
  });
});
