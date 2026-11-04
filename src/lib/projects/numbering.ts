/**
 * Project numbers: an org-wide standard such as `YY-NNN` (26-001, 26-002, …)
 * that a new project is numbered from automatically, plus an optional naming
 * pattern such as `{number} {name}`.
 *
 * Stored on Organization.settings.projects.numbering. Unset (or a null
 * pattern) means the org doesn't number projects, and nothing changes.
 *
 * PATTERN TOKENS
 *   YYYY   the four-digit year         2026
 *   YY     the two-digit year          26
 *   N…     the sequence, zero-padded to the number of Ns (NNN → 001). It
 *          widens rather than wraps past its width (NNN → 1000), so a busy
 *          year can never collide with its own first project.
 * Everything else is literal. With a year token the sequence restarts each
 * year; without one it simply counts up.
 *
 * The number is the PROJECT'S OWN, separate from its key: the key prefixes
 * ticket ids and is uppercase-alphanumeric, which `26-001` is not.
 *
 * Client-safe: no server imports.
 */

export interface ProjectNumbering {
  /** e.g. "YY-NNN". Null = the org doesn't number projects. */
  pattern: string | null;
  /** e.g. "{number} {name}". Null = names are used as typed. */
  namePattern: string | null;
}

export const MAX_PATTERN_LENGTH = 30;

export function projectNumbering(settings: unknown): ProjectNumbering {
  const n = ((settings ?? {}) as { projects?: { numbering?: { pattern?: unknown; namePattern?: unknown } } }).projects
    ?.numbering;
  const pattern = typeof n?.pattern === "string" && validatePattern(n.pattern) === null ? n.pattern : null;
  const namePattern = typeof n?.namePattern === "string" && validateNamePattern(n.namePattern) === null ? n.namePattern : null;
  return { pattern, namePattern };
}

type Token = { kind: "year4" } | { kind: "year2" } | { kind: "seq"; width: number } | { kind: "lit"; text: string };

function tokenize(pattern: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith("YYYY", i)) {
      out.push({ kind: "year4" });
      i += 4;
    } else if (pattern.startsWith("YY", i)) {
      out.push({ kind: "year2" });
      i += 2;
    } else if (pattern[i] === "N") {
      let w = 0;
      while (pattern[i + w] === "N") w++;
      out.push({ kind: "seq", width: w });
      i += w;
    } else {
      const last = out[out.length - 1];
      if (last?.kind === "lit") last.text += pattern[i];
      else out.push({ kind: "lit", text: pattern[i] });
      i++;
    }
  }
  return out;
}

/** Null when the pattern is usable, else why not — in words an admin can act on. */
export function validatePattern(pattern: string): string | null {
  if (!pattern.trim()) return "Enter a pattern, e.g. YY-NNN.";
  if (pattern.length > MAX_PATTERN_LENGTH) return `Keep the pattern to ${MAX_PATTERN_LENGTH} characters.`;
  if (!/^[A-Za-z0-9\-_./ ]+$/.test(pattern)) return "Use letters, digits, spaces and - _ . / only.";
  const tokens = tokenize(pattern);
  const seqs = tokens.filter((t) => t.kind === "seq");
  if (seqs.length !== 1) return "The pattern needs exactly one run of N for the sequence, e.g. NNN.";
  if ((seqs[0] as { width: number }).width > 6) return "Use at most six Ns.";
  if (tokens.filter((t) => t.kind === "year4" || t.kind === "year2").length > 1) return "Use the year at most once.";
  return null;
}

export function validateNamePattern(namePattern: string): string | null {
  if (!namePattern.includes("{name}")) return "The naming pattern must include {name}.";
  if (namePattern.length > 60) return "Keep the naming pattern to 60 characters.";
  const unknown = namePattern.match(/\{(?!name\}|number\})[^}]*\}/);
  if (unknown) return `Unknown placeholder ${unknown[0]}. Use {number} and {name}.`;
  return null;
}

export function formatProjectNumber(pattern: string, year: number, seq: number): string {
  return tokenize(pattern)
    .map((t) => {
      switch (t.kind) {
        case "year4":
          return String(year).padStart(4, "0");
        case "year2":
          return String(year % 100).padStart(2, "0");
        case "seq":
          return String(seq).padStart(t.width, "0");
        case "lit":
          return t.text;
      }
    })
    .join("");
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The sequence a number holds, if it is this pattern's number for this year. */
export function sequenceOf(pattern: string, year: number, number: string): number | null {
  const re = new RegExp(
    "^" +
      tokenize(pattern)
        .map((t) => {
          switch (t.kind) {
            case "year4":
              return escape(String(year).padStart(4, "0"));
            case "year2":
              return escape(String(year % 100).padStart(2, "0"));
            case "seq":
              return `(\\d{${t.width},})`;
            case "lit":
              return escape(t.text);
          }
        })
        .join("") +
      "$",
  );
  const m = re.exec(number);
  return m ? Number(m[1]) : null;
}

/**
 * The next number in the sequence: one past the highest this pattern has
 * produced for this year. Highest, not count, so a deleted or hand-numbered
 * project never makes the sequence reuse a number. Numbers that don't fit the
 * pattern (imported, or from an older standard) are ignored.
 */
export function nextProjectNumber(pattern: string, year: number, existing: readonly (string | null)[]): string {
  let max = 0;
  for (const n of existing) {
    if (!n) continue;
    const s = sequenceOf(pattern, year, n);
    if (s !== null && s > max) max = s;
  }
  return formatProjectNumber(pattern, year, max + 1);
}

/** The project's name under the org's naming pattern. No number, no change. */
export function applyNamePattern(namePattern: string | null, parts: { name: string; number: string | null }): string {
  if (!namePattern || !parts.number) return parts.name;
  return namePattern
    .replaceAll("{number}", parts.number)
    .replaceAll("{name}", parts.name)
    .replace(/\s+/g, " ")
    .trim();
}
