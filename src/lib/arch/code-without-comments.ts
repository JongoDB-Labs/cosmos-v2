/**
 * Source with its comments blanked, for arch tests that match on markup.
 *
 * Exists because six arch tests had their own copy of this, and the copies were
 * subtly WRONG in a way none of them could notice: they stripped `/* *\/`
 * blocks BEFORE `//` lines, so a line comment containing a literal `/*` --
 * `board-tabs.tsx` has `// /pm-dashboard/* sub-page.` -- was read as a block
 * opener and everything up to the next `*\/` vanished. In that file it blanked
 * **520 lines**, including the tab strip's own root element, so a rule
 * asserting on that root silently matched nothing and passed.
 *
 * Order therefore matters: line comments go first, so a `/*` inside one is
 * gone before block stripping runs.
 *
 * `//` is only treated as a comment when it is NOT preceded by `:`, so a URL
 * (`https://...`) survives. Comments are BLANKED rather than removed so every
 * reported line number still points at the real line in the real file -- a
 * gate that names the wrong line sends the next reader to the wrong place.
 */
export function codeWithoutComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");

  const noLineComments = src
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, (_m, keep: string) => keep))
    .join("\n");

  return noLineComments
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank);
}
