/**
 * The page a password-reset email links to, spelled once. Both routes that
 * email a reset link build it with resetPasswordUrl, and the proxy reads
 * RESET_PASSWORD_PATH to let a signed-out visit through to the page. They are
 * one constant so they can't drift apart: when they did, the link worked only
 * for someone already signed in. See reset-link.arch.test.ts.
 */
export const RESET_PASSWORD_PATH = "/reset-password";

export function resetPasswordUrl(origin: string, token: string): string {
  return `${origin}${RESET_PASSWORD_PATH}?token=${encodeURIComponent(token)}`;
}
