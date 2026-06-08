"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { KeyRound, ShieldCheck, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notifyError } from "@/lib/errors/notify";

interface Status {
  email: string | null;
  hasPassword: boolean;
  passwordSetAt: string | null;
  mfaEnabled: boolean;
  recoveryCodesRemaining: number;
}

const CARD = "rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5";

/**
 * Per-user account security: set/change a password, and enroll/disable a TOTP
 * authenticator (with one-time recovery codes). Distinct from the org-level
 * Security policy panel below it; available to every signed-in user.
 */
export function AccountSecurityPanel() {
  const [status, setStatus] = useState<Status | null>(null);

  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);

  const [enroll, setEnroll] = useState<{ secret: string; qr: string } | null>(null);
  const [enrollCode, setEnrollCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const [showDisable, setShowDisable] = useState(false);
  const [disableCode, setDisableCode] = useState("");

  async function load() {
    try {
      const r = await fetch("/api/v1/me/security");
      if (r.ok) setStatus((await r.json()) as Status);
    } catch {
      /* best-effort */
    }
  }
  // Load posture once on mount. fetch sets state in an async callback (not the
  // effect body) — the established pattern; scope-disable the rule.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void load();
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function savePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwBusy(true);
    try {
      const r = await fetch("/api/v1/me/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: curPw || undefined,
          newPassword: newPw,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Couldn't save your password.");
      }
      toast.success(status?.hasPassword ? "Password updated." : "Password set.");
      setCurPw("");
      setNewPw("");
      await load();
    } catch (err) {
      notifyError(err, "Couldn't save your password.");
    } finally {
      setPwBusy(false);
    }
  }

  async function startEnroll() {
    setMfaBusy(true);
    try {
      const r = await fetch("/api/v1/me/mfa/setup", { method: "POST" });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Couldn't start setup.");
      }
      const { otpauthUri, secret } = (await r.json()) as {
        otpauthUri: string;
        secret: string;
      };
      const QR = await import("qrcode");
      const qr = await QR.toDataURL(otpauthUri, { width: 208, margin: 1 });
      setEnroll({ secret, qr });
    } catch (err) {
      notifyError(err, "Couldn't start two-factor setup.");
    } finally {
      setMfaBusy(false);
    }
  }

  async function confirmEnroll(e: React.FormEvent) {
    e.preventDefault();
    setMfaBusy(true);
    try {
      const r = await fetch("/api/v1/me/mfa/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: enrollCode.trim() }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Couldn't enable two-factor.");
      }
      const { recoveryCodes: codes } = (await r.json()) as { recoveryCodes: string[] };
      setRecoveryCodes(codes);
      setEnroll(null);
      setEnrollCode("");
      await load();
    } catch (err) {
      notifyError(err, "Couldn't enable two-factor.");
    } finally {
      setMfaBusy(false);
    }
  }

  async function disableMfa(e: React.FormEvent) {
    e.preventDefault();
    setMfaBusy(true);
    try {
      const r = await fetch("/api/v1/me/mfa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: disableCode.trim() }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Couldn't disable two-factor.");
      }
      toast.success("Two-factor disabled.");
      setShowDisable(false);
      setDisableCode("");
      await load();
    } catch (err) {
      notifyError(err, "Couldn't disable two-factor.");
    } finally {
      setMfaBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* ── Password ── */}
      <section className={CARD}>
        <div className="mb-3 flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-[var(--primary)]" />
          <h3 className="text-sm font-semibold">Password</h3>
          {status && (
            <span className="ml-auto text-xs text-[var(--text-muted)]">
              {status.hasPassword ? "Set — you can sign in with email & password" : "Not set"}
            </span>
          )}
        </div>
        <form onSubmit={savePassword} className="grid max-w-md gap-2">
          {/* There's no username/email field to fill in — your login email is
              the account email you already signed in with. Show it so it's
              clear what to enter at the email/password sign-in screen. */}
          {status?.email && (
            <div className="mb-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text-muted)]">
              You&apos;ll sign in with your account email:{" "}
              <span className="font-medium text-[var(--text)]">{status.email}</span>
            </div>
          )}
          {status?.hasPassword && (
            <div className="space-y-1">
              <Label htmlFor="cur-pw">Current password</Label>
              <Input
                id="cur-pw"
                type="password"
                autoComplete="current-password"
                value={curPw}
                onChange={(e) => setCurPw(e.target.value)}
                required
              />
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="new-pw">
              {status?.hasPassword ? "New password" : "Set a password"}
            </Label>
            <Input
              id="new-pw"
              type="password"
              autoComplete="new-password"
              placeholder="At least 12 characters"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-fit" disabled={pwBusy || newPw.length < 12}>
            {pwBusy ? "Saving…" : status?.hasPassword ? "Update password" : "Set password"}
          </Button>
        </form>
      </section>

      {/* ── Two-factor ── */}
      <section className={CARD}>
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-[var(--primary)]" />
          <h3 className="text-sm font-semibold">Two-factor authentication</h3>
          {status && (
            <span
              className={`ml-auto text-xs ${status.mfaEnabled ? "text-[var(--status-success-text,green)]" : "text-[var(--text-muted)]"}`}
            >
              {status.mfaEnabled
                ? `Enabled · ${status.recoveryCodesRemaining} recovery codes left`
                : "Disabled"}
            </span>
          )}
        </div>

        {recoveryCodes ? (
          <div className="space-y-3">
            <p className="text-sm text-[var(--text)]">
              Two-factor is on. Save these <b>one-time recovery codes</b> somewhere
              safe — they&apos;re shown only once and let you sign in if you lose
              your authenticator.
            </p>
            <div className="grid max-w-md grid-cols-2 gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-sm">
              {recoveryCodes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  try {
                    void navigator.clipboard?.writeText(recoveryCodes.join("\n"));
                    toast.success("Recovery codes copied.");
                  } catch {
                    /* clipboard unavailable */
                  }
                }}
              >
                <Copy className="h-4 w-4" /> Copy codes
              </Button>
              <Button onClick={() => setRecoveryCodes(null)}>Done</Button>
            </div>
          </div>
        ) : status?.mfaEnabled ? (
          showDisable ? (
            <form onSubmit={disableMfa} className="grid max-w-md gap-2">
              <Label htmlFor="dis-code">
                Enter a current code (or recovery code) to turn off two-factor
              </Label>
              <Input
                id="dis-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                required
              />
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={() => setShowDisable(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="destructive" disabled={mfaBusy}>
                  {mfaBusy ? "Disabling…" : "Disable two-factor"}
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="outline" onClick={() => setShowDisable(true)}>
              Disable two-factor
            </Button>
          )
        ) : enroll ? (
          <div className="space-y-3">
            <p className="text-sm text-[var(--text-muted)]">
              Scan with Google Authenticator, Authy, 1Password, etc. — then enter
              the 6-digit code to confirm.
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={enroll.qr}
              alt="Authenticator QR code"
              width={208}
              height={208}
              className="rounded-md border border-[var(--border)] bg-white p-2"
            />
            <p className="text-xs text-[var(--text-muted)]">
              Can&apos;t scan? Enter this key manually:{" "}
              <code className="font-mono">{enroll.secret}</code>
            </p>
            <form onSubmit={confirmEnroll} className="flex max-w-xs items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label htmlFor="enroll-code">6-digit code</Label>
                <Input
                  id="enroll-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={enrollCode}
                  onChange={(e) => setEnrollCode(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" disabled={mfaBusy}>
                {mfaBusy ? "Verifying…" : "Enable"}
              </Button>
            </form>
            <Button variant="ghost" onClick={() => setEnroll(null)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-[var(--text-muted)]">
              Add an authenticator app for a second factor at sign-in. If your
              organization requires MFA, you&apos;ll need this enabled.
            </p>
            <Button onClick={startEnroll} disabled={mfaBusy}>
              {mfaBusy ? "Starting…" : "Set up two-factor"}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
