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
// counts, and the words in a comment or a string never do.
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
  const found: string[] = [];
  const hit = (node: ts.Node, kind: "call" | "env") => found.push(`${file} ${enclosingFunction(node)} ${kind}`);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const c = node.expression;
      if (ts.isIdentifier(c) && names.has(c.text)) hit(node, "call");
      if (ts.isPropertyAccessExpression(c) && c.name.text === "isInternalAdmin" && ts.isIdentifier(c.expression) && namespaces.has(c.expression.text)) hit(node, "call");
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
});
