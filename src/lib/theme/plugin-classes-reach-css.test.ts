// @vitest-environment node
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

/**
 * A composed plugin's Tailwind classes must reach the CSS in a dev checkout.
 *
 * scripts/plugins/sync.mjs copies each plugin into src/plugins/<slug>/ and
 * lists every copied path in .git/info/exclude, so git never sees them.
 * Tailwind's source scan honours git's ignore rules, the exclude file
 * included, so it skipped those files too: a class only a plugin used was
 * never generated under `next dev`, and the plugin rendered unstyled. The
 * image build has no .git, so it scanned them anyway and never showed it.
 *
 * globals.css fixes it with an `@source` glob. A bare directory
 * (`@source "../plugins"`) is still filtered by the ignore rules; a glob that
 * names extensions is not. This builds a throwaway git repo shaped like a
 * composed checkout and compiles the real `@source` lines from globals.css.
 */
const ROOT = process.cwd();
const SOURCES = (readFileSync(join(ROOT, "src/app/globals.css"), "utf8").match(/^@source\s+[^;]+;/gm) ?? []);

const CORE = "bg-[#111111]";
const PLUGIN = "bg-[#222222]";
// How the class appears in generated CSS: `.bg-\[\#222222\]`.
const selector = (cls: string) => "." + cls.replace(/[[\]#]/g, (c) => `\\${c}`);

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "plugin-css-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  mkdirSync(join(repo, "src/app"), { recursive: true });
  mkdirSync(join(repo, "src/plugins/demo"), { recursive: true });
  writeFileSync(join(repo, "src/app/page.tsx"), `export const A = () => <div className="${CORE}" />;\n`);
  writeFileSync(join(repo, "src/plugins/demo/panel.tsx"), `export const B = () => <div className="${PLUGIN}" />;\n`);
  // What sync.mjs writes for every path it composes.
  appendFileSync(join(repo, ".git/info/exclude"), "/src/plugins/demo/panel.tsx\n");
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

async function compile(extra: string[]): Promise<string> {
  const from = join(repo, "src/app/globals.css");
  const css = ['@import "tailwindcss";', ...extra].join("\n");
  writeFileSync(from, css);
  const out = await postcss([tailwind({ base: repo })]).process(css, { from });
  return out.css;
}

describe("composed plugin classes reach the CSS", () => {
  it("globals.css declares an @source for the plugins", () => {
    expect(SOURCES.length, SOURCES.join("\n")).toBeGreaterThan(0);
  });

  it("without it, an excluded plugin file is not scanned", async () => {
    // Control: proves the exclude really hides the file, so the next test means something.
    const css = await compile([]);
    expect(css).toContain(selector(CORE));
    expect(css).not.toContain(selector(PLUGIN));
  }, 30_000);

  it("with the real @source lines, it is", async () => {
    const css = await compile(SOURCES);
    expect(css).toContain(selector(CORE));
    expect(css).toContain(selector(PLUGIN));
  }, 30_000);
});
