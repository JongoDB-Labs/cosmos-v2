import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * Hovering a card or a row shows its ⋯ menu.
 *
 * ActionMenu renders its ⋯ trigger as a SIBLING of its children, inside a
 * `display: contents` wrapper, and reveals it with `group-hover/action`. That
 * only matches an ANCESTOR with `group/action`, so where the group sits decides
 * what hovering reveals it. Six call sites put the class on the card they
 * passed in as children (so it never matched), and four tables put it on the
 * actions cell (so only pointing at that cell showed it). The rules:
 *
 * 1. The group is the menu's own parent element, with nothing in between: no
 *    other element, and no function (a list renders its items through a
 *    `.map` callback, so a list-level container always has one in between).
 *    That parent is the card or row the menu belongs to.
 * 2. In a table column's `cell` renderer the parent is a cell, not the row, so
 *    the row is the group: DataTable's own `<tr>` carries it (checked below),
 *    the file must render DataTable, and the cell must not carry the group.
 * 3. The class is an exact, unconditional token: a string that is always there,
 *    not `group/actions`, not `cond && "group/action"`.
 * 4. A trigger placed `absolute` needs that parent positioned (`relative`, or
 *    already `absolute`), or it is placed against some other box.
 *
 * Parsed with the TypeScript compiler, so only real attributes count.
 */
const GROUP = "group/action";
const POSITIONED = ["relative", "absolute", "fixed", "sticky"];
const DATA_TABLE = "src/components/ui/data-table.tsx";

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) out.push(full.split("\\").join("/"));
  }
  return out;
}

const tagOf = (n: ts.Node): string | null =>
  ts.isJsxElement(n) ? n.openingElement.tagName.getText() : ts.isJsxSelfClosingElement(n) ? n.tagName.getText() : null;

function attribute(n: ts.Node, name: string): ts.JsxAttribute | undefined {
  const attrs = ts.isJsxElement(n) ? n.openingElement.attributes : ts.isJsxSelfClosingElement(n) ? n.attributes : null;
  return attrs?.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
}

/** The words of a string or template that are always there (a word touching a `${}` is not). */
function words(n: ts.Node): string[] {
  const CUT = "\u0000";
  const text = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text
    : ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map((s) => CUT + s.literal.text).join("")
    : null;
  return text === null ? [] : text.split(/\s+/).filter((w) => w && !w.includes(CUT));
}

/**
 * A className's unconditional class tokens: a plain string, or the plain
 * string arguments of `cn(…)`/`clsx(…)`. A conditional (`a && "x"`, a ternary,
 * an object) or a variable contributes none: it may not be there.
 */
function unconditionalClasses(attr: ts.JsxAttribute | undefined): string[] {
  const init = attr?.initializer;
  if (!init) return [];
  if (ts.isStringLiteral(init)) return words(init);
  if (!ts.isJsxExpression(init) || !init.expression) return [];
  const e = init.expression;
  if (ts.isCallExpression(e) && ["cn", "clsx", "cx"].includes(e.expression.getText())) return e.arguments.flatMap(words);
  return words(e);
}

const isFunction = (n: ts.Node) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);

/**
 * The element a node sits in, unless a function comes first (as a list's
 * `.map` callback does), and whether the nearest function around it is a table
 * column's `cell` renderer.
 */
function enclosingElement(n: ts.Node): { el: ts.Node | null; inCell: boolean } {
  let el: ts.Node | null = null;
  for (let p = n.parent; p; p = p.parent) {
    if (!el && tagOf(p)) el = p;
    if (isFunction(p)) return { el, inCell: ts.isPropertyAssignment(p.parent) && p.parent.name.getText() === "cell" };
  }
  return { el, inCell: false };
}

/** Each `<ActionMenu>` in `source`, by line, with what is wrong with its hover group (nothing, when right). */
function actionMenus(source: string, fileName = "x.tsx"): { line: number; problems: string[] }[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rendersDataTable = /<DataTable\b/.test(source);
  const out: { line: number; problems: string[] }[] = [];
  const visit = (n: ts.Node) => {
    if (tagOf(n) === "ActionMenu") {
      const problems: string[] = [];
      const { el, inCell } = enclosingElement(n);
      const parentClasses = el ? unconditionalClasses(attribute(el, "className")) : [];
      const absoluteTrigger = unconditionalClasses(attribute(n, "triggerClassName")).includes("absolute");
      if (inCell) {
        if (parentClasses.includes(GROUP)) problems.push("a table cell carries the group, so only that cell reveals the ⋯: the row must");
        if (!rendersDataTable) problems.push("in a column's cell, but no DataTable here to make the row the group");
      } else if (!parentClasses.includes(GROUP)) {
        problems.push(el ? "its parent element doesn't always carry the exact group/action class" : "no parent element of its own carries group/action");
      } else if (absoluteTrigger && !POSITIONED.some((c) => parentClasses.includes(c))) {
        problems.push("an absolute trigger, but its group isn't positioned (relative)");
      }
      out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, problems });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const wrap = (body: string) => `export const C = () => (\n  ${body}\n);`;
const problemsOf = (body: string, fileName?: string) => actionMenus(wrap(body), fileName).map((m) => m.problems);

describe("hovering a card or a row shows its ⋯ menu", () => {
  const sites = tsxFiles("src").flatMap((f) =>
    actionMenus(readFileSync(f, "utf8"), f).map((m) => ({ ...m, at: `${f}:${m.line}` })),
  );

  it("finds the real call sites (a positive control for the scan)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(20);
    expect(sites.some((s) => s.at.startsWith("src/components/meetings/meetings-list.tsx"))).toBe(true);
    expect(sites.some((s) => s.at.startsWith("src/components/finance/finance-dashboard.tsx"))).toBe(true);
  });

  it("passes a card's own wrapper, and flags the group inside the menu or out of reach (rule 1)", () => {
    expect(problemsOf(`<div className={cn("group/action relative", x && "z-20")}><ActionMenu groups={g}><div>card</div></ActionMenu></div>`)).toEqual([[]]);
    expect(problemsOf(`<ActionMenu groups={g}><div className="group/action relative">card</div></ActionMenu>`)).toEqual([
      ["no parent element of its own carries group/action"],
    ]);
    // A list-level group: the menu is reached through the list's .map callback.
    expect(problemsOf(`<ul className="group/action">{xs.map((x) => <ActionMenu key={x} groups={g}><li>{x}</li></ActionMenu>)}</ul>`)).toEqual([
      ["no parent element of its own carries group/action"],
    ]);
    // The group two elements up, not on the menu's own parent.
    expect(problemsOf(`<section className="group/action"><div className="flex"><ActionMenu groups={g}><p /></ActionMenu></div></section>`)).toEqual([
      ["its parent element doesn't always carry the exact group/action class"],
    ]);
  });

  it("makes the row the group in a table, never the cell (rule 2)", () => {
    const column = (cell: string) => `<DataTable columns={[{ id: "a", cell: ({ row }) => (${cell}) }]} data={d} />`;
    expect(problemsOf(column(`<div className="flex justify-end"><ActionMenu groups={g}><span /></ActionMenu></div>`))).toEqual([[]]);
    expect(problemsOf(column(`<div className="flex justify-end group/action"><ActionMenu groups={g}><span /></ActionMenu></div>`))).toEqual([
      ["a table cell carries the group, so only that cell reveals the ⋯: the row must"],
    ]);
    const noTable = actionMenus(`const cols = [{ cell: () => <div><ActionMenu groups={g}><span /></ActionMenu></div> }];`);
    expect(noTable.map((m) => m.problems)).toEqual([["in a column's cell, but no DataTable here to make the row the group"]]);
  });

  it("DataTable's rows are the group, as an exact, unconditional class (rule 2's other half)", () => {
    const sf = ts.createSourceFile(DATA_TABLE, readFileSync(DATA_TABLE, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const rows: string[][] = [];
    const visit = (n: ts.Node) => {
      // The body rows that hold cells: the ones with a right-click menu.
      if (tagOf(n) === "tr" && attribute(n, "onContextMenu")) rows.push(unconditionalClasses(attribute(n, "className")));
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(GROUP);
  });

  it("counts only an exact class that is always there (rule 3)", () => {
    const missing = ["its parent element doesn't always carry the exact group/action class"];
    expect(problemsOf(`<div className="group/actions relative"><ActionMenu groups={g}><p /></ActionMenu></div>`)).toEqual([missing]);
    expect(problemsOf(`<div className="my-group/action"><ActionMenu groups={g}><p /></ActionMenu></div>`)).toEqual([missing]);
    expect(problemsOf(`<div className={cn("relative", hovered && "group/action")}><ActionMenu groups={g}><p /></ActionMenu></div>`)).toEqual([missing]);
    expect(problemsOf(`<div className={on ? "group/action" : ""}><ActionMenu groups={g}><p /></ActionMenu></div>`)).toEqual([missing]);
    expect(problemsOf(`<div className={\`group/action\${x} relative\`}><ActionMenu groups={g}><p /></ActionMenu></div>`)).toEqual([missing]);
    expect(problemsOf(`<td className={\`group group/action relative \${x}\`}><ActionMenu groups={g}><p /></ActionMenu></td>`)).toEqual([[]]);
  });

  it("needs a positioned group for an absolute trigger (rule 4)", () => {
    expect(problemsOf(`<div className="group/action"><ActionMenu groups={g} triggerClassName="absolute right-2 top-2"><p /></ActionMenu></div>`)).toEqual([
      ["an absolute trigger, but its group isn't positioned (relative)"],
    ]);
    expect(problemsOf(`<div className="group/action relative"><ActionMenu groups={g} triggerClassName="absolute right-2 top-2"><p /></ActionMenu></div>`)).toEqual([[]]);
  });

  it("every call site follows the rules", () => {
    expect(sites.filter((s) => s.problems.length).map((s) => `${s.at}: ${s.problems.join("; ")}`)).toEqual([]);
  });
});
