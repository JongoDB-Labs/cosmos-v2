"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, Check } from "lucide-react";
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
  };
}

const CARD = "rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5";

/** True when the value parses as a URL (matches the server's zod url() — accepts
 *  http(s) and data: URIs, rejects bare strings like "logo"). */
function isParsableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Organization identity: name, workspace URL (slug), and logo. Editable only
 * with ORG_UPDATE (owner/admin); everyone else sees a read-only view. Plan and
 * the org ID are shown for reference but never editable here. (Tenant class has
 * its own dedicated control — see OrgTenantClass.)
 */
export function OrgGeneralSettings({ orgId, canUpdate, initial }: OrgGeneralSettingsProps) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [slug, setSlug] = useState(initial.slug);
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl ?? "");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  
  /**
   * Upload the logo rather than requiring it to be hosted somewhere first.
   *
   * The POST both stores the file and sets `logoUrl` server-side, so the field
   * below is refreshed from the response instead of being submitted again: a
   * second save would only rewrite the same value, and a failed one would leave
   * the record pointing at an image the org cannot see.
   */
  async function uploadLogo(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/v1/orgs/${orgId}/logo`, { method: "POST", body });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(
          detail?.error === "too_large" ? "That image is over the 2MB limit."
          : detail?.error === "unsupported_mime" ? "Use a PNG, JPEG, WebP or SVG image."
          : "Upload failed.",
        );
      }
      const json = await res.json();
      setLogoUrl(json?.data?.logoUrl ?? json?.logoUrl ?? "");
      router.refresh();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const trimmedLogo = logoUrl.trim();
  const logoChanged = trimmedLogo !== (initial.logoUrl ?? "");
  const dirty =
    name.trim() !== initial.name ||
    slug.trim() !== initial.slug ||
    logoChanged;
  const slugChanged = slug.trim() !== initial.slug;

  const nameValid = name.trim().length >= 2 && name.trim().length <= 100;
  const slugValid = /^[a-z0-9-]{2,50}$/.test(slug.trim());
  // Mirror the server's z.string().url() (zod 4): empty clears the logo,
  // otherwise it must parse as a URL — which accepts data: URIs (logos are
  // commonly stored as base64 data URIs) as well as http(s), and rejects bare
  // strings. Only gate on it when the logo was actually edited, so an existing
  // data-URI logo never blocks an unrelated name/slug save.
  const logoValid = !logoChanged || trimmedLogo === "" || isParsableUrl(trimmedLogo);
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
          // Only send the logo if it changed — avoids re-validating (and
          // re-sending) a pre-existing data-URI logo on every save.
          ...(logoChanged ? { logoUrl: trimmedLogo === "" ? null : trimmedLogo } : {}),
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
      {!canUpdate && (
        <p className="mb-4 text-xs text-[var(--text-muted)]">
          Read-only — owners and admins can edit
        </p>
      )}
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
          <Label htmlFor="org-logo-file">Logo</Label>
          <div className="flex items-center gap-3">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="h-10 w-10 rounded border border-[var(--border)] object-contain" />
            ) : (
              <div className="h-10 w-10 rounded border border-dashed border-[var(--border)]" />
            )}
            <input
              id="org-logo-file"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              disabled={!canUpdate || uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Clear the input so choosing the SAME file again still fires change —
                // otherwise retrying after a failure silently does nothing.
                e.target.value = "";
                if (f) void uploadLogo(f);
              }}
              className="text-xs file:mr-2 file:rounded-md file:border file:border-[var(--border)] file:bg-[var(--surface)] file:px-2 file:py-1 file:text-xs"
            />
            {uploading && <span className="text-xs text-[var(--text-muted)]">Uploading…</span>}
          </div>
          {uploadError && <p className="text-[11px] text-[var(--status-critical)]">{uploadError}</p>}
          <p className="text-[11px] text-[var(--text-muted)]">
            PNG, JPEG, WebP or SVG, up to 2MB — or paste a URL below.
          </p>
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
              Enter a full URL (https://… or a data: URI), or leave blank.
            </p>
          )}
        </div>

        {/* Reference metadata — not editable here. */}
        <div className="grid grid-cols-2 gap-3 pt-1 text-xs">
          <div>
            <p className="text-[var(--text-muted)]">Plan</p>
            <p className="font-medium capitalize">{initial.plan.toLowerCase()}</p>
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
