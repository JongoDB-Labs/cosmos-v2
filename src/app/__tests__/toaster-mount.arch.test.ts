// The chunk-reload notice needs a toaster on every route.
//
// <ChunkReloadGuard /> is mounted in the ROOT layout, so it catches a
// post-deploy ChunkLoadError on every route, the sign-in pages included. When
// the user has unsaved input it does not reload; it shows a toast and waits
// for them to click Reload. sonner only delivers a toast to a <Toaster> that
// is mounted at that moment, so a toaster scoped to (dashboard) left the
// pre-login pages with neither the reload nor the notice: a tab stuck on a
// dead chunk. Hence: the toaster lives beside the guard, and only there (two
// mounted toasters render every toast twice).
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const APP = join(process.cwd(), "src/app");

function layouts(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...layouts(path));
    else if (e.name === "layout.tsx") out.push(path);
  }
  return out;
}

// Comments name the component while explaining the rule; don't count them.
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("toaster mount", () => {
  it("is in the root layout, beside the chunk-reload guard", () => {
    const root = code(join(APP, "layout.tsx"));
    expect(root).toMatch(/<ChunkReloadGuard\s*\/>/);
    expect(root).toMatch(/<Toaster\b/);
  });

  it("is mounted by no other layout", () => {
    const others = layouts(APP)
      .filter((p) => p !== join(APP, "layout.tsx"))
      .filter((p) => /<Toaster\b/.test(code(p)))
      .map((p) => relative(process.cwd(), p));
    expect(others).toEqual([]);
  });
});
