/** A dotted type reads as its last word — `x.y.past_due` becomes "Past due" —
 *  so a new kind needs no lookup table, and no table can go stale. */
export function kindLabel(type: string): string {
  const leaf = type.split(".").pop() ?? type;
  const words = leaf.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
