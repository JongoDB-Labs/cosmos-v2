import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Every CQL filter on an item's comments goes through `inReadableComments`.
 *
 * That helper is where the actor's comment scope is applied: COMMENT_READ per
 * project, then public, not deleted, not hidden and within the classification
 * ceiling. A second `comments` filter anywhere in the query layer would match
 * an item through comments without that scope, and nothing else would notice.
 *
 * Parsed with the TypeScript compiler rather than matched by regex, so only a
 * real object key counts: the words in a comment or a string, this file's
 * included, are never keys.
 */

const QUERY_DIR = join(__dirname, "..");
const ROOT = join(__dirname, "../../../..");
const ALLOWED = { file: "src/lib/query/compile.ts", fn: "inReadableComments" };

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") sources(p, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** The text of a property key, when it is a plain name, a quoted name or a computed literal. */
function keyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const e = name.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  }
  return null;
}

/** The name of the nearest enclosing function, or null at top level or in an anonymous one. */
function enclosingFunction(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) return n.name && ts.isIdentifier(n.name) ? n.name.text : null;
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      const p = n.parent;
      return p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) ? p.name.text : null;
    }
  }
  return null;
}

/** Every `comments` key in the source, as "file:line function". */
export function commentKeys(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const key = ts.isPropertyAssignment(node) ? keyName(node.name) : ts.isShorthandPropertyAssignment(node) ? node.name.text : null;
    if (key === "comments") {
      found.push(`${fileName}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${enclosingFunction(node) ?? "(top level)"}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const inAllowedPlace = (hit: string) => hit.startsWith(`${ALLOWED.file}:`) && hit.endsWith(` ${ALLOWED.fn}`);

describe("CQL comment filters all carry the comment scope", () => {
  it("the only `comments` key in the query layer is the one in inReadableComments", () => {
    const hits = sources(QUERY_DIR).flatMap((f) => commentKeys(readFileSync(f, "utf8"), relative(ROOT, f)));
    // The control: the scanner finds the one that is meant to be there.
    expect(hits.filter(inAllowedPlace)).toHaveLength(1);
    expect(hits.filter((h) => !inAllowedPlace(h))).toEqual([]);
  });

  it("finds a bare filter, quoted and shorthand keys, and ignores comments and strings", () => {
    const src = [
      "// comments: { some: {} }",
      "/* comments: { some: {} } */",
      'const s = "comments: { some: {} }";',
      "const t = `comments: { some: {} }`;",
      "function inReadableComments() { return { comments: { some: {} } }; }",
      "function bare() { return { comments: { some: {} } }; }",
      'const quoted = () => ({ "comments": { none: {} } });',
      "function shorthand(comments: unknown) { return { comments }; }",
      'function computed() { return { ["comments"]: { every: {} } }; }',
    ].join("\n");
    expect(commentKeys(src, "x.ts")).toEqual([
      "x.ts:5 inReadableComments",
      "x.ts:6 bare",
      "x.ts:7 quoted",
      "x.ts:8 shorthand",
      "x.ts:9 computed",
    ]);
  });
});
