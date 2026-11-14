// @vitest-environment node
//
// Prisma's contains / startsWith / endsWith do NOT escape LIKE's wildcards, so
// an operand built from typed text must go through escapeLike (or likeText,
// for CQL's `~`): otherwise a search for "%" matches every row and "_" any
// character. That was fixed one site at a time (CQL's `~` first, then ⌘K and
// ten more), so this scan makes it a decision for every new one. An operand is
// a string literal, an escapeLike/likeText call, or listed in BUILT_INSIDE
// with where its value comes from.
//
// Parsed with the TypeScript compiler, so a word in a comment or a string is
// never an operand. Scope: those three operators and their JSON `string_*`
// forms, nothing else.
import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import ts from "typescript";

const OPS = new Set(["contains", "startsWith", "endsWith", "string_contains", "string_starts_with", "string_ends_with"]);
const ESCAPERS = new Set(["escapeLike", "likeText"]);

/** Operands that are not typed text, by file: how many times each appears, and why it is safe. */
const BUILT_INSIDE: Array<{ file: string; operand: string; count: number; why: string }> = [
  { file: "src/lib/query/compile.ts", operand: "value", count: 5, why: "likeText(q), a line above each" },
  { file: "src/lib/query/compile.ts", operand: "t", count: 2, why: "a mention token, mapped through likeText" },
  { file: "src/lib/feedback/comments.server.ts", operand: "`#c-${id}`", count: 1, why: "a comment id from the database" },
  { file: "src/lib/feedback/remediate.ts", operand: "`.${name}`", count: 1, why: "a type name from a fixed list" },
  { file: "src/lib/feedback/remediate.ts", operand: "`${sector}.`", count: 1, why: "the project template's sector" },
  { file: "src/lib/custom-fields/seed-sector-fields.ts", operand: "`${sector}.`", count: 1, why: "a key of SECTOR_FIELD_TEMPLATES" },
  { file: "src/lib/integrations/microsoft/calendar-sync.server.ts", operand: "INVITE_PREFIX", count: 1, why: "a constant" },
  { file: "src/lib/files/convert.ts", operand: "base", count: 1, why: "roadmapSlug(title), which keeps only [a-z0-9-]" },
  { file: "src/lib/invoicing/service.ts", operand: "prefix", count: 1, why: "INV-<year>-" },
];

type Operand = { file: string; line: number; op: string; text: string; safe: boolean };

const nameOf = (n: ts.PropertyName): string | null =>
  ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null;

/** Every string-filter operand in `src`, and whether it is a literal or an escaper's call. */
function operandsIn(file: string, src: string): Operand[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Operand[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n)) {
      const op = nameOf(n.name);
      if (op && OPS.has(op)) {
        const v = n.initializer;
        const safe =
          ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)
          || (ts.isCallExpression(v) && ts.isIdentifier(v.expression) && ESCAPERS.has(v.expression.text));
        out.push({ file, line: at(n), op, text: v.getText(sf), safe });
      }
    } else if (ts.isShorthandPropertyAssignment(n) && OPS.has(n.name.text)) {
      out.push({ file, line: at(n), op: n.name.text, text: n.name.text, safe: false });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const PREFILTER = /\b(contains|startsWith|endsWith|string_contains|string_starts_with|string_ends_with)\b/;
const files = globSync("src/**/*.{ts,tsx}").filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes("__tests__"));
const all = files.flatMap((f) => {
  const src = readFileSync(f, "utf8");
  return PREFILTER.test(src) ? operandsIn(f, src) : [];
});
const listed = (o: Operand) => BUILT_INSIDE.some((b) => b.file === o.file && b.operand === o.text);

describe("a contains/startsWith/endsWith operand built at run time is escaped", () => {
  it("the scan reads real operands: escaped ones, and the ones listed", () => {
    expect(all.filter((o) => /^(escapeLike|likeText)\(/.test(o.text)).length).toBeGreaterThanOrEqual(15);
    expect(all.filter(listed).length).toBe(BUILT_INSIDE.reduce((n, b) => n + b.count, 0));
  });

  it("every other operand goes through escapeLike or likeText", () => {
    const bare = all.filter((o) => !o.safe && !listed(o)).map((o) => `${o.file}:${o.line} ${o.op}: ${o.text}`);
    expect(bare).toEqual([]);
  });

  it("every BUILT_INSIDE entry still appears as often as it says", () => {
    const drift = BUILT_INSIDE.filter((b) => all.filter((o) => o.file === b.file && o.text === b.operand).length !== b.count)
      .map((b) => `${b.file} ${b.operand}`);
    expect(drift).toEqual([]);
  });

  it("the judge: a bare operand is caught, an escaped one or a literal is not, and comments and strings are no operands", () => {
    const judged = operandsIn("x.ts", [
      'const a = { name: { contains: q, mode: "insensitive" } };',
      "const b = { name: { startsWith: escapeLike(q) } };",
      "const c = { key: { endsWith: `.${t}` } };",
      'const d = { key: { endsWith: ".task" } };',
      "const e = { contains };",
      "// { contains: q }",
      'const f = "{ contains: q }";',
    ].join("\n"));
    expect(judged.map((o) => [o.line, o.text, o.safe])).toEqual([
      [1, "q", false],
      [2, "escapeLike(q)", true],
      [3, "`.${t}`", false],
      [4, '".task"', true],
      [5, "contains", false],
    ]);
  });
});
