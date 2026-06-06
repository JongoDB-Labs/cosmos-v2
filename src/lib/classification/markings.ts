// src/lib/classification/markings.ts
//
// Deterministic, high-precision detector for controlled-information MARKINGS.
// This is the "detector, not declassifier" tripwire: it may only turn an
// otherwise-exposable value into a withheld one — never the reverse. It catches
// MARKED CUI (banners/portion marks); UNMARKED CUI needs the future ML classifier.

// Word-boundary, case-insensitive. Anchored to real markings to avoid matching
// ordinary substrings ('acuity', 'foul', 'fournier'). Extend as new markings appear.
const MARKING_RE = new RegExp(
  [
    "\\bCUI\\b",                               // CUI token / CUI//SP-... banner
    "\\bFOUO\\b",                              // For Official Use Only
    "\\bNOFORN\\b",                            // Not Releasable to Foreign Nationals
    "//\\s*(SP-|FED|PRVCY|PROPIN|FOUO|NF)",    // portion / dissemination control marks
    "CONTROLLED\\s+UNCLASSIFIED\\s+INFORMATION",
    "\\bLES\\b",                               // Law Enforcement Sensitive
  ].join("|"),
  "i",
);

/** True if `value` (string, or any value stringified) contains a controlled marking. */
export function detectMarkings(value: unknown): boolean {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  } catch {
    return true; // unserializable (circular/BigInt) ⇒ fail-closed: treat as marked.
  }
  return MARKING_RE.test(s);
}
