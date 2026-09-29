// Components read the brand from the PROVIDER, never from getBrand().
//
// Under Cache Components a synchronous `process.env.PRODUCT` read is inlined
// with the BUILD-time value, so getBrand() inside a component answers whatever
// the image was built as and never what the container is running as.
// RootBrandProvider does the `await connection()` dance once and seeds the live
// value; useBrand() reads it.
//
// BrandMark called getBrand() directly and became the one element on the login
// page that disagreed with the rest of it — title, heading and tagline all
// showed the deployment's real product while the mark beside them rendered
// alt="COSMOS", the default baked into the image. It looked like a branding
// oversight and was actually a build-time/runtime boundary being crossed.
//
// This is not a style rule. One image is deployed under several PRODUCT values,
// so a component that bakes the brand is wrong on every deployment but one.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src/components";

/**
 * Files that legitimately reach for the build-time brand, with the reason.
 */
const EXEMPT: Record<string, string> = {
  "src/components/providers/root-brand-provider.tsx":
    "THE sanctioned caller. It is a server component that awaits connection() " +
    "first, which halts prerendering so the read sees the live container env " +
    "rather than the build-time inline, and seeds the provider with it. " +
    "Everything else exists so that nothing else has to do this.",
  "src/components/providers/brand-provider.tsx":
    "useBrand() falls back to getBrand() when no provider is mounted — isolated " +
    "renders and pre-login chrome outside the tree. It is the one place that " +
    "SHOULD know about both, because it is what everything else uses instead.",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

describe("components take the brand from the provider", () => {
  const files = walk(ROOT);

  it("found the component tree", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("src/components/brand/brand-mark.tsx");
  });

  it("no component calls getBrand() directly", () => {
    const offenders = files.filter((f) => {
      if (f in EXEMPT) return false;
      // Comments are stripped first. The explanation beside the fix names the
      // function it replaced, and a regex over raw source reads that as a call
      // — which flagged the very file that had just been corrected.
      const code = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((l) => l.replace(/\/\/.*$/, ""))
        .join("\n");
      return /\bgetBrand\s*\(/.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it("the mark itself reads the provider", () => {
    const src = readFileSync("src/components/brand/brand-mark.tsx", "utf8");
    expect(src).toContain("useBrand");
    // A hook needs the directive; without it a server component could import
    // this and fail at render rather than at build.
    expect(src.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("the exemption list only names files that still exist", () => {
    expect(Object.keys(EXEMPT).filter((f) => !files.includes(f))).toEqual([]);
  });
});
