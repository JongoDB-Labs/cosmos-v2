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
    "\\bCUI\\b",                                  // CUI token / CUI//SP-... banner
    "\\bFOUO\\b",                                 // For Official Use Only
    "\\bNOFORN\\b",                               // Not Releasable to Foreign Nationals
    "//\\s*(SP-|FED|PRVCY|PROPIN|FOUO|NF|LES)",   // portion / dissemination control marks
    "\\(LES\\)",                                  // Law Enforcement Sensitive (parenthetical mark)
    "CONTROLLED\\s+UNCLASSIFIED\\s+INFORMATION",
    "LAW\\s+ENFORCEMENT\\s+SENSITIVE",            // LES, spelled out
    // NOTE: bare "\\bLES\\b" was intentionally REMOVED — it false-positives on the
    // common name "Les" / French "les" (a safe over-withhold, but it visibly breaks
    // the agent) while MISSING the spelled-out marking. LES is now caught only as a
    // real control mark (//LES, (LES), or "Law Enforcement Sensitive").
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
