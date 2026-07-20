// @vitest-environment node
//
// Pure parser for a pasted/uploaded SKILL.md, used by the skills-manager
// import flow (foreman/skills route, mode:"import"). Proves: frontmatter
// name+description extraction with body preserved verbatim; the # heading
// fallback (slugified) plus first-prose-line description when frontmatter is
// absent; and the no-derivable-name case throws.
import { describe, it, expect } from "vitest";
import { parseSkillMarkdown } from "./skill-import";

describe("parseSkillMarkdown", () => {
  it("extracts name + description from full YAML frontmatter and preserves body unchanged", () => {
    const md = `---
name: cosmos-conventions
description: House style for cosmos-v2 — naming, error handling, and test layout.
---

# cosmos-v2 conventions

Some body content here.
`;
    const result = parseSkillMarkdown(md);
    expect(result.name).toBe("cosmos-conventions");
    expect(result.description).toBe(
      "House style for cosmos-v2 — naming, error handling, and test layout.",
    );
    expect(result.body).toBe(md);
  });

  it("falls back to a slug of a leading # heading for name, and the first prose line for description, when frontmatter is absent", () => {
    const md = `# My Skill

This is the first line of prose.

More text after.
`;
    const result = parseSkillMarkdown(md);
    expect(result.name).toBe("my-skill");
    expect(result.description).toBe("This is the first line of prose.");
    expect(result.body).toBe(md);
  });

  it("throws when no name can be derived (no frontmatter, no heading)", () => {
    const md = "Just some prose with no heading and no frontmatter.";
    expect(() => parseSkillMarkdown(md)).toThrow(/no `name`/);
  });

  it("throws on empty input", () => {
    expect(() => parseSkillMarkdown("")).toThrow();
  });

  it("truncates an overlong description to 300 chars", () => {
    const longDesc = "x".repeat(400);
    const md = `---
name: long-desc-skill
description: ${longDesc}
---

Body.
`;
    const result = parseSkillMarkdown(md);
    expect(result.description.length).toBe(300);
  });

  it("uses frontmatter name even when a # heading is also present", () => {
    const md = `---
name: from-frontmatter
description: From frontmatter.
---

# A Different Heading

Body text.
`;
    const result = parseSkillMarkdown(md);
    expect(result.name).toBe("from-frontmatter");
  });
});
