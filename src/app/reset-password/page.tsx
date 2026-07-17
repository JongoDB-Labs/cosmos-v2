"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BrandMark } from "@/components/brand/brand-mark";
import { useBrand } from "@/components/providers/brand-provider";
import { cn } from "@/lib/utils";

function ResetPasswordInner() {
  const brand = useBrand();
  const params = useSearchParams();
  const token = params.get("token");

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    if (!token) {
      setError("This reset link is invalid or has expired. Request a new one.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/password/reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Couldn't reset your password. Please try again.");
        return;
      }
      setDone(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4">
      <div className="relative z-10 w-full max-w-sm rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-8 shadow-[var(--shadow-soft)]">
        <div className="flex flex-col items-center text-center">
          <BrandMark size="lg" />
          <h1 className="mt-4 text-2xl font-bold tracking-tight">
            Reset your password
          </h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">{brand.name}</p>
        </div>

        {done ? (
          <div className="mt-6 space-y-4 text-center">
            <p className="text-sm">
              Your password has been updated. You can now sign in with your new
              password.
            </p>
            <Link href="/login" className={cn(buttonVariants(), "w-full")}>
              Go to sign in
            </Link>
          </div>
        ) : !token ? (
          <div className="mt-6 space-y-4 text-center">
            <p className="text-sm text-[var(--status-critical)]">
              This reset link is invalid or has expired.
            </p>
            <Link
              href="/login"
              className={cn(buttonVariants({ variant: "outline" }), "w-full")}
            >
              Back to sign in
            </Link>
          </div>
        ) : (
          <div className="mt-6 space-y-2">
            <p className="text-xs text-[var(--text-muted)]">
              Choose a new password. It must be at least 12 characters.
            </p>
            <Input
              type="password"
              autoComplete="new-password"
              autoFocus
              placeholder="New password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
              required
            />
            <Input
              type="password"
              autoComplete="new-password"
              placeholder="Confirm new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
              required
            />
            {error && (
              <p className="text-xs text-[var(--status-critical)]">{error}</p>
            )}
            <Button
              type="button"
              className="w-full"
              disabled={busy || newPassword.length < 12}
              onClick={() => void submit()}
            >
              {busy ? "Saving…" : "Set new password"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordInner />
    </Suspense>
  );
}
