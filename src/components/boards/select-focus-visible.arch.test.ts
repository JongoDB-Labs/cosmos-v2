// @vitest-environment node
//
// A <select> that removes its outline must put a focus ring back.
//
// `outline-none` is shadcn's habit for controls that paint their own focus
// treatment, and it is fine when something replaces it. On four selects in the
// Table board nothing did: the Group by select, and the three inline cell
// editors for priority, status and assignee. The three editors are the sharp
// end -- each is rendered with `autoFocus` and closes on blur, so it takes
// focus the instant it appears and the keyboard user is typing into a control
// with no visible focus anywhere on screen.
//
// axe does not catch this. `select-name` fired on the Group by select and was
// fixed; a missing focus INDICATOR is a contrast/visibility judgement that an
// automated scan does not make, so the defect outlived the scan that ran right
// past it.
//
// Scoped to <select> deliberately. A blanket "outline-none needs
// focus-visible" rule over every element matches 25 sites, most of them
// non-focusable containers and dialog grounds that correctly show no ring --
// it would fail on content that is already right. Every <select> in the app is
// focusable by definition, which makes it a category where the rule is simply
// true.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/components", "src/app"].map((r) => join(process.cwd(), r));

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith(".tsx") && !entry.includes(".test.")) out.push(full);
  }
  return out;
}

/** Opening <select> tags, with comments stripped first — a guard that reads
 *  its own explanation is a guard that passes because of the prose describing
 *  the bug.
 *
 *  Scanned by hand rather than by regex. The obvious `/<select\b[^>]*>/` is
 *  WRONG here and quietly so: these tags carry `onChange={(e) => ...}`, so the
 *  character class stops dead at the arrow's `>` and the tag it returns ends
 *  long before `className`. The first version of this file did exactly that
 *  and passed against the four selects it was written to catch. Walk the tag
 *  instead, tracking brace depth and quotes, and close it on a `>` that is
 *  really the end of the tag. */
function selectTags(): { file: string; tag: string; line: number }[] {
  const found: { file: string; tag: string; line: number }[] = [];
  for (const root of ROOTS) {
    for (const file of tsxFiles(root)) {
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const m of text.matchAll(/<select\b/g)) {
        const start = m.index!;
        let depth = 0;
        let quote: string | null = null;
        let end = -1;
        for (let i = start; i < text.length; i++) {
          const c = text[i];
          if (quote) {
            if (c === quote && text[i - 1] !== "\\") quote = null;
            continue;
          }
          if (c === '"' || c === "'" || c === "`") quote = c;
          else if (c === "{") depth++;
          else if (c === "}") depth--;
          else if (c === ">" && depth === 0) {
            end = i;
            break;
          }
        }
        if (end === -1) continue;
        found.push({
          file: file.replace(process.cwd() + "/", ""),
          tag: text.slice(start, end + 1),
          line: text.slice(0, start).split("\n").length,
        });
      }
    }
  }
  return found;
}

describe("a <select> keeps a visible focus indicator", () => {
  it("never strips the outline without replacing it", () => {
    const offenders = selectTags()
      .filter((s) => s.tag.includes("outline-none") && !s.tag.includes("focus-visible:"))
      .map((s) => `${s.file}:${s.line}`);
    expect(offenders).toEqual([]);
  });

  it("is actually reading the selects — the rule above is not vacuous", () => {
    // Without this, renaming the element or dropping the token leaves nothing
    // to match and nothing to fail. The count is a floor, not a fixed number,
    // so adding a select does not break the build.
    expect(selectTags().length).toBeGreaterThanOrEqual(50);
  });
});
