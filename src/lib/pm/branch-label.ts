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

/**
 * Every branch picker's options, labelled once.
 *
 * Each PM register renders the branch picker TWICE — once as `options` on the
 * inline-edit field, once as `SelectItem`s in its create dialog — and the
 * original stutter fix only reached the inline-edit half. All four registers
 * therefore kept offering "LOE1 LOE 1 — …" in the dialog that actually creates
 * the record, which is the one a user meets first.
 *
 * Building the options here rather than at each call site means there is one
 * place to be right. `branch-options.arch.test.ts` fails on any register that
 * goes back to interpolating `code` and `name` itself.
 */
export function branchOptions(
  branches: readonly { id: string; code: string; name: string }[],
): { value: string; label: string }[] {
  return branches.map((b) => ({ value: b.id, label: branchLabel(b.code, b.name) }));
}
