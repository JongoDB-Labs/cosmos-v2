# Sign-in identity: how accounts are found, and what to set up

This runbook is for the instance operator. It covers how a sign-in finds an
account, what to configure before deploying, and the one admin action that goes
with it.

## How a sign-in finds an account

- **Google** binds an account to the Google subject (`sub`). The address finds
  an account only on its first Google sign-in, and only when Google marks it
  verified.
- **Microsoft** binds an account to the Entra tenant id and object id. The
  address finds or creates an account on a first Microsoft sign-in only when
  Microsoft vouches for it:
  - the `email` claim, when the `xms_edov` claim says the domain's owner is
    verified. On its own, `email` is the directory `mail` attribute, which any
    tenant admin can set to any address, so it never counts alone (pinned tenant
    or not);
  - a member account's sign-in name (`preferred_username`), when its domain is
    listed in `MICROSOFT_TRUSTED_DOMAINS`. Guests and personal Microsoft accounts
    never count.
  Microsoft never links by address onto an account that already has Google, or
  onto a platform admin's address. Those people connect Microsoft from their
  profile.
- **An organization's single sign-on (SSO)** binds an account to the connection
  and the IdP's subject. Its address counts only when the IdP marks it verified
  AND its domain is in the org's allowed domains (Settings → Security). An org
  that lists no domains is trusted for no address: a new account gets a
  placeholder address. SSO links an existing account only when the org already
  holds it (a member) or has invited that address.
- **Connect from the profile.** Profile → Sign-in methods → Connect Google or
  Connect Microsoft binds that provider identity to the signed-in account,
  whatever address the provider has. It needs a session that vouches for the
  account's address, on every account: one signed in through the account's bound
  Google or Microsoft identity, or with a password no SSO session could have
  set. Never an SSO session. A session from before sessions recorded their
  sign-in method is asked to sign in again first. A password set during an SSO
  session is asked to reset it from the sign-in page, or to sign in with Google
  or Microsoft.

## What a session can open

- A session from an org's SSO opens that org only. Every other org refuses it
  and asks the person to sign in another way.
- A GOV org whose SSO connection is enabled and enforced opens only to its own
  SSO sessions. Google, Microsoft and password sessions still sign in, and still
  open the person's other orgs. A platform admin's own first-party session is the
  break-glass.

## Before deploying

1. **Microsoft.** Choose one, or both:
   - In the Entra app registration, Token configuration, add the optional claims
     `email` and `xms_edov` to the ID token.
   - Pin the tenant in Admin → Sign-in providers (its directory ID or domain),
     and set `MICROSOFT_TRUSTED_DOMAINS` to your own verified domains.
   Without either, a first Microsoft sign-in can't find an existing account. The
   person sees "Your administrator needs to finish setting up Microsoft sign-in",
   and can still sign in another way and connect Microsoft from their profile.
   The server logs a warning at start while this is unset, and another while the
   tenant accepts any Microsoft tenant.
2. **SSO.** Each org that uses SSO should list its domains in Settings →
   Security → allowed domains. Without them the IdP can still sign people in,
   but it can't link to an existing account or give a new one a real address.

## Accounts made by single sign-on

`User.ssoProvisioned` marks an account an org's SSO created. Such an account is
never a platform admin, and Google or Microsoft never sign in to it by address.

The migration that added the mark flagged older accounts by evidence: an SSO
binding made within a minute of the account, and no Google identity, Microsoft
identity or password. It can't see invitations that were accepted, because
accepting one deletes it and leaves no record. So an account someone made by
accepting an email invitation, and then linked to SSO within that minute with no
other credential, is flagged. To clear the mark when you know the person made
the account: Admin → Sign-in providers → Accounts made by single sign-on →
Clear mark. Each clear is written to the audit log of every org the account
belongs to (and of the IdP's org).

## Known limits

- An org with no allowed domains gives every new SSO account a placeholder
  address, so those people can't be emailed at their real address. Listing the
  domain later does not change accounts already made.
- Sessions from before sessions recorded their sign-in method are not ended by
  this change, because ending them would sign everyone out. They can't connect a
  sign-in method, add a first password or count as a platform admin, and they
  expire as usual. On a deployment that had Microsoft sign-in turned on before
  this change, one of them could have come from the old sign-in that matched an
  address. There, end them yourself: delete the rows in `sessions` whose
  `auth_method` is empty, and those people sign in again.
