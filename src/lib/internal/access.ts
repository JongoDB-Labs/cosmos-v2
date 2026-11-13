/**
 * True when `email` is on the INTERNAL_ADMINS list. This is only the list
 * lookup. Whether a SIGNED-IN USER is a system admin is `isSystemAdmin`, which
 * every access decision must use: an address alone proves nothing about who
 * signed in, or how.
 */
export function isInternalAdmin(
  email: string,
  envValue: string | undefined,
): boolean {
  if (!envValue) return false;
  const allowed = envValue
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.toLowerCase());
}

/** What the platform knows about a signed-in user's session and the
 *  credentials on their account. Every field is required so no caller can leave
 *  one out by accident; `getCurrentUser()` returns all of them. */
export type SessionCredentialSubject = {
  /** The account was created by an organization's IdP (SSO JIT). */
  ssoProvisioned: boolean;
  /** How this session signed in: "google" | "microsoft" | "password" | "oidc"
   *  (an organization's SSO), or null for a session minted before the method was
   *  recorded. */
  authMethod: string | null;
  /** The IdP connection the session came through, if any. */
  idpConnId: string | null;
  /** The account has a bound Google subject. */
  googleBound: boolean;
  /** The account has a bound Microsoft (tenant, object) identity. */
  microsoftBound: boolean;
  /** The account's password may have been set from an SSO session. */
  passwordUntrusted: boolean;
};

export type SystemAdminSubject = SessionCredentialSubject & { email: string };

/**
 * Did this session sign in with a credential that vouches, first-hand, for the
 * account's address?
 *
 *  - Google: the account's bound Google subject. Google sign-in links an
 *    address only when Google marks it verified.
 *  - Microsoft: the account's bound (tenant, object) identity. Microsoft sign-in
 *    links an address only with `xms_edov`, or a member's sign-in name on a
 *    domain the operator trusts, and never onto a Google-bound or platform-admin
 *    account (those connect Microsoft explicitly, see connectSignInRefusal).
 *  - Password: a password no SSO session could have set. Passwords come from an
 *    emailed temporary password, an emailed reset, the operator's bootstrap, or
 *    a first-party session; `passwordUntrusted` marks the ones that may not.
 *
 * Never, whatever the session: an account an organization's IdP created (its
 * address came from that IdP's claim, and it stays IdP-made after it gains other
 * credentials), an SSO session, or a session minted before the method was
 * recorded (it may have come from a sign-in that matched an unverified address;
 * signing in again mints one that counts).
 *
 * The check is on the SESSION's credential, not on what the account holds: an
 * admin's Google-bound account could also carry a password an IdP set through
 * an SSO session, and that password's session must not count.
 */
export function sessionVouchesForAddress(user: SessionCredentialSubject): boolean {
  if (user.ssoProvisioned) return false;
  if (user.authMethod === "oidc" || user.idpConnId != null) return false;
  switch (user.authMethod) {
    case "google":
      return user.googleBound;
    case "microsoft":
      return user.microsoftBound;
    case "password":
      return !user.passwordUntrusted;
    default:
      return false;
  }
}

/**
 * May this session set the account's FIRST password? Only a Google or Microsoft
 * session that vouches for the address. A password is a credential the IdP can't
 * revoke, so an SSO session (or an IdP-made account) must not be able to add one,
 * and a session from before methods were recorded must sign in again first.
 */
export function canSetFirstPassword(user: SessionCredentialSubject): boolean {
  return (
    (user.authMethod === "google" || user.authMethod === "microsoft") &&
    sessionVouchesForAddress(user)
  );
}

/**
 * Why this session may not connect another sign-in method (Google, Microsoft)
 * to the account, from Profile, Sign-in methods, or null when it may. Each value
 * is also the outcome code the Sign-in methods page explains in plain words.
 *
 * The connected identity signs in to this account from then on, so the session
 * must be the account holder's own, for every account and not only a platform
 * admin's:
 *  - `connect_not_allowed`: an SSO session (an org's IdP opens its own org, and
 *    must not plant a first-party login that reaches the account's other orgs),
 *    or an account an IdP created;
 *  - `connect_password_untrusted`: a password session whose password an SSO
 *    session could have set (an emailed reset makes it trusted again);
 *  - `connect_sign_in_again`: any other session that doesn't vouch for the
 *    address (sessionVouchesForAddress), above all one minted before sessions
 *    recorded their method. Such a session may have come from a sign-in that
 *    matched an unverified address, and connecting would turn that one sign-in
 *    into a permanent login. Signing in again mints one that counts.
 */
export type ConnectRefusal = "connect_not_allowed" | "connect_password_untrusted" | "connect_sign_in_again";

export function connectSignInRefusal(user: SessionCredentialSubject): ConnectRefusal | null {
  if (user.ssoProvisioned) return "connect_not_allowed";
  if (user.authMethod === "oidc" || user.idpConnId != null) return "connect_not_allowed";
  if (sessionVouchesForAddress(user)) return null;
  if (user.authMethod === "password" && user.passwordUntrusted) return "connect_password_untrusted";
  return "connect_sign_in_again";
}

/**
 * Is this signed-in user a system (instance) admin? Only when the address is on
 * INTERNAL_ADMINS AND this session signed in with a first-party credential that
 * vouches for that address (`sessionVouchesForAddress`).
 */
export function isSystemAdmin(
  user: SystemAdminSubject | null | undefined,
  envValue: string | undefined = process.env.INTERNAL_ADMINS,
): boolean {
  if (!user) return false;
  if (!sessionVouchesForAddress(user)) return false;
  return isInternalAdmin(user.email, envValue);
}
