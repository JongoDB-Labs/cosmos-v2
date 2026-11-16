// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, cleanup } from "@testing-library/react";
import { FormField } from "./form-field";
import { contrastRatio } from "@/lib/theme/contrast";

afterEach(() => cleanup());

/** The text-colour utility on an element: `text-[var(--x,…)]` or a named one. */
const textColour = (el: Element) =>
  [...el.classList].filter((c) => /^text-(\[var\(|destructive|red-|\[#)/.test(c));

/** Custom properties declared in the innermost block with this exact selector that sets `token`. */
function tokenIn(selector: string, token: string, name: string): string {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].trim() !== selector || !m[2].includes(`${token}:`)) continue;
    const v = m[2].match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
    if (v) return v[1].trim();
  }
  throw new Error(`${name} not declared in a "${selector}" block that sets ${token}`);
}

describe("FormField error text contrast (WCAG 1.4.3)", () => {
  function setup() {
    render(
      <FormField label="Display name" required error="Display name is required">
        {(p) => <input {...p} />}
      </FormField>,
    );
    const error = screen.getByText("Display name is required");
    const star = screen.getByText("*");
    return { error, star };
  }

  it("colours the error with the required star's text token", () => {
    const { error, star } = setup();
    // Positive control: the star has exactly one colour utility to compare to.
    expect(textColour(star)).toEqual(["text-[var(--status-critical-text,var(--status-critical))]"]);
    expect(textColour(error)).toEqual(textColour(star));
  });

  it("that token clears 4.5:1 on the page and surface grounds, light and dark", () => {
    setup();
    const token = "--status-critical-text";
    // :root is light; :root.dark is an explicit dark choice (the OS-preference
    // block mirrors it, which badge-contrast.test.ts holds).
    for (const selector of [":root", ":root.dark"]) {
      const ink = tokenIn(selector, token, token);
      for (const ground of ["--bg", "--surface"]) {
        const bg = tokenIn(selector, token, ground);
        const r = contrastRatio(ink, bg);
        expect(r, `${token} ${ink} on ${ground} ${bg} (${selector}): ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
