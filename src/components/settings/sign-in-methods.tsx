"use client";

import { useSearchParams } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { GoogleLogo, MicrosoftLogo } from "@/components/brand/provider-logos";
import { cn } from "@/lib/utils";
import type { ConnectRefusal } from "@/lib/internal/access";

export interface SignInMethodsProps {
  google: { available: boolean; connected: boolean };
  microsoft: { available: boolean; connected: boolean };
  /** Why this session may not connect a method, or null when it may
   *  (lib/internal/access connectSignInRefusal). */
  connectRefusal: ConnectRefusal | null;
  /** Where the connect round trip comes back to (this page). */
  returnTo: string;
}

const PROVIDER_NAME = { google: "Google", microsoft: "Microsoft" } as const;

/** The outcome codes the connect callbacks return with, in plain words. */
function errorText(code: string): string {
  switch (code) {
    case "identity_conflict":
      return "That account is already connected to a different account here.";
    case "already_connected":
      return "Your account is already connected to a different account from that provider.";
    case "session_changed":
      return "You signed out or switched accounts before connecting finished. Try again.";
    case "connect_not_allowed":
      return "To connect a sign-in method, sign in again with Google, Microsoft or your password, then connect it here.";
    case "connect_sign_in_again":
      return "To connect a sign-in method, sign out and sign in again, then connect it here.";
    case "connect_password_untrusted":
      return "Your password was set during a single sign-on session, so it can't be used to connect a sign-in method. Reset your password from the sign-in page, or sign in with Google or Microsoft, then connect it here.";
    case "ms_wrong_tenant":
      return "That Microsoft account isn't from the organization this site accepts.";
    case "not_configured":
      return "That sign-in method isn't set up on this site.";
    case "rate_limited":
      return "Too many attempts. Wait a moment and try again.";
    default:
      return "Couldn't connect that sign-in method. Try again.";
  }
}

/**
 * Profile → Sign-in methods. Connects Google or Microsoft to this account by
 * the person's own request: the round trip binds that provider account to the
 * account signed in here, whatever email address it has. It is the way in for
 * someone whose Microsoft sign-in can't be linked by email, and the only way a
 * Google-bound or platform-admin account gains Microsoft.
 */
export function SignInMethods({ google, microsoft, connectRefusal, returnTo }: SignInMethodsProps) {
  const params = useSearchParams();
  const connected = params.get("connected");
  const error = params.get("connect_error");

  const rows = (
    [
      ["google", google, GoogleLogo],
      ["microsoft", microsoft, MicrosoftLogo],
    ] as const
  ).filter(([, state]) => state.available || state.connected);

  return (
    <section aria-labelledby="sign-in-methods-heading" className="space-y-3">
      <h2 id="sign-in-methods-heading" className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
        Sign-in methods
      </h2>
      {connected === "google" || connected === "microsoft" ? (
        <p role="status" className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]">
          {PROVIDER_NAME[connected]} is connected. You can now sign in with it.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]">
          {errorText(error)}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No other sign-in methods are set up on this site.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {rows.map(([key, state, Logo]) => (
            <li key={key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <span className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
                <Logo className="h-4 w-4" />
                {PROVIDER_NAME[key]}
              </span>
              {state.connected ? (
                <span className="text-sm text-[var(--text-muted)]">Connected</span>
              ) : (
                <form method="post" action={`/api/auth/${key}/connect`}>
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <button
                    type="submit"
                    disabled={connectRefusal !== null}
                    className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
                  >
                    Connect {PROVIDER_NAME[key]}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {connectRefusal && connectRefusal !== error && rows.some(([, state]) => !state.connected) ? (
        <p className="text-xs text-[var(--text-muted)]">{errorText(connectRefusal)}</p>
      ) : null}
    </section>
  );
}
