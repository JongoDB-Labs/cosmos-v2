"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CosmosMark } from "@/components/brand/cosmos-mark";
import { Starfield } from "@/components/brand/starfield";

const ERROR_MESSAGES: Record<string, string> = {
  not_allowed: "Your email is not yet approved. Ask an admin to add it.",
  invalid_state: "Sign-in expired. Please try again.",
  auth_failed: "Sign-in failed. Please try again.",
  rate_limited: "Too many sign-in attempts. Please wait a moment and try again.",
  sso_not_configured: "Single sign-on is not configured for this organization.",
  sso_discovery_failed:
    "Could not reach your identity provider. Please try again shortly.",
  sso_aal_required:
    "Your identity provider must assert a stronger authentication method (MFA / phishing-resistant) for this organization.",
  sso_no_account: "No account found. Ask an admin to invite you first.",
  // Returned by the Google callback when a gov org enforces SSO-only.
  sso_enforced: "This organization requires single sign-on. Google is disabled.",
};

type SsoStatus = { enabled: boolean; enforced: boolean };

function LoginInner() {
  const params = useSearchParams();
  const error = params.get("error");
  const message = error ? (ERROR_MESSAGES[error] ?? "Sign-in failed.") : null;
  // Org slug entrypoint: /login?org=<slug>. Without it we can't resolve which
  // tenant's SSO connection to offer, so we fall back to Google only.
  const orgSlug = params.get("org");
  const [submitting, setSubmitting] = useState(false);

  // SSO discovery: when an org slug is present, ask whether that org offers SSO
  // and whether it's enforced (gov SSO-only → hide Google). null = unknown/loading.
  const [sso, setSso] = useState<SsoStatus | null>(null);
  useEffect(() => {
    // No org context → nothing to discover; leave `sso` null (Google-only).
    if (!orgSlug) return;
    let cancelled = false;
    fetch(`/api/auth/sso/${encodeURIComponent(orgSlug)}/status`)
      .then((r) => (r.ok ? (r.json() as Promise<SsoStatus>) : null))
      .then((data) => {
        if (!cancelled) setSso(data ?? { enabled: false, enforced: false });
      })
      .catch(() => {
        if (!cancelled) setSso({ enabled: false, enforced: false });
      });
    return () => {
      cancelled = true;
    };
  }, [orgSlug]);

  const ssoEnabled = sso?.enabled ?? false;
  // Hide Google only once we KNOW the org enforces SSO. While discovery is in
  // flight we keep Google visible (fail-open for usability; the callback guard
  // is the real enforcement boundary).
  const hideGoogle = sso?.enforced === true;

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4">
      <Starfield className="absolute inset-0 h-full w-full" />
      <div className="relative z-10 w-full max-w-sm rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-8 shadow-[var(--shadow-soft)]">
        <div className="flex flex-col items-center text-center">
          <CosmosMark size="lg" />
          <h1 className="mt-4 text-2xl font-bold tracking-tight">COSMOS</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Enterprise Project Management
          </p>
        </div>

        {message && (
          <div className="mt-6 rounded-md border border-[var(--status-critical)]/30 bg-[var(--status-critical)]/10 px-3 py-2 text-sm text-[var(--status-critical)]">
            {message}
          </div>
        )}

        {ssoEnabled && orgSlug && (
          <Button
            size="lg"
            className="mt-6 w-full"
            disabled={submitting}
            onClick={() => {
              setSubmitting(true);
              window.location.href = `/api/auth/sso/${encodeURIComponent(
                orgSlug,
              )}/login`;
            }}
          >
            {submitting ? "Redirecting…" : "Sign in with SSO"}
          </Button>
        )}

        {!hideGoogle && (
          <Button
            size="lg"
            // When SSO is also offered, the Google button is the secondary option.
            variant={ssoEnabled && orgSlug ? "secondary" : "default"}
            className="mt-3 w-full"
            disabled={submitting}
            onClick={() => {
              setSubmitting(true);
              window.location.href = "/api/auth/google";
            }}
          >
            {submitting ? "Redirecting to Google…" : "Sign in with Google"}
          </Button>
        )}

        {hideGoogle && (
          <p className="mt-3 text-center text-xs text-[var(--text-muted)]">
            This organization requires single sign-on.
          </p>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
