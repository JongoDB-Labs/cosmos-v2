// @vitest-environment node
//
// A component may only name a design token that something actually defines.
//
// `var(--x)` with no definition and no fallback is not an error anywhere in the
// stack. CSS drops the declaration, the element keeps whatever it inherited,
// tsc has nothing to say, and the component renders -- just without the thing
// the token was for. So the failures were all silent and all visual:
//
//   --accent          the SELECTED filter pill in Files, Inbox, Bills and the
//                     project pulse: no background, and `text-white` on the
//                     pearl canvas, about 1.04:1. The selected filter was the
//                     one you could not see.
//   --accent          the unread dot in Inbox -- so read and unread looked the
//                     same.
//   --surface-2       the briefing's hours bar: undefined track AND undefined
//   + --accent        fill, i.e. no bar.
//   --bg-elevated     every error page's card, and --status-danger its icon, so
//   + --status-danger the one screen whose whole job is to be legible when
//                     something has gone wrong had no card and no icon.
//   --surface-hover   the tour's callout and its feedback input.
//
// None of these was a colour choice gone wrong. The tokens had simply never
// existed: no skin defines them, globals.css does not, nothing does. They read
// like a second, parallel vocabulary someone expected to be there.
//
// A fallback is fine and is deliberately allowed -- `var(--x, #fff)` says what
// happens when the token is absent. This rule is only about the bare form.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOT = process.cwd();
const DECLARED = /(--[a-z0-9-]+)"?\s*:/g;
const BARE_USE = /var\((--[a-z0-9-]+)\)/g;

/**
 * Namespaces Tailwind owns. `--color-*`, `--radius-*`, `--font-*` and friends
 * come from Tailwind's own theme (and from next/font, for the face variables),
 * so they are real at runtime while being declared nowhere we can read.
 */
const TAILWIND_NAMESPACE =
  /^--(color|radius|font|text|tracking|leading|spacing|breakpoint|container|aspect|ease|animate|blur|perspective|shadow|inset|drop|backdrop|tw)-/;

/**
 * Set for us by a library at runtime, not by our stylesheets. Base UI's
 * positioner writes the anchor geometry onto the popup element, so the token is
 * real by the time anything reads it.
 */
const PROVIDED_BY_LIBRARY = new Set(["--available-height", "--anchor-width", "--transform-origin"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const all = walk(join(ROOT, "src"));

/** Every token declared in a stylesheet or in the skin presets. */
const declared = new Set<string>();
for (const f of all) {
  if (extname(f) === ".css" || f.endsWith("lib/theme/skins.ts")) {
    for (const [, name] of readFileSync(f, "utf8").matchAll(DECLARED)) declared.add(name);
  }
}

const sources = all.filter((f) => {
  const rel = relative(ROOT, f);
  if (!/\.(ts|tsx)$/.test(rel)) return false;
  if (/\.(test|spec)\.(ts|tsx)$/.test(rel) || rel.includes("__tests__")) return false;
  // src/plugins/** is COMPOSED from private plugin repos and is not ours to
  // edit from here -- a violation there has to be fixed in that repo and
  // released, so failing this build on it would block core on a third party.
  // The composed build still gets the benefit: each plugin's own CI composes
  // core and runs this file, so adopting the rule is a per-plugin decision
  // rather than a cross-repo lockstep.
  return !rel.startsWith(join("src", "plugins"));
});

/**
 * Strip comments before matching. Every guard in this repo that skipped this
 * step ended up reading its own explanation: the prose above names the tokens
 * it exists to forbid, and so does the comment in lib/work-items/highlights.ts
 * that discusses `border-[var(--x)]` as a technique. Both would "fail" a rule
 * that greps raw source.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** `style={{ "--x": ... }}` — the file defines the token it then reads. */
function setsInline(text: string, token: string): boolean {
  return new RegExp(`["']${token}["']\\s*:`).test(text);
}

describe("design tokens", () => {
  it("has a non-trivial vocabulary to check against", () => {
    // Guard the guard: if the declaration scan ever breaks, `declared` goes
    // empty, everything looks undefined, and someone "fixes" it by deleting
    // the rule. A floor makes that failure loud and obviously wrong.
    expect(declared.size).toBeGreaterThan(30);
    expect(declared.has("--primary")).toBe(true);
    expect(declared.has("--surface")).toBe(true);
  });

  it("are all defined somewhere, or carry a fallback", () => {
    const offenders: string[] = [];
    for (const f of sources) {
      const text = code(readFileSync(f, "utf8"));
      for (const [, token] of text.matchAll(BARE_USE)) {
        if (declared.has(token)) continue;
        if (TAILWIND_NAMESPACE.test(token)) continue;
        if (PROVIDED_BY_LIBRARY.has(token)) continue;
        if (setsInline(text, token)) continue;
        offenders.push(`${relative(ROOT, f)} → var(${token})`);
      }
    }
    expect([...new Set(offenders)].sort()).toEqual([]);
  });
});
