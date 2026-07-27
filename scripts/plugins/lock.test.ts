import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The lockfile is what makes a release reproducible: it states the exact plugin
 * commits the image was built from. These guard its SHAPE, so a malformed or
 * injectable ref can't reach the assembly build — the content itself is checked
 * against the working tree by `node scripts/plugins/lock.mjs`.
 */
const LOCK = join(process.cwd(), "plugins.lock.json");

/** What the assembly build will accept: a full SHA, or `main` for a plugin
 *  deliberately tracked at head. Branch names and refs like `refs/pull/1/head`
 *  are ref-injection vectors and must never appear here. */
const REF_RE = /^(main|[0-9a-f]{40})$/;

describe("plugins.lock.json", () => {
  it("exists — without it the assembly build silently falls back to plugin main", () => {
    expect(existsSync(LOCK)).toBe(true);
  });

  const lock = JSON.parse(readFileSync(LOCK, "utf8")) as {
    plugins: Record<string, { ref: string }>;
  };

  it("pins at least one plugin", () => {
    expect(Object.keys(lock.plugins).length).toBeGreaterThan(0);
  });

  it("pins every plugin to a full SHA or an explicit 'main'", () => {
    for (const [slug, entry] of Object.entries(lock.plugins)) {
      expect(entry.ref, `${slug} ref must be a 40-char SHA or 'main'`).toMatch(REF_RE);
    }
  });

  it("uses slugs the plugin system would accept, so a ref can't smuggle a path", () => {
    for (const slug of Object.keys(lock.plugins)) {
      expect(slug, "slug must be lowercase kebab-case").toMatch(/^[a-z][a-z0-9-]*$/);
      expect(slug).not.toContain("..");
      expect(slug).not.toContain("/");
    }
  });
});
