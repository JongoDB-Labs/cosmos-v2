// @vitest-environment node
//
// The assistant is named by the DEPLOYMENT, not by a string in a component.
//
// `agentName` is on the brand profile and an org can override it, yet the
// assistant UI said the neutral product's agent in eight places — the panel
// heading ("… — your agentic AI chat assistant"), its body copy, the header
// label, the avatar's aria-label, the dictation hint in Preferences, and the
// MCP servers copy twice on the page and once in the manager. On a branded
// deployment every one of them named the wrong product, on the app's headline
// AI surface.
//
// brand-literals.arch.test.ts exists and did not catch this, for two
// independent reasons worth keeping written down:
//
//   1. it is an ALLOWLIST of ~11 migrated files, and none of these were on it;
//   2. it matches /COSMOS/ — the PRODUCT name. The agent literal is "Cosmo",
//      a different word it never looked for.
//
// So this rule is a sweep rather than a list, and it looks for the agent.
//
// WIDENED after the first version shipped: it swept src/components and src/app
// only, and the assistant's SYSTEM PROMPT lives in src/lib. So the UI was fixed
// while the model was still told "You are <neutral agent>. Introduce yourself as
// <neutral agent>." — the panel and the assistant's own words disagreed, which
// is worse than either being wrong alone. src/lib is in scope now.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

/**
 * Case-sensitive and word-bounded on purpose. It must NOT fire on the things
 * that legitimately carry the name:
 *   CosmoAvatar        — the component identifier ("A" is a word char, no \b)
 *   cosmo-avatar.tsx   — the filename
 *   --cosmo-hi / --cosmos-drawer-w — CSS custom properties (lowercase)
 * and it MUST fire on a bare "Cosmo" sitting in copy.
 */
const AGENT_LITERAL = /\bCosmo\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = ["src/components", "src/app", "src/lib"]
  .flatMap((d) => walk(join(ROOT, d)))
  .map((f) => relative(ROOT, f))
  .filter((rel) => !/\.(test|spec)\.(ts|tsx)$/.test(rel) && !rel.includes("__tests__"))
  // Composed from private plugin repos; a violation there is fixed and
  // released there, so failing core's build on it would block us on a third
  // party. Each plugin's CI composes core and runs this file.
  .filter((rel) => !rel.startsWith(join("src", "plugins")))
  // The two files that legitimately carry the name:
  //   profiles.ts  — the brand DEFINITIONS; the neutral profile has to say its
  //                  own agent's name and wake phrase, that is what it is for.
  //   changelog.ts — release notes as they shipped. Rewriting history so an old
  //                  entry names today's agent would be a lie about the past.
  .filter((rel) => rel !== join("src", "lib", "product", "profiles.ts"))
  .filter((rel) => rel !== join("src", "lib", "changelog.ts"));

/** Comments name the agent freely — including the block above this one. */
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the assistant's name", () => {
  it("is swept across a real number of files", () => {
    // Guard the guard: if the walk breaks, the rule below checks nothing.
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(join("src", "components", "assistant", "assistant-panel.tsx"));
  });

  it("is never hardcoded in a component", () => {
    const offenders = files.filter((rel) => AGENT_LITERAL.test(code(rel)));
    expect(
      offenders,
      `Use useBrand().agentName (or getBrand().agentName on the server) in:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
