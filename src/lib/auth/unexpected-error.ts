/**
 * What a sign-in callback logs about a failure it didn't expect: the error's
 * name and, when it has one, its code (a database error's, say). Never its
 * message, which can carry an address, a token or a client's IP.
 */
export function unexpectedErrorKind(err: unknown): { name: string; code?: string } {
  if (!(err instanceof Error)) return { name: typeof err };
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? { name: err.name, code } : { name: err.name };
}
