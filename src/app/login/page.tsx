"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BrandMark } from "@/components/brand/brand-mark";
import { Starfield } from "@/components/brand/starfield";
import { GoogleLogo, MicrosoftLogo } from "@/components/brand/provider-logos";
import { useBrand } from "@/components/providers/brand-provider";
import { getSkinPreset, DEFAULT_SKIN_ID } from "@/lib/theme/skins";

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
  ms_not_configured: "Microsoft sign-in isn't configured yet.",
};

type SsoStatus = { enabled: boolean; enforced: boolean };

function LoginInner() {
  const brand = useBrand();
  const params = useSearchParams();
  const error = params.get("error");
  const message = error ? (ERROR_MESSAGES[error] ?? "Sign-in failed.") : null;
  // Cookie-derived values (remembered org, skin motif) MUST NOT be read during
  // render: the server has no cookies, so `document.cookie` reads diverge from
  // the client and fail hydration (React #418 — e.g. the <Starfield/> motif
  // renders on the server but not the client, or vice versa), which breaks the
  // page's interactivity (the OAuth buttons stop working). Gate every cookie
  // read behind a post-mount flag so the first render matches the server, then
  // reconcile after hydration.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);
  // Org slug entrypoint: /login?org=<slug>, falling back to the remembered-org
  // cookie set on the user's last successful login (read only after mount).
  const orgFromQuery = params.get("org");
  const cookieOrgMatch = mounted
    ? document.cookie.match(/(^| )org=([^;]+)/)
    : null;
  const orgSlug =
    orgFromQuery ??
    (cookieOrgMatch?.[2] ? decodeURIComponent(cookieOrgMatch[2]) : null);
  // Which provider the user clicked — only that button shows "Redirecting…".
  // (A single boolean flipped every provider's label to loading at once.)
  const [submitting, setSubmitting] = useState<
    "sso" | "google" | "microsoft" | null
  >(null);
  const anySubmitting = submitting !== null;

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

  // Microsoft (Entra) sign-in is shown only when the server has the Entra app
  // credentials configured. null = still probing.
  const [msEnabled, setMsEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/microsoft/status")
      .then((r) => (r.ok ? (r.json() as Promise<{ configured: boolean }>) : null))
      .then((d) => {
        if (!cancelled) setMsEnabled(Boolean(d?.configured));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Pre-login brand: when an org is known, fetch its public branding and apply
  // the org's default skin (unless the user already has a skin cookie). null =
  // unknown/loading → deployment default.
  type OrgBrand = {
    brandName: string | null;
    logoUrl: string | null;
    tagline: string | null;
    agentName: string | null;
    defaultSkinId: string | null;
  };
  const [orgBrand, setOrgBrand] = useState<OrgBrand | null>(null);
  useEffect(() => {
    if (!orgSlug) return;
    let cancelled = false;
    fetch(`/api/orgs/${encodeURIComponent(orgSlug)}/brand`)
      .then((r) => (r.ok ? (r.json() as Promise<OrgBrand>) : null))
      .then((data) => {
        if (cancelled || !data) return;
        setOrgBrand(data);
        // Apply the org default skin only if the visitor has no skin cookie.
        if (data.defaultSkinId && !document.cookie.match(/(^| )skin=/)) {
          const d = document.documentElement;
          d.className = d.className.replace(/\bskin-[\w-]+\b/g, "").trim();
          d.classList.add(`skin-${data.defaultSkinId}`);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orgSlug]);

  const ssoEnabled = sso?.enabled ?? false;
  // Hide Google only once we KNOW the org enforces SSO. While discovery is in
  // flight we keep Google visible (fail-open for usability; the callback guard
  // is the real enforcement boundary).
  const hideGoogle = sso?.enforced === true;

  const brandName = orgBrand?.brandName ?? brand.name;
  const brandTagline = orgBrand?.tagline ?? brand.tagline;
  const brandLogo = orgBrand?.logoUrl ?? null;

  // Skin motif drives whether <Starfield/> renders — so it must be identical on
  // the server and the first client render. Read the skin cookie only after
  // mount (see the `mounted` note above); the pre-paint script in the root
  // layout already applies the correct CSS theme, so this only reconciles the
  // React-rendered motif element post-hydration.
  const cookieSkin = mounted
    ? document.cookie.match(/(^| )skin=([^;]+)/)?.[2]
    : undefined;
  const activeSkin =
    cookieSkin ||
    orgBrand?.defaultSkinId ||
    brand.defaultSkinId ||
    DEFAULT_SKIN_ID;
  const motif = getSkinPreset(activeSkin).motif;

  // ── Email + password (+ forced first-login onboarding + TOTP) sign-in ──
  const [showPw, setShowPw] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<
    | "creds"
    | "change_password"
    | "enroll_mfa"
    | "mfa"
    | "recovery"
    | "forgot"
    | "forgot_sent"
  >("creds");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  // Forced first-login state.
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [enroll, setEnroll] = useState<{ secret: string; qr: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  type LoginResponse = {
    ok?: boolean;
    mfaRequired?: boolean;
    next?: "change_password" | "enroll_mfa" | "mfa";
    error?: string;
    recoveryCodes?: string[];
  };

  // Begin forced TOTP enrollment: fetch a pending secret + render its QR.
  async function beginMfaEnroll(): Promise<boolean> {
    const res = await fetch("/api/auth/password/first-login/mfa-setup", {
      method: "POST",
    });
    const data = (await res.json().catch(() => ({}))) as {
      secret?: string;
      otpauthUri?: string;
      error?: string;
    };
    if (!res.ok || !data.otpauthUri || !data.secret) {
      setPwError(data.error ?? "Couldn't start two-factor setup.");
      return false;
    }
    const QR = await import("qrcode");
    const qr = await QR.toDataURL(data.otpauthUri, { width: 200, margin: 1 });
    setEnroll({ secret: data.secret, qr });
    setPhase("enroll_mfa");
    return true;
  }

  // Route to the next step the server says the invitee owes (or finish).
  async function applyNext(data: LoginResponse): Promise<void> {
    if (data.next === "change_password") {
      setPassword("");
      setPhase("change_password");
      return;
    }
    if (data.next === "enroll_mfa") {
      setPassword("");
      await beginMfaEnroll();
      return;
    }
    if (data.next === "mfa" || data.mfaRequired) {
      setPassword("");
      setPhase("mfa");
      return;
    }
    if (data.ok) window.location.href = "/";
  }

  async function submitCreds(e?: React.FormEvent) {
    e?.preventDefault();
    setPwBusy(true);
    setPwError(null);
    try {
      const res = await fetch("/api/auth/password/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = (await res.json().catch(() => ({}))) as LoginResponse;
      if (!res.ok && !data.next && !data.mfaRequired) {
        setPwError(data.error ?? "Invalid email or password.");
        return;
      }
      await applyNext(data);
    } catch {
      setPwError("Something went wrong. Please try again.");
    } finally {
      setPwBusy(false);
    }
  }

  // Self-service "forgot password": request a reset email for an email/password
  // account. The endpoint always responds OK (it never reveals whether the email
  // exists), so on any non-error response we show the same neutral confirmation.
  async function submitForgot(e?: React.FormEvent) {
    e?.preventDefault();
    setPwBusy(true);
    setPwError(null);
    try {
      await fetch("/api/auth/password/reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          ...(orgSlug ? { orgSlug } : {}),
        }),
      });
      setPassword("");
      setPhase("forgot_sent");
    } catch {
      // Even on a network error, don't leak anything — show the neutral screen.
      setPhase("forgot_sent");
    } finally {
      setPwBusy(false);
    }
  }

  async function submitChangePassword(e?: React.FormEvent) {
    e?.preventDefault();
    if (newPassword !== confirmPassword) {
      setPwError("Passwords don't match.");
      return;
    }
    setPwBusy(true);
    setPwError(null);
    try {
      const res = await fetch("/api/auth/password/first-login/change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword }),
      });
      const data = (await res.json().catch(() => ({}))) as LoginResponse;
      if (!res.ok && !data.next && !data.ok) {
        setPwError(data.error ?? "Couldn't set your password.");
        return;
      }
      setNewPassword("");
      setConfirmPassword("");
      await applyNext(data);
    } catch {
      setPwError("Something went wrong. Please try again.");
    } finally {
      setPwBusy(false);
    }
  }

  async function submitEnrollMfa(e?: React.FormEvent) {
    e?.preventDefault();
    setPwBusy(true);
    setPwError(null);
    try {
      const res = await fetch("/api/auth/password/first-login/mfa-enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as LoginResponse;
      if (!res.ok || !data.ok) {
        setPwError(data.error ?? "That code didn't match. Try again.");
        return;
      }
      setCode("");
      // Show the one-time recovery codes before entering the app.
      if (data.recoveryCodes && data.recoveryCodes.length > 0) {
        setRecoveryCodes(data.recoveryCodes);
        setPhase("recovery");
      } else {
        window.location.href = "/";
      }
    } catch {
      setPwError("Something went wrong. Please try again.");
    } finally {
      setPwBusy(false);
    }
  }

  async function submitMfa(e?: React.FormEvent) {
    e?.preventDefault();
    setPwBusy(true);
    setPwError(null);
    try {
      const res = await fetch("/api/auth/password/mfa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        const msg = data.error ?? "Invalid code.";
        // The pending token expired — drop back to email + password so the user
        // can restart rather than being stuck on a dead code field.
        if (/expired|start over/i.test(msg)) {
          setPhase("creds");
          setCode("");
        }
        setPwError(msg);
        return;
      }
      window.location.href = "/";
    } catch {
      setPwError("Something went wrong. Please try again.");
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4">
      {motif === "starfield" && <Starfield className="absolute inset-0 h-full w-full" />}
      <div className="relative z-10 w-full max-w-sm rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-8 shadow-[var(--shadow-soft)]">
        <div className="flex flex-col items-center text-center">
          {brandLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={brandLogo}
              alt={brandName}
              className="h-12 w-12 rounded object-contain"
            />
          ) : (
            <BrandMark size="lg" />
          )}
          <h1 className="mt-4 text-2xl font-bold tracking-tight">
            {brandName}
          </h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            {brandTagline}
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
            disabled={anySubmitting}
            onClick={() => {
              setSubmitting("sso");
              window.location.href = `/api/auth/sso/${encodeURIComponent(
                orgSlug,
              )}/login`;
            }}
          >
            {submitting === "sso" ? "Redirecting…" : "Sign in with SSO"}
          </Button>
        )}

        {!hideGoogle && (
          <Button
            size="lg"
            // When SSO is also offered, the Google button is the secondary option.
            variant={ssoEnabled && orgSlug ? "secondary" : "default"}
            className="mt-3 w-full"
            disabled={anySubmitting}
            onClick={() => {
              setSubmitting("google");
              window.location.href = "/api/auth/google";
            }}
          >
            <GoogleLogo className="h-4 w-4" />
            {submitting === "google" ? "Redirecting to Google…" : "Sign in with Google"}
          </Button>
        )}

        {!hideGoogle && msEnabled && (
          <Button
            size="lg"
            variant="secondary"
            className="mt-3 w-full"
            disabled={anySubmitting}
            onClick={() => {
              setSubmitting("microsoft");
              window.location.href = "/api/auth/microsoft";
            }}
          >
            <MicrosoftLogo className="h-4 w-4" />
            {submitting === "microsoft" ? "Redirecting to Microsoft…" : "Sign in with Microsoft"}
          </Button>
        )}

        {!hideGoogle && (
          <div className="mt-4">
            <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              <span className="h-px flex-1 bg-[var(--border)]" />
              or
              <span className="h-px flex-1 bg-[var(--border)]" />
            </div>

            {!showPw ? (
              <Button
                variant="secondary"
                className="mt-3 w-full"
                onClick={() => setShowPw(true)}
              >
                Sign in with email &amp; password
              </Button>
            ) : phase === "creds" ? (
              // Submission is JS-controlled (type="button" + onClick, Enter via
              // onKeyDown) — no native <form> submit, so nothing can POST to
              // /login (which 405s, since it's a page route).
              <div className="mt-3 space-y-2">
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void submitCreds()}
                  required
                />
                <Input
                  type="password"
                  autoComplete="current-password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void submitCreds()}
                  required
                />
                {pwError && (
                  <p className="text-xs text-[var(--status-critical)]">{pwError}</p>
                )}
                <Button
                  type="button"
                  className="w-full"
                  disabled={pwBusy}
                  onClick={() => void submitCreds()}
                >
                  {pwBusy ? "Signing in…" : "Sign in"}
                </Button>
                <button
                  type="button"
                  className="w-full text-center text-xs text-[var(--text-muted)] underline-offset-2 hover:underline"
                  onClick={() => {
                    setPwError(null);
                    setPassword("");
                    setPhase("forgot");
                  }}
                >
                  Forgot password?
                </button>
              </div>
            ) : phase === "forgot" ? (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-[var(--text-muted)]">
                  Enter your email and we&apos;ll send a reset link if an
                  email &amp; password account exists.
                </p>
                <Input
                  type="email"
                  autoComplete="email"
                  autoFocus
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void submitForgot()}
                  required
                />
                {pwError && (
                  <p className="text-xs text-[var(--status-critical)]">{pwError}</p>
                )}
                <Button
                  type="button"
                  className="w-full"
                  disabled={pwBusy || email.trim().length === 0}
                  onClick={() => void submitForgot()}
                >
                  {pwBusy ? "Sending…" : "Send reset link"}
                </Button>
                <button
                  type="button"
                  className="w-full text-center text-xs text-[var(--text-muted)] underline-offset-2 hover:underline"
                  onClick={() => {
                    setPwError(null);
                    setPhase("creds");
                  }}
                >
                  Back to sign in
                </button>
              </div>
            ) : phase === "forgot_sent" ? (
              <div className="mt-3 space-y-3">
                <p className="text-sm">
                  If an account with that email exists, we&apos;ve sent a link
                  to reset its password. The link expires in an hour and can be
                  used once.
                </p>
                <Button
                  type="button"
                  className="w-full"
                  onClick={() => {
                    setPwError(null);
                    setPhase("creds");
                  }}
                >
                  Back to sign in
                </Button>
              </div>
            ) : phase === "change_password" ? (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-[var(--text-muted)]">
                  Set a new password to finish signing in. It must be at least 12
                  characters and different from the temporary one.
                </p>
                <Input
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  placeholder="New password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void submitChangePassword()}
                  required
                />
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void submitChangePassword()}
                  required
                />
                {pwError && (
                  <p className="text-xs text-[var(--status-critical)]">{pwError}</p>
                )}
                <Button
                  type="button"
                  className="w-full"
                  disabled={pwBusy || newPassword.length < 12}
                  onClick={() => void submitChangePassword()}
                >
                  {pwBusy ? "Saving…" : "Set password & continue"}
                </Button>
              </div>
            ) : phase === "enroll_mfa" ? (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-[var(--text-muted)]">
                  Your organization requires two-factor. Scan this with Google
                  Authenticator, Authy, 1Password, etc., then enter the 6-digit
                  code.
                </p>
                {enroll && (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={enroll.qr}
                      alt="Authenticator QR code"
                      width={200}
                      height={200}
                      className="mx-auto rounded-md border border-[var(--border)] bg-white p-2"
                    />
                    <p className="text-center text-[11px] text-[var(--text-muted)]">
                      Can&apos;t scan? Key:{" "}
                      <code className="font-mono">{enroll.secret}</code>
                    </p>
                  </>
                )}
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void submitEnrollMfa()}
                  required
                />
                {pwError && (
                  <p className="text-xs text-[var(--status-critical)]">{pwError}</p>
                )}
                <Button
                  type="button"
                  className="w-full"
                  disabled={pwBusy}
                  onClick={() => void submitEnrollMfa()}
                >
                  {pwBusy ? "Verifying…" : "Enable & continue"}
                </Button>
              </div>
            ) : phase === "recovery" ? (
              <div className="mt-3 space-y-3">
                <p className="text-sm">
                  Two-factor is on. Save these <b>one-time recovery codes</b>{" "}
                  somewhere safe — they&apos;re shown only once.
                </p>
                <div className="grid grid-cols-2 gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-sm">
                  {(recoveryCodes ?? []).map((c) => (
                    <span key={c}>{c}</span>
                  ))}
                </div>
                <Button
                  type="button"
                  className="w-full"
                  onClick={() => {
                    window.location.href = "/";
                  }}
                >
                  I&apos;ve saved them — continue
                </Button>
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-[var(--text-muted)]">
                  Enter the 6-digit code from your authenticator app (or a
                  recovery code).
                </p>
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void submitMfa()}
                  required
                />
                {pwError && (
                  <p className="text-xs text-[var(--status-critical)]">{pwError}</p>
                )}
                <Button
                  type="button"
                  className="w-full"
                  disabled={pwBusy}
                  onClick={() => void submitMfa()}
                >
                  {pwBusy ? "Verifying…" : "Verify"}
                </Button>
              </div>
            )}
          </div>
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
