import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * Every `<ActionMenu>` sits inside an element carrying `group/action`.
 *
 * ActionMenu renders its ⋯ trigger as a SIBLING of its children, inside a
 * `display: contents` wrapper, and reveals it with `group-hover/action`. That
 * only matches an ANCESTOR with `group/action`. Six call sites put the class on
 * the card they passed in as children instead (meetings, projects, kanban,
 * RAID, CRM contacts) or nowhere (the hidden-tabs menu), so the ⋯ never showed
 * on hover: only focus or a right-click found the menu. The trigger also fell
 * out of place, as an invisible, clickable strip under each card.
 *
 * Parsed with the TypeScript compiler, so only a real `className` on a real
 * enclosing element counts.
 */
const GROUP = "group/action";

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

/** Whether an element's own `className` names the hover group. */
function carriesGroup(n: ts.Node): boolean {
  const attrs = ts.isJsxElement(n) ? n.openingElement.attributes : ts.isJsxSelfClosingElement(n) ? n.attributes : null;
  if (!attrs) return false;
  return attrs.properties.some(
    (p) => ts.isJsxAttribute(p) && p.name.getText() === "className" && !!p.initializer && p.initializer.getText().includes(GROUP),
  );
}

/** Each `<ActionMenu>` in `source`, by line, and whether an enclosing element carries the group. */
function actionMenus(source: string, fileName = "x.tsx"): { line: number; grouped: boolean }[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: { line: number; grouped: boolean }[] = [];
  const visit = (n: ts.Node) => {
    if (tagOf(n) === "ActionMenu") {
      let grouped = false;
      for (let p = n.parent; p && !grouped; p = p.parent) grouped = carriesGroup(p);
      out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, grouped });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("every ActionMenu has a hover group around it", () => {
  const sites = tsxFiles("src").flatMap((f) =>
    actionMenus(readFileSync(f, "utf8"), f).map((m) => ({ ...m, at: `${f}:${m.line}` })),
  );

  it("finds the real call sites (a positive control for the scan)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(20);
    expect(sites.some((s) => s.at.startsWith("src/components/meetings/meetings-list.tsx"))).toBe(true);
  });

  it("flags the group on the card inside the menu, and passes it on a box around it", () => {
    const inside = `export const A = () => (
      <ActionMenu groups={g}><div className="group/action relative">card</div></ActionMenu>
    );`;
    const around = `export const B = () => (
      <div className={cn("group/action relative", x && "z-20")}><ActionMenu groups={g}><div>card</div></ActionMenu></div>
    );`;
    expect(actionMenus(inside)).toEqual([{ line: 2, grouped: false }]);
    expect(actionMenus(around)).toEqual([{ line: 2, grouped: true }]);
  });

  it("every call site is inside an element whose className carries group/action", () => {
    expect(sites.filter((s) => !s.grouped).map((s) => s.at)).toEqual([]);
  });
});
