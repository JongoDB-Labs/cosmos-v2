// @vitest-environment node
//
// System admin is decided by `isSystemAdmin(user)`, which looks at who vouched
// for the account and how the current session signed in. `isInternalAdmin(email)`
// is only the INTERNAL_ADMINS list lookup: an access decision made from it alone
// grants system admin to any account carrying a listed address, including one an
// organization's IdP created. Reading INTERNAL_ADMINS and parsing it by hand is
// the same lookup without the name.
//
// So every call to isInternalAdmin (however it was imported or renamed) and every
// read of INTERNAL_ADMINS is listed here BY FILE AND FUNCTION, with the reason it
// is not a grant, and the list must stay accurate (a stale entry fails).
//
// Parsed with the TypeScript compiler, not matched by regex: an alias still
// counts, and the words in a comment or a string never do. The module may be
// imported statically or at run time (`await import(…)`, `import(…).then(…)`),
// and the function may be destructured or read off the namespace first.
// Limit: the function passed as a value (`emails.some(isInternalAdmin)`) is not
// a call, so it is not seen.
import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import ts from "typescript";

const MODULE = /(^|\/)(lib\/internal\/)?access$/;

/** "file function kind" → why it is allowed. kind: call (isInternalAdmin) | env (INTERNAL_ADMINS). */
const ALLOWED: Record<string, string> = {
  "src/lib/internal/access.ts isSystemAdmin call": "the decision itself, after sessionVouchesForAddress",
  "src/lib/internal/access.ts isSystemAdmin env": "default argument of the decision",
  "src/lib/auth/sso.ts completeSsoLogin call":
    "refuses: an IdP may not link to or create an account under a listed address (it never grants)",
  "src/lib/auth/sso.ts completeSsoLogin env": "the list for that refusal",
  "src/lib/auth/first-party-identity.ts resolveFirstPartyUser call":
    "refuses: Microsoft never links to or creates a listed address by email (it never grants)",
  "src/lib/auth/first-party-identity.ts resolveFirstPartyUser env": "the list for that refusal",
};

/** The name of the nearest enclosing named function, or "(top level)". */
function enclosingFunction(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name)) return n.name.text;
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      const p = n.parent;
      if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    }
  }
  return "(top level)";
}

const isProcessEnv = (e: ts.Expression) =>
  ts.isPropertyAccessExpression(e) && e.name.text === "env" && ts.isIdentifier(e.expression) && e.expression.text === "process";

/** `e` without the parentheses and the `await` around it. */
function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
  return e;
}

/** `import("…/access")`, awaited or not: the module's namespace, loaded at run time. */
const importsAccess = (e: ts.Expression) => {
  const x = unwrap(e);
  return ts.isCallExpression(x) && x.expression.kind === ts.SyntaxKind.ImportKeyword
    && x.arguments.length > 0 && ts.isStringLiteralLike(x.arguments[0]) && MODULE.test(x.arguments[0].text);
};

/** The name a member is read by: `.isInternalAdmin` and `["isInternalAdmin"]` both give "isInternalAdmin". */
function memberName(e: ts.Expression): { object: ts.Expression; name: string } | null {
  if (ts.isPropertyAccessExpression(e)) return { object: e.expression, name: e.name.text };
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return { object: e.expression, name: e.argumentExpression.text };
  return null;
}

/** Every call to isInternalAdmin and every read of INTERNAL_ADMINS, as "file function kind". */
export function adminLookups(source: string, file: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  // Local names bound to isInternalAdmin, and namespaces bound to its module.
  const names = new Set<string>(["isInternalAdmin"]);
  const namespaces = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !MODULE.test(st.moduleSpecifier.text)) continue;
    const bindings = st.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) if ((el.propertyName ?? el.name).text === "isInternalAdmin") names.add(el.name.text);
    }
  }
  // An expression that IS the module's namespace: `await import("…/access")`, or a name bound to one.
  const isNamespace = (e: ts.Expression) => {
    const x = unwrap(e);
    return importsAccess(x) || (ts.isIdentifier(x) && namespaces.has(x.text));
  };
  // A binding given the namespace: `const m = …` binds it whole; `const { isInternalAdmin: f } = …`
  // binds the function. Returns whether it bound anything new.
  const addTo = (set: Set<string>, name: string) => !set.has(name) && (set.add(name), true);
  const bind = (name: ts.BindingName): boolean => {
    if (ts.isIdentifier(name)) return addTo(namespaces, name.text);
    let added = false;
    if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        const key = el.propertyName ?? el.name;
        const isFn = (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === "isInternalAdmin";
        if (isFn && ts.isIdentifier(el.name)) added = addTo(names, el.name.text) || added;
      }
    }
    return added;
  };
  // A dynamic import binds names anywhere in the file, and a name bound to the
  // namespace can be destructured or read again, so collect to a fixed point:
  //   const m = await import("…/access")              (and `const m2 = m`)
  //   const { isInternalAdmin: f } = await import(…)  (or `= m`)
  //   const f = m.isInternalAdmin                       (m from either kind of import)
  //   import("…/access").then((m) => …) / .then(({ isInternalAdmin: f }) => …)
  for (let changed = true; changed; ) {
    changed = false;
    const collect = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const member = memberName(unwrap(node.initializer));
        if (isNamespace(node.initializer)) changed = bind(node.name) || changed;
        else if (member?.name === "isInternalAdmin" && isNamespace(member.object) && ts.isIdentifier(node.name)) {
          changed = addTo(names, node.name.text) || changed;
        }
      }
      if (ts.isCallExpression(node)) {
        const then = memberName(node.expression);
        const callback = node.arguments[0];
        if (then?.name === "then" && importsAccess(then.object) && callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && callback.parameters[0]) {
          changed = bind(callback.parameters[0].name) || changed;
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(sf);
  }
  const found: string[] = [];
  const hit = (node: ts.Node, kind: "call" | "env") => found.push(`${file} ${enclosingFunction(node)} ${kind}`);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const c = node.expression;
      const member = memberName(c);
      if (ts.isIdentifier(c) && names.has(c.text)) hit(node, "call");
      // access.isInternalAdmin(…), m["isInternalAdmin"](…), (await import("…/access")).isInternalAdmin(…)
      if (member && member.name === "isInternalAdmin" && isNamespace(member.object)) hit(node, "call");
    }
    // process.env.INTERNAL_ADMINS, process.env["INTERNAL_ADMINS"]
    if (ts.isPropertyAccessExpression(node) && node.name.text === "INTERNAL_ADMINS" && isProcessEnv(node.expression)) hit(node, "env");
    if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "INTERNAL_ADMINS") hit(node, "env");
    // const { INTERNAL_ADMINS } = process.env
    if (ts.isVariableDeclaration(node) && node.initializer && isProcessEnv(node.initializer) && ts.isObjectBindingPattern(node.name)) {
      for (const el of node.name.elements) {
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(key) && key.text === "INTERNAL_ADMINS") hit(node, "env");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function sourceFiles(): string[] {
  return globSync("src/**/*.{ts,tsx,mts}").filter(
    (f) => !/\.(test|spec)\.(ts|tsx|mts)$/.test(f) && !f.includes("/__tests__/") && !f.endsWith(".d.ts"),
  );
}

describe("system admin is decided by isSystemAdmin, not by an email lookup", () => {
  const files = sourceFiles();
  const hits = files.flatMap((f) => adminLookups(readFileSync(f, "utf8"), f));

  it("scans a real surface (not vacuous)", () => {
    expect(files.length).toBeGreaterThan(1000);
    // Positive control: the scan sees the decision in the module that makes it.
    expect(hits).toContain("src/lib/internal/access.ts isSystemAdmin call");
  });

  it("only the listed functions look up INTERNAL_ADMINS", () => {
    expect([...new Set(hits)].filter((h) => !(h in ALLOWED)).sort()).toEqual([]);
  });

  it("every listed function still does (no stale exemption)", () => {
    const seen = new Set(hits);
    expect(Object.keys(ALLOWED).filter((k) => !seen.has(k))).toEqual([]);
  });

  it("finds an aliased import, a namespace call and hand-parsing of the list, and ignores comments and strings", () => {
    const aliased = [
      'import { isInternalAdmin as isOps } from "@/lib/internal/access";',
      "export function gate(email: string) { return isOps(email, undefined); }",
    ].join("\n");
    const namespaced = [
      'import * as access from "../internal/access";',
      "export const gate = (email: string) => access.isInternalAdmin(email, undefined);",
    ].join("\n");
    const parsed = [
      'export function byHand(email: string) { return (process.env.INTERNAL_ADMINS ?? "").split(",").includes(email); }',
      'export function bracket() { return process.env["INTERNAL_ADMINS"]; }',
      "export function destructured() { const { INTERNAL_ADMINS: list } = process.env; return list; }",
    ].join("\n");
    const mentions = [
      "// isInternalAdmin(email, process.env.INTERNAL_ADMINS)",
      "/* process.env.INTERNAL_ADMINS */",
      'export const doc = "isInternalAdmin(x) reads process.env.INTERNAL_ADMINS";',
      "export const t = `process.env.INTERNAL_ADMINS`;",
      "export function other(isInternalAdminFlag: boolean) { return isInternalAdminFlag; }",
    ].join("\n");
    expect(adminLookups(aliased, "a.ts")).toEqual(["a.ts gate call"]);
    expect(adminLookups(namespaced, "b.ts")).toEqual(["b.ts gate call"]);
    expect(adminLookups(parsed, "c.ts")).toEqual(["c.ts byHand env", "c.ts bracket env", "c.ts destructured env"]);
    expect(adminLookups(mentions, "d.ts")).toEqual([]);
  });

  it("follows a dynamic import: awaited, destructured, renamed, through .then, and from a namespace it bound", () => {
    const shapes = {
      namespace: 'export async function gate(e: string) { const access = await import("@/lib/internal/access"); return access.isInternalAdmin(e, undefined); }',
      renamed: 'export async function gate(e: string) { const { isInternalAdmin: isOps } = await import("@/lib/internal/access"); return isOps(e, undefined); }',
      inline: 'export async function gate(e: string) { return (await import("../internal/access")).isInternalAdmin(e, undefined); }',
      bracket: 'export async function gate(e: string) { const m = await import("@/lib/internal/access"); return m["isInternalAdmin"](e, undefined); }',
      thenNamespace: 'export function gate(e: string) { return import("@/lib/internal/access").then((m) => m.isInternalAdmin(e, undefined)); }',
      thenRenamed: 'export function gate(e: string) { return import("@/lib/internal/access").then(({ isInternalAdmin: f }) => f(e, undefined)); }',
      fromNamespace: 'export async function gate(e: string) { const m = await import("@/lib/internal/access"); const { isInternalAdmin: f } = m; return f(e, undefined); }',
      propertyAlias: 'export async function gate(e: string) { const m = await import("@/lib/internal/access"); const f = m.isInternalAdmin; return f(e, undefined); }',
      staticPropertyAlias: 'import * as access from "@/lib/internal/access";\nexport function gate(e: string) { const f = access.isInternalAdmin; return f(e, undefined); }',
      // A function above the module-level import it reads (why the collection runs to a fixed point).
      hoisted: 'export function gate(e: string) { const { isInternalAdmin: f } = access; return f(e, undefined); }\nconst access = await import("@/lib/internal/access");',
    };
    for (const [name, code] of Object.entries(shapes)) expect(adminLookups(code, "e.ts"), name).toEqual(["e.ts gate call"]);

    // Another module's import is not the access module, and an unrelated m.isInternalAdmin is not a call to it.
    const other = [
      'export async function a(e: string) { const m = await import("@/lib/other/access-log"); return m.isInternalAdmin(e); }',
      'export async function b(e: string) { const { isInternalAdmin: f } = await import("./flags"); return f(e); }',
      "export function c(m: { isInternalAdmin: (e: string) => boolean }, e: string) { return m.isInternalAdmin(e); }",
    ].join("\n");
    expect(adminLookups(other, "f.ts")).toEqual([]);
  });
});
