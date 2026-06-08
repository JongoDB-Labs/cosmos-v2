"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notifyError } from "@/lib/errors/notify";

interface OrgGeneralSettingsProps {
  orgId: string;
  canUpdate: boolean;
  initial: {
    name: string;
    slug: string;
    logoUrl: string | null;
    plan: string;
    tenantClass: string;
  };
}

const CARD = "rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5";

/**
 * Organization identity: name, workspace URL (slug), and logo. Editable only
 * with ORG_UPDATE (owner/admin); everyone else sees a read-only view. Plan,
 * tenant class, and the org ID are shown for reference but never editable here.
 */
export function OrgGeneralSettings({ orgId, canUpdate, initial }: OrgGeneralSettingsProps) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [slug, setSlug] = useState(initial.slug);
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const trimmedLogo = logoUrl.trim();
  const dirty =
    name.trim() !== initial.name ||
    slug.trim() !== initial.slug ||
    trimmedLogo !== (initial.logoUrl ?? "");
  const slugChanged = slug.trim() !== initial.slug;

  const nameValid = name.trim().length >= 2 && name.trim().length <= 100;
  const slugValid = /^[a-z0-9-]{2,50}$/.test(slug.trim());
  // Mirror the server's z.string().url(): empty clears the logo, otherwise it
  // must be an http(s) URL. Without this the whole save (incl. name/slug) 400s.
  const logoValid = trimmedLogo === "" || /^https?:\/\/.+/.test(trimmedLogo);
  const canSave = canUpdate && dirty && nameValid && slugValid && logoValid && !saving;

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim(),
          logoUrl: trimmedLogo === "" ? null : trimmedLogo,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Couldn't save organization settings.");
      }
      // A slug rename changes the workspace URL — the current route's
      // [orgSlug] is now stale, so hard-navigate to the new one.
      if (slugChanged) {
        toast.success("Workspace URL updated.");
        window.location.href = `/${slug.trim()}/settings`;
        return;
      }
      toast.success("Organization updated.");
      router.refresh();
    } catch (err) {
      notifyError(err, "Couldn't save organization settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={CARD}>
      <div className="mb-4 flex items-center gap-2">
        <Building2 className="h-4 w-4 text-[var(--primary)]" />
        <h3 className="text-sm font-semibold">Organization</h3>
        {!canUpdate && (
          <span className="ml-auto text-xs text-[var(--text-muted)]">
            Read-only — owners and admins can edit
          </span>
        )}
      </div>

      <div className="grid max-w-lg gap-4">
        <div className="space-y-1">
          <Label htmlFor="org-name">Name</Label>
          <Input
            id="org-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canUpdate}
            maxLength={100}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="org-slug">Workspace URL</Label>
          <div className="flex items-center gap-1">
            <span className="text-sm text-[var(--text-muted)]">/</span>
            <Input
              id="org-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              disabled={!canUpdate}
              maxLength={50}
              aria-invalid={!slugValid}
            />
          </div>
          {canUpdate && slugChanged && (
            <p className="text-[11px] text-[var(--status-warning-text,#b45309)]">
              Changing this changes your workspace URL — existing links and
              bookmarks will stop working.
            </p>
          )}
          {canUpdate && !slugValid && (
            <p className="text-[11px] text-[var(--status-critical)]">
              Use 2–50 lowercase letters, numbers, or hyphens.
            </p>
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor="org-logo">Logo URL</Label>
          <Input
            id="org-logo"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            disabled={!canUpdate}
            placeholder="https://…"
            aria-invalid={!logoValid}
          />
          {canUpdate && !logoValid && (
            <p className="text-[11px] text-[var(--status-critical)]">
              Enter a full URL starting with http:// or https:// (or leave blank).
            </p>
          )}
        </div>

        {/* Reference metadata — not editable here. */}
        <div className="grid grid-cols-2 gap-3 pt-1 text-xs">
          <div>
            <p className="text-[var(--text-muted)]">Plan</p>
            <p className="font-medium capitalize">{initial.plan.toLowerCase()}</p>
          </div>
          <div>
            <p className="text-[var(--text-muted)]">Tenant class</p>
            <p className="font-medium">{initial.tenantClass}</p>
          </div>
          <div className="col-span-2">
            <p className="text-[var(--text-muted)]">Organization ID</p>
            <button
              type="button"
              onClick={() => {
                try {
                  void navigator.clipboard?.writeText(orgId);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  /* clipboard unavailable */
                }
              }}
              className="mt-0.5 inline-flex items-center gap-1.5 font-mono text-[var(--text)] hover:text-[var(--primary)]"
              title="Copy organization ID"
            >
              {orgId}
              {copied ? (
                <Check className="h-3 w-3 text-[var(--status-success-text,green)]" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </div>
        </div>

        {canUpdate && (
          <div>
            <Button onClick={save} disabled={!canSave} className="w-fit">
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
