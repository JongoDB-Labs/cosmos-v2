/**
 * COSMOS-208: prompt people to write a ticket in three sections: what the work
 * is, how we'll know it's met, and what "done" means for the team. It's still
 * stored as ONE markdown description (the template approach was preferred over
 * separate fields), so every view that renders a description keeps working.
 */

export interface DescriptionSections {
  description: string;
  acceptanceCriteria: string;
  definitionOfDone: string;
}

export const SECTION_FIELDS: {
  key: keyof DescriptionSections;
  heading: string;
  placeholder: string;
}[] = [
  {
    key: "description",
    heading: "Description",
    placeholder:
      "What is the work, and why does it matter?\ne.g. As a release train engineer, I want past PIs collapsed on the sprint board so the row shows the work in front of us.",
  },
  {
    key: "acceptanceCriteria",
    heading: "Acceptance criteria",
    placeholder:
      "One testable outcome per line.\ne.g. - Given a PI that has ended, when I open the sprint board, then it starts collapsed.",
  },
  {
    key: "definitionOfDone",
    heading: "Definition of done",
    placeholder:
      "What has to be true before this moves to Done?\ne.g. - Reviewed and merged\n- Tests pass\n- Demoed to the product owner",
  },
];

export const EMPTY_SECTIONS: DescriptionSections = {
  description: "",
  acceptanceCriteria: "",
  definitionOfDone: "",
};

/**
 * Sections → markdown. Empty sections are left out, and all-empty is "".
 * A write-up with ONLY a description stays plain prose (no heading), so an
 * ordinary description, or one carried over by Duplicate, round-trips
 * unchanged instead of growing a "## Description" it never had.
 */
export function composeDescription(sections: DescriptionSections): string {
  if (!sections.acceptanceCriteria.trim() && !sections.definitionOfDone.trim()) {
    return sections.description.trim();
  }
  return SECTION_FIELDS.map(({ key, heading }) => [heading, sections[key].trim()] as const)
    .filter(([, body]) => body)
    .map(([heading, body]) => `## ${heading}\n\n${body}`)
    .join("\n\n");
}

/**
 * Markdown → sections, so switching from plain text back to the template
 * keeps what was typed. Text under our three headings goes to its section, and
 * text before the first heading goes to Description. Any other heading (say
 * "## Notes") is kept, with its text, in whichever section it appears in, so
 * nothing is dropped and the write-up keeps its reading order.
 */
export function parseDescription(markdown: string): DescriptionSections {
  const out: Record<keyof DescriptionSections, string[]> = {
    description: [],
    acceptanceCriteria: [],
    definitionOfDone: [],
  };
  let current: keyof DescriptionSections = "description";
  for (const line of markdown.split("\n")) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    const field = m && SECTION_FIELDS.find((f) => f.heading.toLowerCase() === m[1].toLowerCase());
    if (field) {
      current = field.key;
      continue;
    }
    out[current].push(line);
  }
  const tidy = (lines: string[]) => lines.join("\n").trim();
  return {
    description: tidy(out.description),
    acceptanceCriteria: tidy(out.acceptanceCriteria),
    definitionOfDone: tidy(out.definitionOfDone),
  };
}
