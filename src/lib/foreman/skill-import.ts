// PURE — parses a SKILL.md (pasted or uploaded) into { name, description, body }
// for the Foreman skills manager (create/import). No I/O: the API route
// (foreman/skills/route.ts) calls this for `mode: "import"`.
export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

/** Parse a SKILL.md: extract `name` + `description` from the YAML frontmatter
 *  (--- ... ---). Falls back to a slug of a leading `# Heading` for name and the
 *  first non-empty prose line for description when frontmatter is absent. `body` is
 *  the full input unchanged. Throws if no name can be derived. */
export function parseSkillMarkdown(md: string): ParsedSkill {
  const fm = md.match(/^---\s*\n([\s\S]*?)\n---/);
  let name = "",
    description = "";
  if (fm) {
    name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "";
    description = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
  }
  if (!name) {
    const h = md.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (h) name = h.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  if (!description)
    description =
      md
        .replace(/^---[\s\S]*?---/, "")
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#")) ?? "";
  name = name.trim();
  if (!name) throw new Error("SKILL.md has no `name` (add YAML frontmatter or a # heading)");
  return { name, description: description.slice(0, 300), body: md };
}
