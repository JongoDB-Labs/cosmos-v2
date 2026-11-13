// @vitest-environment node
/**
 * A route handler identifies the caller before it validates the request.
 *
 * Validating first answers a caller who can't authenticate with a 400 that
 * describes what a valid request looks like, instead of a 401 (orgContext's
 * doc). The route sweep (every-route-authenticates*.db.test.ts) catches this
 * for a malformed path or body, but not for a malformed query string, which it
 * can't guess for every route. This reads every handler that uses parseRequest
 * and checks it calls an authentication helper first.
 *
 * It reads the TypeScript syntax tree, not the text, so only a real call
 * counts: a comment or a string that names a helper can't satisfy it. A handler
 * is `export function GET`, `export const GET = …` (a function, a wrapper around
 * one, or the name of one), or `export { handler as GET }`.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const API_ROOT = path.resolve(__dirname, "..");
const SRC_ROOT = path.resolve(__dirname, "../../..");
const AUTH_CALLS = new Set(["orgContext", "workflowProjectContext", "getAuthContext", "getCurrentUser", "cqlGate"]);
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const ROUTE_FILE = /^route\.(?:ts|tsx|js|jsx)$/;

function routeFiles(dir = API_ROOT): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) return name === "__tests__" ? [] : routeFiles(abs);
    return ROUTE_FILE.test(name) ? [abs] : [];
  });
}

function parse(source: string, fileName: string): ts.SourceFile {
  const kind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : fileName.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

/** The name a call calls: `f(…)` is f, `a.b.f(…)` is f. */
function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** Position of the first call, in source order, whose name passes `match`; -1 if none. */
function firstCall(node: ts.Node, match: (name: string) => boolean): number {
  let found = -1;
  const visit = (n: ts.Node) => {
    if (found >= 0) return;
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name && match(name)) {
        found = n.getStart();
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

const isExported = (n: ts.Node) =>
  ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const isFunctionLike = (n: ts.Node) => ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n);

/** The file a `@/…` or relative specifier names in this repo, or null for a package. */
function resolveModule(spec: string, fromFile: string): string | null {
  const base = spec.startsWith("@/") ? path.join(SRC_ROOT, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(fromFile), spec) : null;
  if (!base) return null;
  const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx"].flatMap((e) => [base + e, path.join(base, `index${e}`)])];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

type ModuleInfo = { sf: ts.SourceFile; local: Map<string, ts.Node>; imported: Map<string, { spec: string; name: string }> };
const modules = new Map<string, ModuleInfo>();

/** A module's syntax tree, its top-level names, and what it imports by name. Read once per file. */
function moduleOf(file: string, text?: string): ModuleInfo {
  const key = text === undefined ? file : `${file}\0${text}`;
  const cached = modules.get(key);
  if (cached) return cached;
  const sf = parse(text ?? readFileSync(file, "utf8"), file);
  const local = new Map<string, ts.Node>();
  const imported = new Map<string, { spec: string; name: string }>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) local.set(st.name.text, st);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) local.set(d.name.text, d.initializer);
      }
    }
    const bindings = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) imported.set(el.name.text, { spec: st.moduleSpecifier.text, name: (el.propertyName ?? el.name).text });
    }
  }
  const info = { sf, local, imported };
  modules.set(key, info);
  return info;
}

/**
 * The code behind `name` as `file` exports it, or null when it doesn't export
 * that name: an exported function or const, `export { a as name }`, or a
 * re-export (`export * from`, `export { a as name } from`), followed to the
 * module that writes it. A handler bound to a name (`export const GET = h`,
 * `wrap(h)`) is read where `h` is written, imported or not. Throws when it would
 * have to read a module outside the repo, rather than pass a handler unread.
 */
function exportedCode(file: string, name: string, text?: string, seen = new Set<string>()): ts.Node | null {
  if (seen.has(`${file}#${name}`)) return null;
  seen.add(`${file}#${name}`);
  const { sf, local, imported } = moduleOf(file, text);
  const from = (spec: string, n: string): ts.Node | null => {
    const target = resolveModule(spec, file);
    if (!target) throw new Error(`${file} re-exports ${n} from ${spec}, which this check can't read`);
    return exportedCode(target, n, undefined, seen);
  };
  // A name in this module, or one it imports from the repo; null for anything else.
  const byName = (n: string): ts.Node | null => {
    if (local.has(n)) return local.get(n)!;
    const imp = imported.get(n);
    return imp && resolveModule(imp.spec, file) ? from(imp.spec, imp.name) : null;
  };
  const code = (n: ts.Node): ts.Node => {
    if (ts.isIdentifier(n)) return byName(n.text) ?? n;
    if (ts.isCallExpression(n)) {
      for (const a of n.arguments) {
        const target = ts.isIdentifier(a) ? byName(a.text) : null;
        if (target && isFunctionLike(target)) return target;
      }
    }
    return n;
  };
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name && isExported(st)) return st;
    if (ts.isVariableStatement(st) && isExported(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return code(d.initializer);
      }
    }
    if (ts.isExportDeclaration(st)) {
      const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      if (!st.exportClause) {
        const found = spec ? from(spec, name) : null;
        if (found) return found;
      } else if (ts.isNamedExports(st.exportClause)) {
        const el = st.exportClause.elements.find((e) => e.name.text === name);
        if (el) {
          const original = (el.propertyName ?? el.name).text;
          return spec ? from(spec, original) : byName(original);
        }
      }
    }
  }
  return null;
}

/** Each exported handler in a route module, and the syntax that holds its code. */
function handlers(file: string, text?: string): Array<{ method: string; body: ts.Node }> {
  return [...METHODS].flatMap((method) => {
    const body = exportedCode(file, method, text);
    return body ? [{ method, body }] : [];
  });
}

/** `METHOD path` for each handler that calls parseRequest before any authentication helper. */
function parsesBeforeAuthenticating(source: string, rel: string, file = "route.ts"): string[] {
  return handlers(file, source).flatMap(({ method, body }) => {
    const parsed = firstCall(body, (n) => n === "parseRequest");
    if (parsed < 0) return [];
    const auth = firstCall(body, (n) => AUTH_CALLS.has(n));
    return auth >= 0 && auth < parsed ? [] : [`${method} ${rel}`];
  });
}

describe("route handlers authenticate before they validate", () => {
  it("finds the order in a handler (the check's own control)", () => {
    const bad = `export async function GET(r, { params }) {\n  const { params: p } = await parseRequest(c, r, params);\n  const { ctx } = await orgContext(p.orgId, c);\n}`;
    const good = `export async function GET(r, { params }) {\n  const { ctx } = await orgContext((await params).orgId, c);\n  const { params: p } = await parseRequest(c, r, params);\n}`;
    expect(parsesBeforeAuthenticating(bad, "x")).toEqual(["GET x"]);
    expect(parsesBeforeAuthenticating(good, "x")).toEqual([]);
    expect(parsesBeforeAuthenticating(`${good}\n${bad.replace("GET", "POST")}`, "x")).toEqual(["POST x"]);
  });

  it("isn't satisfied by a comment or a string that names a helper", () => {
    const commented = bad("// Authenticated by orgContext(p.orgId) just below.\n");
    const quoted = bad('const why = "orgContext( runs below";\n');
    expect(parsesBeforeAuthenticating(commented, "x")).toEqual(["GET x"]);
    expect(parsesBeforeAuthenticating(quoted, "x")).toEqual(["GET x"]);
    function bad(prefix: string) {
      return `export async function GET(r, { params }) {\n  ${prefix}  const { params: p } = await parseRequest(c, r, params);\n  const { ctx } = await orgContext(p.orgId, c);\n}`;
    }
  });

  it("reads handlers written as `export const`, wrapped, or exported by name", () => {
    const arrow = "export const POST = async (r, { params }) => {\n  await parseRequest(c, r, params);\n  await getAuthContext(s);\n};";
    const wrapped = "export const PATCH = withTiming(async (r, { params }) => {\n  await parseRequest(c, r, params);\n  await getAuthContext(s);\n});";
    const named = "async function handler(r, { params }) {\n  await parseRequest(c, r, params);\n  await getAuthContext(s);\n}\nexport { handler as DELETE };";
    const bound = "const handler = async (r, { params }) => {\n  await parseRequest(c, r, params);\n  await getAuthContext(s);\n};\nexport const PUT = handler;\nexport const HEAD = withTiming(handler);";
    expect(parsesBeforeAuthenticating(arrow, "x")).toEqual(["POST x"]);
    expect(parsesBeforeAuthenticating(wrapped, "x")).toEqual(["PATCH x"]);
    expect(parsesBeforeAuthenticating(named, "x")).toEqual(["DELETE x"]);
    expect(parsesBeforeAuthenticating(bound, "x")).toEqual(["HEAD x", "PUT x"]);
    const fixed = arrow.replace("await parseRequest(c, r, params);\n  await getAuthContext(s);", "await getAuthContext(s);\n  await parseRequest(c, r, params);");
    expect(parsesBeforeAuthenticating(fixed, "x")).toEqual([]);
  });

  it("follows a handler re-exported from another module, as a plugin's route does", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "auth-before-parse-"));
    try {
      const write = (name: string, text: string) => {
        writeFileSync(path.join(dir, name), text);
        return path.join(dir, name);
      };
      write("impl.ts", [
        "async function handler(r, { params }) {\n  await parseRequest(c, r, params);\n  await getAuthContext(s);\n}",
        "export async function POST(r, { params }) {\n  await parseRequest(c, r, params);\n  await getAuthContext(s);\n}",
        "export async function GET(r, { params }) {\n  await getAuthContext(s);\n  await parseRequest(c, r, params);\n}",
        "export { handler };",
      ].join("\n"));
      const star = write("star.ts", 'export * from "./impl";');
      const named = write("named.ts", 'export { POST as PATCH } from "./impl";');
      const imported = write("imported.ts", 'import { handler } from "./impl";\nexport const DELETE = withTiming(handler);');
      const read = (f: string) => parsesBeforeAuthenticating(readFileSync(f, "utf8"), "x", f);
      expect(read(star)).toEqual(["POST x"]);
      expect(read(named)).toEqual(["PATCH x"]);
      expect(read(imported)).toEqual(["DELETE x"]);
      // A module it can't read fails the check, rather than passing its handlers unread.
      const outside = write("outside.ts", 'export * from "some-package";');
      expect(() => read(outside)).toThrow(/some-package/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds for every route under src/app/api", () => {
    const files = routeFiles();
    expect(files.length).toBeGreaterThan(400);
    let read = 0;
    const offenders = files.flatMap((f) => {
      const source = readFileSync(f, "utf8");
      const rel = path.relative(API_ROOT, path.dirname(f)).split(path.sep).join("/");
      read += handlers(f, source).length;
      return parsesBeforeAuthenticating(source, rel, f);
    });
    // It found the handlers, so an empty list of offenders means something.
    expect(read).toBeGreaterThan(700);
    expect(offenders).toEqual([]);
  }, 120_000); // reads every route module and what it re-exports
});
