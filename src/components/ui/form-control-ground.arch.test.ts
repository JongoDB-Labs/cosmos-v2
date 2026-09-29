// @vitest-environment node
//
// A form control must paint its own ground.
//
// The shared Input, Textarea, Select, DatePicker and the two searchable selects
// all carried `border-input bg-transparent`, which is shadcn's default and is
// fine on a flat canvas: the control inherits whatever surface it sits on.
//
// It is not fine here. A skin may paint a TEXTURE on the app shell -- the
// drafting grid is `repeating` background-image layers on the root shell div --
// and a transparent control lets that texture through. The result was grid
// lines running straight across the inside of every enabled text field in the
// app: the Display name box on Settings -> Profile, every dialog, every filter.
// Nothing was broken in any way a test could see; the fields simply looked
// like a rendering artefact, and only on the skins that paint a canvas.
//
// --bg, not --surface: a control needs to read as a WELL. Against a card
// (--surface) the page ground is the recessed tone; against the bare canvas it
// is opaque and hides whatever is painted there. Both are what we want, and one
// token gets both because each skin defines --bg for itself.
//
// Deliberately NOT covered: a control nested inside an already-surfaced
// container -- input-group's slots, and the inner search box of the searchable
// selects. Those SHOULD be transparent, and they are, which is why this rule
// keys on `border-input` (the outer, self-standing control) rather than on
// `bg-transparent` alone.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const UI = join(process.cwd(), "src/components/ui");

function sources(): { file: string; text: string }[] {
  return readdirSync(UI)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => ({ file: f, text: readFileSync(join(UI, f), "utf8") }))
    // Strip comments first. A guard that reads its own explanation is a guard
    // that passes because of the words describing the bug.
    .map(({ file, text }) => ({
      file,
      text: text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
    }));
}

describe("form controls", () => {
  it("never pair a bordered control with a transparent ground", () => {
    const offenders = sources()
      .filter(({ text }) => text.includes("border-input bg-transparent"))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("still ships the six controls this rule exists for", () => {
    // Without this the rule above passes trivially if someone renames the
    // files or drops the `border-input` token: nothing to match, nothing to
    // fail. Assert the controls are present AND grounded.
    const expected = [
      "input.tsx",
      "textarea.tsx",
      "select.tsx",
      "date-picker.tsx",
      "searchable-select.tsx",
      "searchable-multi-select.tsx",
    ];
    const grounded = sources()
      .filter(({ text }) => text.includes("border-input bg-[var(--bg)]"))
      .map(({ file }) => file)
      .sort();
    expect(grounded).toEqual([...expected].sort());
  });
});
