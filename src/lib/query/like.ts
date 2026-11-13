/**
 * The text of a `~` search as a LIKE operand. Prisma's contains/startsWith do
 * NOT escape LIKE wildcards: unescaped, `summary ~ "%"` matched every item and
 * `_` matched any character. Postgres' default LIKE escape is backslash.
 */
export function likeText(q: string): string {
  return q.replace(/\*$/, "").replace(/[\\%_]/g, (c) => `\\${c}`);
}
