// @vitest-environment node
//
// On PostgreSQL, Prisma compiles `{ equals: v, mode: "insensitive" }` to
// `col ILIKE v` (and `not` to `NOT ILIKE`) and passes `v` through as-is, so the
// comparison follows LIKE's pattern rules rather than comparing text. Each
// operand goes through escapeLike, and then ILIKE compares the exact text,
// ignoring case only. (`in` with insensitive mode compiles to
// `LOWER(col) IN (LOWER(v))`, which is exact already and must NOT be escaped.)
//
// Parsed with the TypeScript compiler, so a word in a comment or a string is
// never an operand. Scope: `equals` and `not` beside a `mode` that is not
// "default". contains / startsWith / endsWith are a separate rule.
import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import ts from "typescript";

type Finding = { file: string; line: number; op: string; text: string };
type Scan = { safe: Finding[]; bare: Finding[]; misplaced: Finding[] };

const nameOf = (n: ts.PropertyName): string | null =>
  ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null;

const isEscapeCall = (v: ts.Expression): boolean =>
  ts.isCallExpression(v) && ts.isIdentifier(v.expression) && v.expression.text === "escapeLike";

const unwrap = (v: ts.Expression): ts.Expression =>
  ts.isAsExpression(v) || ts.isParenthesizedExpression(v) || ts.isSatisfiesExpression(v) ? unwrap(v.expression) : v;

/** Every `equals`/`not` operand beside an insensitive `mode`, judged; and every escapeLike where ILIKE is not what runs. */
function scan(file: string, src: string): Scan {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Scan = { safe: [], bare: [], misplaced: [] };
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const prop = (o: ts.ObjectLiteralExpression, name: string) =>
    o.properties.find(
      (p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && nameOf(p.name) === name,
    );

  /** `mode` absent → false; the literal "default" → false; anything else (a literal, an enum member, a variable) → true. */
  const insensitive = (o: ts.ObjectLiteralExpression): boolean => {
    const m = prop(o, "mode");
    if (!m) return false;
    if (ts.isShorthandPropertyAssignment(m)) return true;
    const v = unwrap(m.initializer);
    return !(ts.isStringLiteral(v) && v.text === "default");
  };

  const inherited = new Set<ts.Node>();
  const judge = (o: ts.ObjectLiteralExpression, ci: boolean) => {
    for (const op of ["equals", "not"] as const) {
      const p = prop(o, op);
      if (!p) continue;
      if (ts.isShorthandPropertyAssignment(p)) {
        if (ci) out.bare.push({ file, line: at(p), op, text: op });
        continue;
      }
      const v = unwrap(p.initializer);
      const f = { file, line: at(p), op, text: v.getText(sf) };
      if (ts.isObjectLiteralExpression(v)) {
        // `not: { equals: … }` inherits the outer mode.
        if (ci) {
          inherited.add(v);
          judge(v, true);
        }
        continue;
      }
      if (!ci) {
        if (isEscapeCall(v)) out.misplaced.push(f);
        continue;
      }
      const safe =
        ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v) || v.kind === ts.SyntaxKind.NullKeyword || isEscapeCall(v);
      (safe ? out.safe : out.bare).push(f);
    }
    // `in` / `notIn` with insensitive mode is LOWER(col) IN (LOWER(v)): exact,
    // so an escaped value there would stop matching its own row.
    for (const op of ["in", "notIn"] as const) {
      const p = prop(o, op);
      if (p && ts.isPropertyAssignment(p) && /\bescapeLike\s*\(/.test(p.initializer.getText(sf))) {
        out.misplaced.push({ file, line: at(p), op, text: p.initializer.getText(sf) });
      }
    }
  };

  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n) && !inherited.has(n)) judge(n, insensitive(n));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const PREFILTER = /\b(equals|not|in|notIn)\b/;
const files = [
  ...globSync("src/**/*.{ts,tsx}"),
  ...globSync("prisma/**/*.ts"),
  ...globSync("scripts/**/*.{ts,mts}"),
].filter((f) => !/\.test\.(tsx?|mts)$/.test(f) && !f.includes("__tests__") && !f.includes("node_modules"));

const results = files.map((f) => {
  const src = readFileSync(f, "utf8");
  return PREFILTER.test(src) ? scan(f, src) : { safe: [], bare: [], misplaced: [] };
});
const all = {
  safe: results.flatMap((r) => r.safe),
  bare: results.flatMap((r) => r.bare),
  misplaced: results.flatMap((r) => r.misplaced),
};
const show = (f: Finding) => `${f.file}:${f.line} ${f.op}: ${f.text}`;

describe("an insensitive equals compares the exact text", () => {
  it("the scan reads real operands", () => {
    // Positive control: if the walk or the mode test broke, this count would
    // fall to zero and the next test would pass over nothing.
    expect(all.safe.filter((f) => /^escapeLike\(/.test(f.text)).length).toBeGreaterThanOrEqual(60);
    expect(all.safe.some((f) => f.file.endsWith("src/app/api/auth/password/login/route.ts"))).toBe(true);
  });

  it("every equals/not operand beside an insensitive mode goes through escapeLike (or is a literal)", () => {
    expect(all.bare.map(show)).toEqual([]);
  });

  it("escapeLike is only used where the comparison is ILIKE", () => {
    expect(all.misplaced.map(show)).toEqual([]);
  });

  it("the judge: a bare operand is caught; an escaped one, a literal, a default mode and comments are not", () => {
    const judged = scan("x.ts", [
      'const a = { email: { equals: q, mode: "insensitive" } };',
      'const b = { email: { equals: escapeLike(q), mode: "insensitive" as const } };',
      'const c = { email: { equals: q, mode: "default" } };',
      "const d = { email: { equals: q } };",
      "const e = { key: { equals: k, mode: Prisma.QueryMode.insensitive } };",
      "const f = { key: { equals: k, mode } };",
      'const g = { name: { not: n, mode: "insensitive" } };',
      'const h = { name: { not: { equals: n }, mode: "insensitive" } };',
      'const h2 = { name: { not: { equals: escapeLike(n) }, mode: "insensitive" } };',
      'const i = { name: { equals: "Fixed", mode: "insensitive" } };',
      "// { equals: q, mode: \"insensitive\" }",
      "const j = '{ equals: q, mode: \"insensitive\" }';",
      "const k = { email: { equals: escapeLike(q) } };",
      'const l = { email: { in: [escapeLike(q)], mode: "insensitive" } };',
      'const m = { email: { equals, mode: "insensitive" } };',
    ].join("\n"));
    expect(judged.bare.map((f) => [f.line, f.text])).toEqual([
      [1, "q"],
      [5, "k"],
      [6, "k"],
      [7, "n"],
      [8, "n"],
      [15, "equals"],
    ]);
    expect(judged.safe.map((f) => f.line)).toEqual([2, 9, 10]);
    expect(judged.misplaced.map((f) => f.line)).toEqual([13, 14]);
  });
});
