"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableMultiSelect } from "@/components/ui/searchable-multi-select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

// Every non-OWNER OrgRole is assignable here. Keep in sync with the OrgRole
// enum so a member's current role — e.g. GUEST — is always representable in
// the tier select.
const ASSIGNABLE_ROLES: Record<string, string> = {
  ADMIN: "Admin",
  BILLING_ADMIN: "Billing Admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
  GUEST: "Guest",
};

// An owner may make someone else an owner too (the API allows only owners to).
// It's offered only to them, and asks for confirmation by name before saving.
const ROLES_FOR_OWNERS: Record<string, string> = { OWNER: "Owner", ...ASSIGNABLE_ROLES };

export type TeamRoleDialogMember = {
  id: string;
  name: string;
  /** The member's current primary org role (tier). "OWNER" renders as static
   *  text — the tier PUT is skipped for owners. */
  role: string;
  /** Ids of the work-roles currently assigned to the member. */
  workRoleIds: string[];
};

interface TeamRoleDialogProps {
  orgId: string;
  member: TeamRoleDialogMember;
  /** Every work-role in the org (grants stripped server-side). */
  workRoleOptions: { id: string; name: string; isBuiltIn: boolean }[];
  /** Ids of `workRoleOptions` the actor may grant (subset-checked server-side). */
  grantableRoleIds: string[];
  /** The viewer is an owner of the org: only they may make someone an owner. */
  viewerIsOwner: boolean;
  onClose: () => void;
}

/** Order-independent set equality for the two string-id lists. */
function sameRoleSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bset = new Set(b);
  return a.every((id) => bset.has(id));
}

/** Prefer the API's human `{ error }` message; fall back for a non-JSON body. */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown } | null;
    if (data && typeof data.error === "string" && data.error.trim()) {
      return data.error;
    }
  } catch {
    // non-JSON body — use the fallback below
  }
  return fallback;
}

/**
 * Manage a member's access in one place: their PRIMARY TIER (the 5-tier org
 * role) and their ADDITIONAL WORK-ROLES (granular permission + ABAC grants).
 *
 * Save order is deliberate: the tier PUT lands first (iff changed), then the
 * work-role set PUT (iff changed). If the roles PUT is rejected AFTER the tier
 * already saved, the inline message says so plainly ("Tier saved. Roles
 * rejected: …") so the admin isn't misled into thinking nothing changed. Any
 * error keeps the dialog open with the message; a clean save toasts, refreshes
 * the server component, and closes.
 *
 * The grant ceiling is advisory in the UI (the server enforces it): a role the
 * actor can't grant is disabled — UNLESS the member already holds it, in which
 * case it stays enabled so it can be REMOVED (de-escalation is always allowed).
 */
export function TeamRoleDialog({
  orgId,
  member,
  workRoleOptions,
  grantableRoleIds,
  viewerIsOwner,
  onClose,
}: TeamRoleDialogProps) {
  const router = useRouter();
  const isOwner = member.role === "OWNER";
  const tierRoles = viewerIsOwner ? ROLES_FOR_OWNERS : ASSIGNABLE_ROLES;
  // Making someone an owner is confirmed by name before anything is saved.
  const [confirmingOwner, setConfirmingOwner] = useState(false);

  const [tier, setTier] = useState(member.role);
  const [roleIds, setRoleIds] = useState<string[]>(member.workRoleIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grantable = useMemo(() => new Set(grantableRoleIds), [grantableRoleIds]);
  const assigned = useMemo(() => new Set(member.workRoleIds), [member.workRoleIds]);

  const options = useMemo(
    () =>
      workRoleOptions.map((wr) => ({
        value: wr.id,
        label: wr.isBuiltIn ? `${wr.name} · Built-in` : wr.name,
        // Ungrantable AND not already held → can't be added, so disable it.
        // Ungrantable but already held stays enabled so the actor can remove it.
        disabled: !grantable.has(wr.id) && !assigned.has(wr.id),
      })),
    [workRoleOptions, grantable, assigned],
  );

  const tierChanged = !isOwner && tier !== member.role;
  const rolesChanged = !sameRoleSet(roleIds, member.workRoleIds);

  async function handleSave() {
    // Nothing changed — close quietly rather than toasting a save that never happened.
    if (!tierChanged && !rolesChanged) {
      onClose();
      return;
    }
    if (tierChanged && tier === "OWNER" && !confirmingOwner) {
      setConfirmingOwner(true);
      return;
    }
    setSaving(true);
    setError(null);
    let tierSaved = false;
    try {
      if (tierChanged) {
        const res = await fetch(`/api/v1/orgs/${orgId}/members/${member.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: tier }),
        });
        if (!res.ok) {
          setError(await readError(res, `Couldn't update the tier (HTTP ${res.status}).`));
          setConfirmingOwner(false);
          setSaving(false);
          return;
        }
        tierSaved = true;
      }

      if (rolesChanged) {
        const res = await fetch(
          `/api/v1/orgs/${orgId}/members/${member.id}/work-roles`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workRoleIds: roleIds }),
          },
        );
        if (!res.ok) {
          const serverMsg = await readError(
            res,
            `Couldn't update roles (HTTP ${res.status}).`,
          );
          // Partial success: the tier already landed this save — say so plainly.
          setError(tierSaved ? `Tier saved. Roles rejected: ${serverMsg}` : serverMsg);
          setSaving(false);
          return;
        }
      }

      toast.success("Access updated");
      router.refresh();
      onClose();
    } catch {
      setError("Something went wrong. Please try again.");
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage roles — {member.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
              Primary tier
            </Label>
            {isOwner ? (
              <p className="text-sm text-[var(--text-muted)]">
                Owner — transfer ownership to change
              </p>
            ) : (
              <Select
                items={tierRoles}
                value={tier}
                onValueChange={(v) => {
                  if (!v) return;
                  setTier(v);
                  setConfirmingOwner(false);
                }}
              >
                <SelectTrigger className="w-full" aria-label="Primary tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(tierRoles).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
              Additional roles
            </Label>
            <SearchableMultiSelect
              aria-label="Additional roles"
              className="w-full"
              value={roleIds}
              onValueChange={setRoleIds}
              options={options}
              placeholder="No additional roles"
              searchPlaceholder="Search roles…"
            />
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <p className="text-xs text-[var(--text-muted)]">
            Roles are defined in Settings → Roles &amp; Access.
          </p>
        </div>

        {confirmingOwner ? (
          <div role="alertdialog" aria-label={`Make ${member.name} an owner`} className="space-y-3 rounded-md border border-[var(--border)] p-3">
            <p className="text-sm font-medium">Make {member.name} an owner?</p>
            <p className="text-sm text-[var(--text-muted)]">
              Owners have full control of the organization, including billing and deleting it. Only an owner can
              change another owner&apos;s role, and an organization always keeps at least one owner.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmingOwner(false)} disabled={saving}>
                Back
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : `Make ${member.name} an owner`}
              </Button>
            </div>
          </div>
        ) : (
          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
