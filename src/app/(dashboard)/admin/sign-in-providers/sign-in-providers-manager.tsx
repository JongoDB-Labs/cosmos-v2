"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Building2, CheckCircle2, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MicrosoftLogo } from "@/components/brand/provider-logos";
import { notifyError } from "@/lib/errors/notify";

interface ProviderStatus {
  configured: boolean;
  enabled: boolean;
}

const CARD = "rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5";
const REDIRECT_HINT = "/api/auth/microsoft/callback";

export function SignInProvidersManager() {
  const [status, setStatus] = useState<Record<string, ProviderStatus>>({});
  const [loading, setLoading] = useState(true);

  // Microsoft form
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tenant, setTenant] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      const r = await fetch("/api/admin/auth-providers");
      if (r.ok) {
        const j = (await r.json()) as { providers: Record<string, ProviderStatus> };
        setStatus(j.providers ?? {});
        setEnabled(j.providers?.microsoft?.enabled ?? true);
      }
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const ms = status.microsoft;
  const clientIdValid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    clientId.trim(),
  );
  // First-time setup requires a secret; once configured a blank secret keeps the
  // stored one.
  const canSave =
    !saving &&
    clientId.trim().length > 0 &&
    clientIdValid &&
    (ms?.configured || clientSecret.trim().length > 0);

  async function save() {
    setSaving(true);
    try {
      const r = await fetch("/api/admin/auth-providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "microsoft",
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim() || undefined,
          tenant: tenant.trim() || null,
          enabled,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Couldn't save the provider.");
      }
      toast.success("Microsoft sign-in saved.");
      setClientSecret(""); // never keep the secret in the form
      await load();
    } catch (err) {
      notifyError(err, "Couldn't save the provider.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-[var(--text-muted)]">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      <section className={CARD}>
        <div className="mb-3 flex items-center gap-2">
          <MicrosoftLogo className="h-4 w-4" />
          <h3 className="text-sm font-semibold">Microsoft (Entra ID)</h3>
          {ms?.configured && (
            <span
              className={`ml-auto inline-flex items-center gap-1 text-xs ${ms.enabled ? "text-[var(--status-success-text,green)]" : "text-[var(--text-muted)]"}`}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {ms.enabled ? "Configured · enabled" : "Configured · disabled"}
            </span>
          )}
        </div>

        <div className="grid max-w-lg gap-3">
          <div className="space-y-1">
            <Label htmlFor="ms-client-id">Application (client) ID</Label>
            <Input
              id="ms-client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              aria-invalid={clientId.trim().length > 0 && !clientIdValid}
            />
            {clientId.trim().length > 0 && !clientIdValid && (
              <p className="text-[11px] text-[var(--status-critical)]">
                Should be a GUID — the Application (client) ID from the app&apos;s
                Overview page (not the secret, not the tenant ID).
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="ms-secret">
              Client secret <span className="text-[var(--text-muted)]">(Value)</span>
            </Label>
            <Input
              id="ms-secret"
              type="password"
              autoComplete="off"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={ms?.configured ? "•••••••• (leave blank to keep current)" : "Secret Value from Certificates & secrets"}
            />
            <p className="text-[11px] text-[var(--text-muted)]">
              The secret <b>Value</b> (e.g. <span className="font-mono">abc8Q~…</span>),
              not the Secret ID. Stored encrypted; never shown again.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="ms-tenant">
              Tenant <span className="text-[var(--text-muted)]">(optional)</span>
            </Label>
            <Input
              id="ms-tenant"
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              placeholder="common · a domain (defconai.com) · or a directory id"
            />
            <p className="text-[11px] text-[var(--text-muted)]">
              Leave blank for <span className="font-mono">common</span> (any Microsoft
              account). Set a domain/tenant to lock sign-in to that organization.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Show the &ldquo;Sign in with Microsoft&rdquo; button
          </label>

          <div>
            <Button onClick={save} disabled={!canSave} className="w-fit">
              {saving ? "Saving…" : "Save Microsoft sign-in"}
            </Button>
          </div>
        </div>

        <div className="mt-4 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text-muted)]">
          In the Entra app, register this <b>redirect URI</b> (Authentication →
          Add a platform → Web):
          <button
            type="button"
            onClick={() => {
              try {
                void navigator.clipboard?.writeText(
                  `${window.location.origin}${REDIRECT_HINT}`,
                );
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                /* clipboard unavailable */
              }
            }}
            className="mt-1 flex items-center gap-1.5 font-mono text-[var(--text)] hover:text-[var(--primary)]"
          >
            {typeof window !== "undefined" ? window.location.origin : ""}
            {REDIRECT_HINT}
            {copied ? (
              <CheckCircle2 className="h-3 w-3 text-[var(--status-success-text,green)]" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>
      </section>

      <section className={CARD}>
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Building2 className="h-4 w-4" />
          Google sign-in is currently configured at the platform level. Moving it
          here is planned — until then it keeps working as-is.
        </div>
      </section>
    </div>
  );
}
