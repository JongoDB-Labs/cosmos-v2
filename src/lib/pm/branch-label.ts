/**
 * Human label for a program branch (LOE).
 *
 * `ProgramBranch` stores `code` and `name` separately, and every picker built
 * the label as `${code} ${name}`. But the seeded names already lead with their
 * own number — code "LOE1", name "LOE 1 — Authorize, Cloud & Data" — so the
 * picker read "LOE1 LOE 1 — Authorize, Cloud & Data", stuttering the LOE number.
 *
 * Rather than assume either shape, this checks whether the name already opens
 * with the code and only prefixes when it doesn't. Comparison ignores whitespace
 * and case, so "LOE1" matches a name starting "LOE 1".
 */
export function branchLabel(code: string, name: string): string {
  const trimmedName = name.trim();
  const trimmedCode = code.trim();
  if (!trimmedCode) return trimmedName;
  if (!trimmedName) return trimmedCode;

  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  return norm(trimmedName).startsWith(norm(trimmedCode))
    ? trimmedName
    : `${trimmedCode} — ${trimmedName}`;
}
