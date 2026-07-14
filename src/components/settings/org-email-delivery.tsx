"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Mail, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/components/ui/section-card";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { notifyError } from "@/lib/errors/notify";

/**
 * Org-settings control for per-org transactional email (Resend) delivery.
 *
 * OWNER-ONLY, mirroring OrgTenantClass: the server page passes `isOwner`, and a
 * non-owner sees a read-only summary. The API key is write-only from the UI — it
 * is NEVER returned by the API (`initial.configured` is a mere boolean), the input
 * starts empty, and submitting it empty leaves the stored key untouched.
 *
 * THIN client: PUT /email-settings saves; POST /email-settings/test sends a probe
 * to the current user via the org's resolved config and reports the result inline.
 * router.refresh() re-reads the server-loaded `initial` after a save.
 */

// Kept in sync with the server route's From-header check so we can give a precise
// inline message before the round-trip (the server re-validates authoritatively).
const BARE_EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const NAME_ADDR = /^.+<\s*[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+\s*>$/;
function looksLikeFromHeader(value: string): boolean {
  const t = value.trim();
  return BARE_EMAIL.test(t) || NAME_ADDR.test(t);
}

export interface OrgEmailDeliveryInitial {
  provider: string;
  fromAddress: string | null;
  enabled: boolean;
  /** Whether a sealed API key is stored — a boolean only; the key is never sent. */
  configured: boolean;
}

export function OrgEmailDelivery({
  orgId,
  isOwner,
  initial,
}: {
  orgId: string;
  isOwner: boolean;
  initial: OrgEmailDeliveryInitial;
}) {
  const router = useRouter();
  const [provider, setProvider] = useState<string>(initial.provider || "resend");
  const [fromAddress, setFromAddress] = useState<string>(initial.fromAddress ?? "");
  const [enabled, setEnabled] = useState<boolean>(initial.enabled);
  const [apiKey, setApiKey] = useState<string>("");
  const [fromError, setFromError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  if (!isOwner) {
    return (
      <SectionCard
        icon={Mail}
        title="Email delivery"
        description="How invitation and other transactional emails are sent for this organization."
      >
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-[var(--text-muted)]">Status</dt>
          <dd>{initial.enabled && initial.configured ? "Enabled (Resend)" : "Not configured"}</dd>
          <dt className="text-[var(--text-muted)]">From</dt>
          <dd>{initial.fromAddress || "—"}</dd>
        </dl>
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          Only the organization owner can change email delivery settings.
        </p>
      </SectionCard>
    );
  }

  async function save() {
    const trimmedFrom = fromAddress.trim();
    if (trimmedFrom.length > 0 && !looksLikeFromHeader(trimmedFrom)) {
      setFromError('Enter an email like invites@you.com or "Name <invites@you.com>".');
      return;
    }
    setFromError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/email-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          fromAddress: trimmedFrom,
          enabled,
          // Only send a non-empty key; empty leaves the stored key untouched.
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as {
          error?: string;
          issues?: Array<{ message?: string }>;
        };
        throw new Error(j.issues?.[0]?.message ?? j.error ?? "Couldn't save email settings.");
      }
      toast.success("Email delivery settings saved.");
      setApiKey(""); // never keep the secret in state after a successful save
      router.refresh();
    } catch (err) {
      notifyError(err, "Couldn't save email settings.");
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/email-settings/test`, {
        method: "POST",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Couldn't send the test email.");
      }
      const body = (await res.json()) as { ok: boolean; error?: string };
      setTestResult(body);
      if (body.ok) toast.success("Test email sent.");
    } catch (err) {
      notifyError(err, "Couldn't send the test email.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <SectionCard
      icon={Mail}
      title="Email delivery"
      description="Send invitation and transactional emails from your own verified Resend domain instead of the inviter's mailbox. When enabled, this org's key is used; otherwise the platform default (or the inviter's Gmail) is used."
    >
      <div className="space-y-4">
        {/* Provider */}
        <div className="space-y-1.5">
          <label htmlFor="email-provider" className="text-sm font-medium text-[var(--text)]">
            Provider
          </label>
          <Select value={provider} onValueChange={(v) => v && setProvider(String(v))}>
            <SelectTrigger id="email-provider" aria-label="Email provider" className="max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="resend">Resend</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* API key (write-only) */}
        <div className="space-y-1.5">
          <label htmlFor="email-api-key" className="text-sm font-medium text-[var(--text)]">
            API key
          </label>
          <p className="text-xs text-[var(--text-muted)]">
            {initial.configured
              ? "A key is stored. Enter a new one to replace it; leave blank to keep the current key."
              : "Paste your Resend API key. It is encrypted at rest and never shown again."}
          </p>
          <Input
            id="email-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={initial.configured ? "Configured ••••" : "re_…"}
            autoComplete="off"
            spellCheck={false}
            className="max-w-sm"
            disabled={saving}
          />
        </div>

        {/* From address */}
        <div className="space-y-1.5">
          <label htmlFor="email-from" className="text-sm font-medium text-[var(--text)]">
            From address
          </label>
          <p className="text-xs text-[var(--text-muted)]">
            Must be on a domain you&apos;ve verified with Resend.
          </p>
          <Input
            id="email-from"
            value={fromAddress}
            onChange={(e) => {
              setFromAddress(e.target.value);
              if (fromError) setFromError(null);
            }}
            placeholder="Acme <invites@acme.com>"
            autoComplete="off"
            spellCheck={false}
            className="max-w-sm"
            disabled={saving}
            aria-invalid={fromError ? true : undefined}
          />
          {fromError && (
            <p className="text-xs text-[var(--status-critical)]">{fromError}</p>
          )}
        </div>

        {/* Enabled toggle */}
        <div className="flex items-center gap-3">
          <ToggleSwitch
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={saving}
            aria-label="Enable per-org email delivery"
          />
          <div>
            <p className="text-sm font-medium text-[var(--text)]">
              Use this configuration for outgoing email
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              When off, email falls back to the platform default and then the inviter&apos;s Gmail.
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Save
          </Button>
          <Button variant="outline" onClick={sendTest} disabled={testing || saving}>
            {testing ? <Loader2 className="size-4 animate-spin" /> : null}
            Send test email
          </Button>
        </div>

        {/* Inline test result */}
        {testResult && (
          <div
            className={
              "flex items-start gap-2 rounded-md border p-3 text-xs " +
              (testResult.ok
                ? "border-[var(--status-done)]/40 bg-[var(--status-done)]/5 text-[var(--text)]"
                : "border-[var(--status-critical)]/40 bg-[var(--status-critical)]/5 text-[var(--text)]")
            }
          >
            {testResult.ok ? (
              <>
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--status-done)]" />
                <span>Test email sent — check your inbox.</span>
              </>
            ) : (
              <>
                <XCircle className="mt-0.5 size-4 shrink-0 text-[var(--status-critical)]" />
                <span>
                  Test failed: {testResult.error || "email delivery is not configured."}
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
