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
//
// A filter the scan cannot read is refused rather than passed: a spread beside
// an insensitive mode (it may hold the operand), a spread beside a visible
// operand with no mode (it may hold the mode), and a mode that is neither a
// literal nor `X.insensitive` / `X.default`. What it still cannot see: a spread
// beside a variable mode with no operand in sight (`{ ...f, mode: m }` is also
// how UI state is written, so refusing it would refuse unrelated code), and a
// filter assembled through variables rather than in one object literal.
import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import ts from "typescript";

type Finding = { file: string; line: number; op: string; text: string };
type Scan = { safe: Finding[]; bare: Finding[]; misplaced: Finding[]; unjudgeable: Finding[] };
/** The comparison a filter object runs: ILIKE, plain `=`, or not knowable from the source. */
type Mode = "insensitive" | "sensitive" | "unknown";

const nameOf = (n: ts.PropertyName): string | null =>
  ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null;

const isEscapeCall = (v: ts.Expression): boolean =>
  ts.isCallExpression(v) && ts.isIdentifier(v.expression) && v.expression.text === "escapeLike";

const unwrap = (v: ts.Expression): ts.Expression =>
  ts.isAsExpression(v) || ts.isParenthesizedExpression(v) || ts.isSatisfiesExpression(v) ? unwrap(v.expression) : v;

/** The operand names whose comparison is a LIKE pattern, so an escaped value belongs there. */
const LIKE_OPS = new Set(["equals", "not", "contains", "startsWith", "endsWith"]);

/** Every `equals`/`not` operand beside an insensitive `mode`, judged; every escapeLike where ILIKE is not what runs; and every filter whose mode or operand is out of sight. */
function scan(file: string, src: string): Scan {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Scan = { safe: [], bare: [], misplaced: [], unjudgeable: [] };
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const prop = (o: ts.ObjectLiteralExpression, name: string) =>
    o.properties.find(
      (p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && nameOf(p.name) === name,
    );
  const spreadOf = (o: ts.ObjectLiteralExpression) => o.properties.find(ts.isSpreadAssignment);

  /** The object's own mode: "insensitive" or `X.insensitive` → insensitive; absent, "default" or `X.default` → sensitive, unless a spread could supply one; anything else → unknown. */
  const modeOf = (o: ts.ObjectLiteralExpression): Mode => {
    const m = prop(o, "mode");
    if (!m) return spreadOf(o) ? "unknown" : "sensitive";
    if (ts.isShorthandPropertyAssignment(m)) return "unknown";
    const v = unwrap(m.initializer);
    const word =
      ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v) ? v.text : ts.isPropertyAccessExpression(v) ? v.name.text : null;
    return word === "insensitive" ? "insensitive" : word === "default" ? "sensitive" : "unknown";
  };

  const inherited = new Set<ts.Node>();
  const judge = (o: ts.ObjectLiteralExpression, mode: Mode) => {
    const spread = spreadOf(o);
    if (spread && mode === "insensitive") {
      out.unjudgeable.push({ file, line: at(spread), op: "...", text: spread.getText(sf) });
    }
    for (const op of ["equals", "not"] as const) {
      const p = prop(o, op);
      if (!p) continue;
      if (ts.isShorthandPropertyAssignment(p)) {
        if (mode !== "sensitive") (mode === "insensitive" ? out.bare : out.unjudgeable).push({ file, line: at(p), op, text: op });
        continue;
      }
      const v = unwrap(p.initializer);
      const f = { file, line: at(p), op, text: v.getText(sf) };
      if (ts.isObjectLiteralExpression(v)) {
        // `not: { equals: … }` inherits the outer mode.
        if (mode !== "sensitive") {
          inherited.add(v);
          judge(v, mode);
        }
        continue;
      }
      const literal = ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v) || v.kind === ts.SyntaxKind.NullKeyword;
      if (mode === "sensitive") {
        if (isEscapeCall(v)) out.misplaced.push(f);
      } else if (mode === "unknown") {
        if (!literal) out.unjudgeable.push(f);
      } else {
        (literal || isEscapeCall(v) ? out.safe : out.bare).push(f);
      }
    }
    // `in` / `notIn` with insensitive mode is LOWER(col) IN (LOWER(v)): exact,
    // so an escaped value there would stop matching its own row.
    for (const op of ["in", "notIn"] as const) {
      const p = prop(o, op);
      if (p && ts.isPropertyAssignment(p) && /\bescapeLike\s*\(/.test(p.initializer.getText(sf))) {
        out.misplaced.push({ file, line: at(p), op, text: p.initializer.getText(sf) });
      }
    }
    // `{ col: v }` is plain `=`, so an escaped value there is compared with its
    // backslashes and stops matching its own row.
    for (const p of o.properties) {
      if (!ts.isPropertyAssignment(p) || !isEscapeCall(unwrap(p.initializer))) continue;
      const name = nameOf(p.name);
      if (name === null || !LIKE_OPS.has(name)) {
        out.misplaced.push({ file, line: at(p), op: name ?? p.name.getText(sf), text: p.initializer.getText(sf) });
      }
    }
  };

  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n) && !inherited.has(n)) judge(n, modeOf(n));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const PREFILTER = /\b(equals|not|in|notIn|escapeLike|insensitive)\b/;
const files = [
  ...globSync("src/**/*.{ts,tsx}"),
  ...globSync("prisma/**/*.ts"),
  ...globSync("scripts/**/*.{ts,mts}"),
].filter((f) => !/\.test\.(tsx?|mts)$/.test(f) && !f.includes("__tests__") && !f.includes("node_modules"));

const results = files.map((f) => {
  const src = readFileSync(f, "utf8");
  return PREFILTER.test(src) ? scan(f, src) : { safe: [], bare: [], misplaced: [], unjudgeable: [] };
});
const all = {
  safe: results.flatMap((r) => r.safe),
  bare: results.flatMap((r) => r.bare),
  misplaced: results.flatMap((r) => r.misplaced),
  unjudgeable: results.flatMap((r) => r.unjudgeable),
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

  it("no filter hides its mode or its operand from the scan", () => {
    expect(all.unjudgeable.map(show)).toEqual([]);
  });

  it("the judge: a bare operand is caught, a hidden mode or operand is refused; an escaped one, a literal, a default mode and comments pass", () => {
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
      // A spread or a variable can hide the mode or the operand: refused.
      "const n1 = { email: { equals: q, ...ci } };",
      "const n2 = { email: { equals: escapeLike(q), ...ci } };",
      'const n3 = { email: { ...eq, mode: "insensitive" } };',
      'const n4 = { email: { not: { ...eq }, mode: "insensitive" } };',
      "const n5 = { email: { equals: escapeLike(q), mode: m } };",
      // An escaped value where the comparison is plain `=`.
      "const n6 = { email: escapeLike(q) };",
      "const n7 = { [col]: escapeLike(q) };",
      // Controls: none of these is refused.
      "const c1 = { email: { ...base, not: null } };",
      'const c2 = { email: { contains: escapeLike(q), mode: "insensitive" } };',
      "const c3 = { ...group, mode: m };",
      "const c4 = { email: { equals: escapeLike(q), mode: Prisma.QueryMode.insensitive } };",
    ].join("\n"));
    expect(judged.bare.map((f) => [f.line, f.text])).toEqual([
      [1, "q"],
      [5, "k"],
      [7, "n"],
      [8, "n"],
      [15, "equals"],
    ]);
    expect(judged.safe.map((f) => f.line)).toEqual([2, 9, 10, 26]);
    expect(judged.misplaced.map((f) => f.line)).toEqual([13, 14, 21, 22]);
    expect(judged.unjudgeable.map((f) => f.line)).toEqual([6, 16, 17, 18, 19, 20]);
  });
});
