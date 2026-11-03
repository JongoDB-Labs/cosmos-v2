// The helper six arch tests depend on, and the bug it was written to kill.
import { describe, expect, it } from "vitest";
import { codeWithoutComments } from "./code-without-comments";

describe("codeWithoutComments", () => {
  it("blanks a line comment but keeps the line", () => {
    const out = codeWithoutComments('const a = 1; // note\nconst b = 2;');
    expect(out.split("\n")).toHaveLength(2);
    expect(out).not.toContain("note");
    expect(out).toContain("const a = 1;");
  });

  it("does NOT let a `/*` inside a line comment swallow the file", () => {
    // The real regression: board-tabs.tsx has `// /pm-dashboard/* sub-page.`,
    // and stripping blocks first blanked 520 lines after it.
    const src = [
      '  // /pm-dashboard/* sub-page.',
      '  const keep = "FINDME";',
      '  {/* a real jsx comment */}',
      '  const alsoKeep = "FINDME2";',
    ].join("\n");
    const out = codeWithoutComments(src);
    expect(out).toContain("FINDME");
    expect(out).toContain("FINDME2");
  });

  it("keeps a URL, which is not a comment", () => {
    const out = codeWithoutComments('const u = "https://example.com/x";');
    expect(out).toContain("https://example.com/x");
  });

  it("blanks block and JSX comments, preserving line count", () => {
    const src = 'a\n/* one\n   two */\nb\n{/* three */}\nc';
    const out = codeWithoutComments(src);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).not.toContain("one");
    expect(out).not.toContain("three");
    expect(out).toContain("a");
    expect(out).toContain("c");
  });
});
