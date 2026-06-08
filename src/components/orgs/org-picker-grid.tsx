"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Settings, Trash2, ArrowRight } from "lucide-react";
import { ActionMenu, type ActionMenuGroup } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { notifyError } from "@/lib/errors/notify";

export interface PickerOrg {
  id: string;
  name: string;
  slug: string;
  plan: string;
  role: string;
  logoUrl: string | null;
  projectCount: number;
}

/**
 * The multi-org picker grid (root `/`). Each card opens the org; a hover-⋯ /
 * right-click menu (and a tap target on touch) offers Open, Settings, and — for
 * owners — Delete. Deletion reuses the same type-the-name confirmation +
 * server-side name re-check as Settings → General; on success we refresh so the
 * picker re-resolves (deleting down to one org → the picker page redirects into
 * it; down to zero → the page renders the "create your first org" empty state).
 */
export function OrgPickerGrid({ orgs }: { orgs: PickerOrg[] }) {
  const router = useRouter();
  const [target, setTarget] = useState<PickerOrg | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  // base-ui keeps the dialog mounted through its ~100ms close animation, during
  // which `target` is already null. `view` mirrors the target on open but is
  // NOT cleared on close, so the closing frame keeps the org name instead of
  // flashing "Delete ?".
  const [view, setView] = useState<PickerOrg | null>(null);

  const armed = target != null && confirm === target.name && !busy;
  const nameMismatch = confirm.length > 0 && confirm !== view?.name;

  async function del() {
    if (!target) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/orgs/${target.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName: confirm }),
      });
      if (!res.ok) {
        // noContent() returns 204 (still res.ok); only real errors land here.
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Couldn't delete the organization.");
      }
      setTarget(null);
      setConfirm("");
      setBusy(false);
      // Re-run the server component: the deleted card disappears. If this drops
      // the user to a single org the picker page redirects into it; to zero, it
      // renders the "create your first org" empty state.
      router.refresh();
    } catch (err) {
      notifyError(err, "Couldn't delete the organization.");
      setBusy(false);
    }
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {orgs.map((org) => {
          const groups: ActionMenuGroup[] = [
            {
              items: [
                {
                  label: "Open",
                  icon: ArrowRight,
                  onClick: () => router.push(`/${org.slug}`),
                },
                {
                  label: "Settings",
                  icon: Settings,
                  onClick: () => router.push(`/${org.slug}/settings`),
                },
              ],
            },
            {
              items:
                org.role === "OWNER"
                  ? [
                      {
                        label: "Delete organization…",
                        icon: Trash2,
                        variant: "destructive" as const,
                        onClick: () => {
                          setConfirm("");
                          setView(org);
                          setTarget(org);
                        },
                      },
                    ]
                  : [],
            },
          ];

          return (
            <div key={org.id} className="group/action relative">
              <ActionMenu
                groups={groups}
                triggerClassName="absolute right-3 top-3 z-10"
                triggerLabel={`Actions for ${org.name}`}
              >
                <Link
                  href={`/${org.slug}`}
                  className="block rounded-lg border bg-card p-6 transition-colors hover:border-primary"
                >
                  <div className="mb-3 flex items-center gap-3">
                    {org.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={org.logoUrl}
                        alt={org.name}
                        className="h-10 w-10 rounded-md"
                      />
                    ) : (
                      <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 font-semibold text-primary">
                        {org.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0">
                      <h2 className="truncate font-medium">{org.name}</h2>
                      <p className="text-xs capitalize text-muted-foreground">
                        {org.role.toLowerCase()} &middot; {org.plan.toLowerCase()} plan
                      </p>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {org.projectCount} project{org.projectCount !== 1 ? "s" : ""}
                  </p>
                </Link>
              </ActionMenu>
            </div>
          );
        })}
      </div>

      <Dialog open={target != null} onOpenChange={(o) => !busy && !o && setTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {view?.name}?</DialogTitle>
            <DialogDescription>
              This permanently deletes the organization and all of its data —
              projects, boards, work items, members, integrations, and settings.
              This action <b>cannot be undone</b>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="picker-confirm-name">
              Type <span className="font-mono">{view?.name}</span> to confirm
            </Label>
            <Input
              id="picker-confirm-name"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
              placeholder={view?.name ?? ""}
            />
            {nameMismatch && (
              <p className="text-[11px] text-[var(--text-muted)]">
                The name doesn&apos;t match yet.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={del} disabled={!armed}>
              {busy ? "Deleting…" : "Delete organization"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
