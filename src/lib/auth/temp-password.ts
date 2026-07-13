import { randomInt } from "node:crypto";

/**
 * Cryptographically-strong temporary password for email/password invites.
 *
 * The admin never picks this — it is generated here, emailed to the invitee, and
 * immediately force-rotated at first sign-in (User.mustChangePassword). It is
 * NEVER logged and NEVER persisted in plaintext (only the scrypt hash is stored).
 *
 * Alphabet is the base58-style unambiguous set: no 0/O, 1/l/I look-alikes and no
 * shell-hostile punctuation, so a human can transcribe it from the email if the
 * copy button fails. 22 symbols over a 58-char alphabet ≈ 128 bits of entropy —
 * far above the 12-char policy floor.
 */
export const TEMP_PASSWORD_ALPHABET =
  "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const LENGTH = 22;

export function generateTempPassword(length = LENGTH): string {
  const alphabet = TEMP_PASSWORD_ALPHABET;
  let out = "";
  for (let i = 0; i < length; i++) {
    // randomInt is rejection-sampled and unbiased across [0, alphabet.length).
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}
