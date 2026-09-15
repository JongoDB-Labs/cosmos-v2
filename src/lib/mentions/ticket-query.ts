/**
 * Recognises a work-item reference in a search box.
 *
 * Search matched titles only, so the identifier people actually quote — "TEST-123",
 * or just "123" — found nothing, while the results it did return displayed that
 * very number. This turns the query into a ticket lookup when it looks like one
 * and leaves it alone when it does not.
 *
 * Pure and total: returns an empty object rather than throwing, so a caller can
 * always spread the result into a where-clause.
 */

/** Postgres INT4 ceiling. A pasted timestamp must never reach the query. */
const MAX_TICKET = 2_147_483_647;

export interface TicketQuery {
  projectKey?: string;
  ticketNumber?: number;
}

// Whole-string only: "KEY-123", "123", "#123". A number embedded in a word
// ("v2", "sprint1") is title text, and treating it as a ticket would rank an
// unrelated item above the thing the user was actually looking for.
const TICKET_RE = /^#?(?:([A-Za-z][A-Za-z0-9_]*)-)?(\d+)$/;

export function parseTicketQuery(q: string): TicketQuery {
  const match = TICKET_RE.exec(q.trim());
  if (!match) return {};

  const ticketNumber = Number(match[2]);
  if (!Number.isSafeInteger(ticketNumber)) return {};
  // Ticket numbers count up from 1; 0 and anything past INT4 are not lookups.
  if (ticketNumber < 1 || ticketNumber > MAX_TICKET) return {};

  const projectKey = match[1]?.toUpperCase();
  return projectKey ? { projectKey, ticketNumber } : { ticketNumber };
}
