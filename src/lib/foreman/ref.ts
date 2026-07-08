/** Build a Foreman ticket ref from a project key + ticket number, e.g. ("COSMOS", 12) → "COSMOS-12". */
export function buildRef(key: string, ticketNumber: number): string {
  return `${key}-${ticketNumber}`;
}

/** Parse a ref into its key + number, splitting on the LAST hyphen-then-digits.
 *  Returns null if the string isn't a `<key>-<number>` ref. */
export function parseRef(ref: string): { key: string; number: number } | null {
  const match = ref.match(/^(.+)-(\d+)$/);
  if (!match) {
    return null;
  }
  return {
    key: match[1],
    number: Number(match[2]),
  };
}
