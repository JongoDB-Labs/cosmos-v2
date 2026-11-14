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
// forms, written as a key (plain, quoted or `["contains"]`) or assigned
// (`where.contains = v`). A key computed from a variable can't be read here.
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

const literalText = (n: ts.Node): string | null =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;

/** `contains`, `"contains"` and `["contains"]` as a key; a key computed from a variable is unknown. */
const nameOf = (n: ts.PropertyName): string | null =>
  ts.isIdentifier(n) ? n.text : ts.isComputedPropertyName(n) ? literalText(n.expression) : literalText(n);

/** The operator an assignment writes: `w.contains = v` or `w["contains"] = v`. */
const assignedOp = (n: ts.Expression): string | null =>
  ts.isPropertyAccessExpression(n) ? n.name.text : ts.isElementAccessExpression(n) ? literalText(n.argumentExpression) : null;

/** Every string-filter operand in `src`, and whether it is a literal or an escaper's call. */
function operandsIn(file: string, src: string): Operand[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Operand[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const judge = (n: ts.Node, op: string, v: ts.Expression) => {
    const safe =
      literalText(v) !== null
      || (ts.isCallExpression(v) && ts.isIdentifier(v.expression) && ESCAPERS.has(v.expression.text));
    out.push({ file, line: at(n), op, text: v.getText(sf), safe });
  };
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n)) {
      const op = nameOf(n.name);
      if (op && OPS.has(op)) judge(n, op, n.initializer);
    } else if (ts.isShorthandPropertyAssignment(n) && OPS.has(n.name.text)) {
      out.push({ file, line: at(n), op: n.name.text, text: n.name.text, safe: false });
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const op = assignedOp(n.left);
      if (op && OPS.has(op)) judge(n, op, n.right);
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
      'const g = { name: { ["contains"]: q } };',
      "const h = { name: { [`startsWith`]: escapeLike(q) } };",
      "where.name.contains = data.search;",
      'where.key["endsWith"] = escapeLike(data.type);',
      "const i = { [contains]: q };",
    ].join("\n"));
    expect(judged.map((o) => [o.line, o.text, o.safe])).toEqual([
      [1, "q", false],
      [2, "escapeLike(q)", true],
      [3, "`.${t}`", false],
      [4, '".task"', true],
      [5, "contains", false],
      [8, "q", false],
      [9, "escapeLike(q)", true],
      [10, "data.search", false],
      [11, "escapeLike(data.type)", true],
    ]);
  });
});

// The same hole in hand-written SQL: a LIKE or ILIKE whose pattern is an
// interpolated value (a tagged $queryRaw / Prisma.sql template, or a string
// handed to $queryRawUnsafe, where `${p(v)}` binds v). Chat search's `from:`
// and `in:` were the case. Postgres' default LIKE escape is backslash, the
// one Prisma's contains relies on, so escapeLike is the rule here too, and no
// ESCAPE clause is needed. The keyword is read in capitals anywhere, and in any
// case in a file that calls a raw-SQL API, so prose ("looks like ${name}") is
// no operand. A pattern bound by position (`ILIKE $3`) can't be judged, so it
// is refused: bind it through an inline escapeLike instead.
const RAW_API = /\$(?:queryRaw|queryRawUnsafe|executeRaw|executeRawUnsafe)\b|\bPrisma\.(?:sql|raw)\b/;
const LIKE_THEN = String.raw`\bI?LIKE\s*(?:(?:ANY|ALL)\s*\(\s*)?(?:'(?:[^']|'')*'\s*\|\|\s*)?`;

type RawOperand = { file: string; line: number; text: string; safe: boolean };

/** A LIKE pattern is safe when every piece typed text could reach goes through an escaper. */
function rawSafe(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e)) return rawSafe(e.expression);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
  if (ts.isTemplateExpression(e)) return e.templateSpans.every((span) => rawSafe(span.expression));
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
    if (ESCAPERS.has(e.expression.text)) return true;
    // A positional binder, `p(value)`, returns its placeholder: judge what it binds.
    return e.arguments.length === 1 && rawSafe(e.arguments[0]);
  }
  return false;
}

/** Every LIKE / ILIKE pattern in `src` that is interpolated or bound by position. */
function rawLikeOperandsIn(file: string, src: string): RawOperand[] {
  const flags = RAW_API.test(src) ? "i" : "";
  const before = new RegExp(`${LIKE_THEN}$`, flags);
  const positional = new RegExp(`${LIKE_THEN}\\$\\d`, flags);
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: RawOperand[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isTemplateExpression(n)) {
      const texts = [n.head, ...n.templateSpans.map((span) => span.literal)];
      n.templateSpans.forEach((span, i) => {
        if (before.test(texts[i].text)) {
          out.push({ file, line: at(span.expression), text: span.expression.getText(sf), safe: rawSafe(span.expression) });
        }
      });
      for (const t of texts) if (positional.test(t.text)) out.push({ file, line: at(t), text: t.text.trim(), safe: false });
    } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && positional.test(n.text)) {
      out.push({ file, line: at(n), text: n.text.trim(), safe: false });
    } else if (
      ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken
      && (ts.isStringLiteral(n.left) || ts.isNoSubstitutionTemplateLiteral(n.left)) && before.test(n.left.text)
    ) {
      out.push({ file, line: at(n.right), text: n.right.getText(sf), safe: rawSafe(n.right) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const raw = files.flatMap((f) => {
  const src = readFileSync(f, "utf8");
  return /like/i.test(src) ? rawLikeOperandsIn(f, src) : [];
});

describe("a LIKE pattern interpolated into hand-written SQL is escaped", () => {
  it("the scan reads real operands: chat search's from: and in:", () => {
    expect(raw.filter((o) => o.file.endsWith("chat/search/route.ts")).length).toBe(2);
  });

  it("every one goes through escapeLike or likeText", () => {
    const bare = raw.filter((o) => !o.safe).map((o) => `${o.file}:${o.line} ${o.text}`);
    expect(bare).toEqual([]);
  });

  it("the judge: a bare or concatenated pattern and a positional one are caught; an escaped one, prose and comments are not", () => {
    const judged = rawLikeOperandsIn("x.ts", [
      "await prisma.$queryRaw`SELECT 1 FROM t WHERE name ILIKE ${q}`;",
      "await prisma.$queryRaw`SELECT 1 FROM t WHERE name ilike ${`%${escapeLike(q)}%`}`;",
      "conds.push(`c.name ILIKE ${p(`%${q}%`)}`);",
      "conds.push(`c.name ILIKE ${p(`%${escapeLike(q)}%`)}`);",
      "const a = Prisma.sql`name NOT LIKE '%' || ${q} || '%'`;",
      'const b = "u.display_name ILIKE $2";',
      'const c = "name LIKE " + q;',
      "// name ILIKE ${q}",
      "const d = `kind LIKE ${\"task%\"}`;",
    ].join("\n"));
    expect(judged.map((o) => [o.line, o.text, o.safe])).toEqual([
      [1, "q", false],
      [2, "`%${escapeLike(q)}%`", true],
      [3, "p(`%${q}%`)", false],
      [4, "p(`%${escapeLike(q)}%`)", true],
      [5, "q", false],
      [6, "u.display_name ILIKE $2", false],
      [7, "q", false],
      [9, '"task%"', true],
    ]);
    // Without a raw-SQL call in the file, only the capitalised keyword is SQL.
    expect(rawLikeOperandsIn("y.tsx", "const t = `Looks like ${name} left; LIKE ${q}`;").map((o) => o.text)).toEqual(["q"]);
  });
});
