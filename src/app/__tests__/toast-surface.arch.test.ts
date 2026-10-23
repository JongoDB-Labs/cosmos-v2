import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * COSMOS-221, second half: the notice has to have somewhere to land.
 *
 * <ChunkReloadGuard> is mounted in the ROOT layout, so a post-deploy
 * ChunkLoadError is caught on EVERY route — including /login and
 * /reset-password. When it finds unsaved input it no longer reloads; it calls
 * sonner's toast() and waits for the user to click Reload.
 *
 * sonner's toast() only publishes to subscribers that are mounted AT THAT
 * MOMENT (`publish` forwards to `this.subscribers`; a <Toaster> mounting later
 * does not replay). With the toaster scoped to (dashboard)/layout.tsx, the
 * pre-login screens had no subscriber — so on the one surface where the user
 * is guaranteed to be typing into a focused text field, the guard suppressed
 * the reload and the notice went nowhere. No notice and no recovery: a tab
 * stuck on a dead chunk, strictly worse than the reload it replaced.
 *
 * So the toaster moved up to the root layout, and it must stay:
 *   - mounted in the SAME layout as the guard (one tree, every route), and
 *   - mounted EXACTLY ONCE — two live toasters render every toast twice.
 */
const ROOT = process.cwd();
const APP = join(ROOT, "src/app");

function layouts(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...layouts(path));
    else if (entry.name === "layout.tsx") out.push(path);
  }
  return out;
}

// Strip comments first: the prose beside both mounts explains the rule and
// names the component while doing it, so a naive match reads a comment as a
// mount and the check passes against the very shape it exists to reject.
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the chunk-reload notice has a toaster to render in", () => {
  it("mounts the toaster in the same layout as the reload guard", () => {
    const root = code(join(APP, "layout.tsx"));
    expect(root).toContain("<ChunkReloadGuard />");
    expect(
      root,
      "<ChunkReloadGuard /> toasts on every route — its <Toaster /> must be mounted alongside it, not in (dashboard)",
    ).toMatch(/<Toaster\b/);
  });

  it("mounts exactly one toaster across every layout", () => {
    const mounts = layouts(APP).filter((path) => /<Toaster\b/.test(code(path)));
    expect(
      mounts.map((p) => p.slice(ROOT.length + 1)),
      "exactly one layout may mount <Toaster /> — a second one renders every toast twice",
    ).toEqual(["src/app/layout.tsx"]);
  });
});
