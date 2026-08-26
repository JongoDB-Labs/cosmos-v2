/**
 * The identity of what a flag is about.
 *
 * No imports, deliberately: this is read by rule code on both sides of the
 * client/server line, and a constant that drags a server module into a browser
 * bundle is a failure mode this codebase has already paid for once.
 */
export type FlagSubject = {
  projectId?: string | null;
  userId?: string | null;
  /** A plugin's own entity, e.g. a fee phase or a milestone. */
  subjectType?: string | null;
  subjectId?: string | null;
};

/**
 * PURE. The identity a rule dedupes on, in the same shape the partial unique
 * index uses: empty string for absent, so two subject-less flags for one rule
 * collide rather than both being allowed.
 *
 * Kept here rather than inlined at call sites so the key the code computes and
 * the key the database enforces cannot drift apart.
 */
export function subjectKey(rule: string, s: FlagSubject): string {
  return [rule, s.projectId ?? "", s.userId ?? "", s.subjectType ?? "", s.subjectId ?? ""].join("\u0000");
}

/** PURE. True when two subjects point at the same thing. */
export function sameSubject(a: FlagSubject, b: FlagSubject): boolean {
  return subjectKey("", a) === subjectKey("", b);
}
