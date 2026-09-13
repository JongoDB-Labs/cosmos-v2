/**
 * What a time entry BILLS, as opposed to what it logged.
 *
 * The rule is one line and it exists in one place on purpose: `billedHours` is
 * null for the ordinary entry, meaning "bill what was logged". Re-deriving that
 * at each call site is how a report ends up summing raw `hours` while an invoice
 * sums the override, and nobody notices until the two disagree in front of a
 * client.
 *
 * An explicit 0 is NOT the same as null. "Worked, not billed" is a decision
 * somebody took; null is the absence of one. `?? ` keeps them apart, where `||`
 * would quietly turn a deliberate zero back into the logged figure.
 */
export function billedHoursOf(entry: { hours: number; billedHours: number | null }): number {
  return entry.billedHours ?? entry.hours;
}

/** Billed minus logged: negative is written down, positive written up. */
export function billingVariance(entry: { hours: number; billedHours: number | null }): number {
  return billedHoursOf(entry) - entry.hours;
}

/** Whether somebody has taken a billing decision that differs from the log. */
export function isWrittenDown(entry: { hours: number; billedHours: number | null }): boolean {
  return entry.billedHours !== null && entry.billedHours < entry.hours;
}
