/**
 * The public-repo client-identity pattern — single source of truth.
 *
 * cosmos-v2 is a PUBLIC repository; the neutral core must never name a client or
 * private vertical. Two things enforce that, and they MUST agree, so they share
 * this module rather than each carrying a copy:
 *
 *   - `src/lib/product/__tests__/no-client-identity.arch.test.ts` scans tracked
 *     FILE CONTENT in CI.
 *   - `scripts/check-commit-msg-identity.mjs` scans the COMMIT MESSAGE, via the
 *     commit-msg hook, before the commit exists.
 *
 * The message check exists because file scanning has a blind spot the arch test
 * names in its own comments: a customer's name reached this repo "in commit
 * messages and PR descriptions this gate does not read". That has now happened
 * more than once. A message is not a tracked file, so nothing scanned it — and
 * once pushed, the only remedies are a force-push (if nobody has pulled) or a
 * history rewrite. Blocking at commit time is the cheap moment.
 *
 * Tokens are stored base64-encoded so this file never contains the literal
 * identifiers — otherwise a client-identity scrub, or a history rewrite of those
 * very tokens, would corrupt the pattern that detects them. Decode the arrays to
 * audit the list. `word` entries match whole-word (\b…\b); the rest as
 * substrings. Case-insensitive throughout.
 *
 * If either check flags a legitimate use, NEUTRALIZE the wording — do not add an
 * allowlist.
 */

/** Substring matches. Long enough that a chance hit inside base64 is negligible. */
const B64_SUBSTR = [
  "ZGVmY29u", "cG9udGlz", "xJJTTw==", "xJNzbw==",
  "aW52aWN0dXM=", "Y29zbW9zLWFzc2VtYmx5", "ZmlnaHRpbmdzbWFydA==", "ZGVmY29uYWk=",
  // A customer's name, and a real person's — both had reached the public repo.
  // A space or an unusual letter run makes a false positive vanishingly unlikely.
  "bWFyaW5lIGNvcnBz", "cmFubmFiYXJnYXI=",
];

/** Whole-word ONLY — short enough to appear inside base64 by chance. A
 *  package-lock integrity hash carries the letters of one of these, so a
 *  substring match here would fail the build on a coincidence. */
const B64_WORD = ["RVNP", "VklUTA==", "bWNlbg==", "dXNtYw=="];

const dec = (s) => Buffer.from(s, "base64").toString("utf8");

/** Case-insensitive regex matching any forbidden client/vertical identifier. */
export const FORBIDDEN = new RegExp(
  [...B64_SUBSTR.map(dec), ...B64_WORD.map((w) => `\\b${dec(w)}\\b`)].join("|"),
  "i",
);

/**
 * Files excluded from CONTENT scanning: the pattern machinery itself. Neither
 * currently self-matches (base64 does not contain its own plaintext), but they
 * are excluded so that stays true if anyone ever adds an illustrative literal.
 */
export const PATTERN_FILES = [
  "scripts/client-identity.mjs",
  "scripts/check-commit-msg-identity.mjs",
  "src/lib/product/__tests__/no-client-identity.arch.test.ts",
];
