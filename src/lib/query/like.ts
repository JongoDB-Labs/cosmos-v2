/**
 * `q` as literal text inside a LIKE pattern. Prisma's contains/startsWith/
 * endsWith do NOT escape LIKE wildcards: unescaped, a search for `%` matched
 * every row and `_` matched any character. Postgres' default LIKE escape is
 * backslash, so a backslash is escaped too. Every such operand built from text
 * a person or the assistant typed goes through this (like.arch.test.ts).
 */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The text of a CQL `~` search as a LIKE operand: a trailing `*` means "starts with", so it is dropped. */
export function likeText(q: string): string {
  return escapeLike(q.replace(/\*$/, ""));
}
