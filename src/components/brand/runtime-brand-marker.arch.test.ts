// @vitest-environment node
//
// A page whose own subtree is fully static must carry <RuntimeBrandMarker />.
//
// The root layout's generateMetadata() awaits connection() so the <title> is
// the deployment's runtime PRODUCT, not the build default. Next 16.4's dev
// instant-navigation validation treats the root layout as already mounted on a
// client navigation, so RootBrandProvider's connection() does not count for it,
// and a page with nothing dynamic of its own logs, on every load:
//   Route "/login": Next.js encountered uncached data in `generateMetadata()`.
// A marker in a segment layout or in a root template.tsx was tried and does not
// satisfy the check; it has to be rendered by the page.
//
// The pages that hit this were exactly the two `"use client"` pages, because a
// client page cannot read cookies on the server and so is never dynamic on its
// own. Hence the general rule below: no client page.tsx; wrap the client body
// in a server page that renders the marker.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MARKED_PAGES = [
  "src/app/login/page.tsx",
  "src/app/reset-password/page.tsx",
  // /developers reads nothing from the request: no org, no cookies.
  "src/app/(developers)/developers/page.tsx",
  "src/app/(developers)/developers/guides/[slug]/page.tsx",
  "src/app/(developers)/developers/reference/page.tsx",
  "src/app/(developers)/developers/changelog/page.tsx",
];

function code(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...pages(rel));
    else if (e.name === "page.tsx") out.push(rel);
  }
  return out;
}

describe("runtime-brand metadata marker", () => {
  it("is rendered by the pages that are otherwise fully static", () => {
    for (const rel of MARKED_PAGES) {
      expect(code(rel), rel).toMatch(/<RuntimeBrandMarker\s*\/>/);
    }
  });

  it("no page.tsx is a client component", () => {
    const offenders = pages("src/app").filter((rel) =>
      /^\s*["']use client["']/.test(code(rel)),
    );
    expect(
      offenders,
      "A client page.tsx is fully static, so the root layout's runtime " +
        "generateMetadata() trips Next's dev validation on it. Move the body " +
        "to a client module and render it from a server page.tsx alongside " +
        `<RuntimeBrandMarker />:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("is anchored to a root generateMetadata that really reads runtime data", () => {
    // Guard the guard: if the root metadata stops awaiting connection(), the
    // marker is no longer needed and this whole file should be revisited.
    const layout = code("src/app/layout.tsx");
    expect(layout).toMatch(/export async function generateMetadata/);
    expect(layout).toMatch(/await connection\(\)/);
  });

  it("keeps the moved client bodies free of the brand literal", () => {
    // brand-literals.arch.test.ts checks src/app/login/page.tsx, which is now
    // only the server wrapper; the form it used to guard lives here.
    for (const rel of [
      "src/app/login/login-form.tsx",
      "src/app/reset-password/reset-password-form.tsx",
    ]) {
      expect(readFileSync(join(process.cwd(), rel), "utf8"), rel).not.toMatch(/COSMOS/);
    }
  });
});
