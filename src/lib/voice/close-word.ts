// The voice "close word": the spoken phrase that ends a dictated assistant
// message and sends it (reference UX: the okr-dashboard chat panel's
// `/[,.]?\s*send\s+it[.!]?\s*$/i`). Users customize the phrase in Preferences →
// Voice; this module builds the matcher from ANY phrase safely (regex-escaped,
// whitespace-flexible between words, tolerant of the recognizer's trailing
// punctuation). PURE — fully unit-tested.

export const DEFAULT_CLOSE_WORD = "send it";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Build the end-of-utterance matcher for a close phrase. Case-insensitive,
 *  allows leading punctuation/space before the phrase, any whitespace run
 *  between its words, and trailing punctuation the recognizer may add. Falls
 *  back to the default phrase when blank. */
export function buildCloseWordRegex(phrase: string | null | undefined): RegExp {
  const words = (phrase ?? "").trim().split(/\s+/).filter(Boolean);
  const effective = words.length ? words : DEFAULT_CLOSE_WORD.split(" ");
  const body = effective.map(escapeRegExp).join("\\s+");
  // Boundary before the phrase: start-of-utterance, whitespace, or punctuation —
  // so "…resend it" never matches a "send it" close word.
  return new RegExp(`(?:^|[\\s,.!?])\\s*${body}[.!?]*\\s*$`, "i");
}

/** If the utterance ends with the close phrase, return the message with the
 *  phrase stripped (may be "" for a bare close word); otherwise null. */
export function matchCloseWord(utterance: string, regex: RegExp): string | null {
  if (!regex.test(utterance)) return null;
  return utterance.replace(regex, "").trim();
}
