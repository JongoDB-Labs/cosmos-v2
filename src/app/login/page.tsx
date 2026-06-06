"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { CosmosMark } from "@/components/brand/cosmos-mark";
import { Starfield } from "@/components/brand/starfield";

const ERROR_MESSAGES: Record<string, string> = {
  not_allowed: "Your email is not yet approved. Ask an admin to add it.",
  invalid_state: "Sign-in expired. Please try again.",
  auth_failed: "Google sign-in failed. Please try again.",
  rate_limited: "Too many sign-in attempts. Please wait a moment and try again.",
};

function LoginInner() {
  const params = useSearchParams();
  const error = params.get("error");
  const message = error ? (ERROR_MESSAGES[error] ?? "Sign-in failed.") : null;
  const [submitting, setSubmitting] = useState(false);

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

        <Button
          size="lg"
          className="mt-6 w-full"
          disabled={submitting}
          onClick={() => {
            setSubmitting(true);
            window.location.href = "/api/auth/google";
          }}
        >
          {submitting ? "Redirecting to Google…" : "Sign in with Google"}
        </Button>
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
