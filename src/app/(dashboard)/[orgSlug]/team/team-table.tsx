"use client";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ActionMenu, type ActionMenuGroup } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { notifyError } from "@/lib/errors/notify";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TeamRoleDialog } from "./team-role-dialog";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { Shield, UserMinus, Send, Trash2, UserX, KeyRound } from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

type Row = {
  kind: "member" | "invite";
  id: string;
  /** The global User id — present on member rows only (null for invites). The
   *  platform-admin "Delete account" action targets this, not the OrgMember id. */
  userId?: string | null;
  name: string;
  email: string;
  role: string;
  joined: string;
  avatarUrl: string | null;
  /** Work-roles assigned to this member (id/name only — grants stay
   *  server-side). Always `[]` for invite rows (nothing is assigned until the
   *  invite is accepted). */
  workRoles: { id: string; name: string }[];
};

interface TeamTableProps {
  rows: Row[];
  /** Every work-role in the org (id/name/isBuiltIn — grants stay
   *  server-side), for the role-assignment dialog. */
  workRoleOptions: { id: string; name: string; isBuiltIn: boolean }[];
  /** Ids of `workRoleOptions` the current actor may grant, computed
   *  server-side (isPermissionSubset against their basePermissions ceiling)
   *  so a member can never hand out a role that grants more than they hold
   *  themselves. */
  grantableRoleIds: string[];
  /** True when the viewer is a platform/system admin (INTERNAL_ADMINS). Unlocks
   *  the global "Delete account" row action — the API re-checks this gate. */
  isPlatformAdmin?: boolean;
  /** The viewer's own User id — used to hide "Delete account" on their own row
   *  (the API also blocks self-deletion). */
  currentUserId?: string;
}

const ROLE_VARIANT = {
  OWNER: "strategic",
  ADMIN: "progress",
  MEMBER: "neutral",
  VIEWER: "neutral",
} as const;

export function TeamTable({
  rows,
  workRoleOptions,
  grantableRoleIds,
  isPlatformAdmin = false,
  currentUserId,
}: TeamTableProps) {
  const { can, orgId } = usePermissions();
  const router = useRouter();
  const [roleDialogTarget, setRoleDialogTarget] = useState<{
    id: string;
    name: string;
    role: string;
    workRoleIds: string[];
  } | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<{
    // "remove" targets an OrgMember id, "revoke" an invitation id,
    // "delete-account" a global User id.
    action: "remove" | "revoke" | "delete-account";
    id: string;
    name: string;
  } | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);

  // Open the unified Manage-roles dialog for a member row, seeding it with the
  // member's current tier + assigned work-role ids (mapped off the row's chips).
  const openRoleDialog = useCallback((r: Row) => {
    setRoleDialogTarget({
      id: r.id,
      name: r.name,
      role: r.role,
      workRoleIds: r.workRoles.map((w) => w.id),
    });
  }, []);

  const handleRemoveMember = useCallback(
    async (memberId: string) => {
      try {
        const res = await fetch(`/api/v1/orgs/${orgId}/members/${memberId}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(`Failed to remove member (HTTP ${res.status})`);
        router.refresh();
      } catch (err) {
        console.error("Failed to remove member", err);
        notifyError(err, "Couldn't remove the member.");
      }
    },
    [orgId, router],
  );

  // Platform-admin only: permanently delete the GLOBAL user account (anonymize +
  // revoke all access + free the email). Hits the system-tier internal route,
  // which re-checks the platform-admin gate and all guards server-side.
  const handleDeleteAccount = useCallback(
    async (userId: string) => {
      try {
        const res = await fetch(`/api/internal/users/${userId}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(
            data?.error ?? `Failed to delete account (HTTP ${res.status})`,
          );
        }
        toast.success("Account deleted — their email is free to invite again.");
        router.refresh();
      } catch (err) {
        notifyError(err, "Couldn't delete the account.");
      }
    },
    [router],
  );

  // Admin/owner-triggered password reset: emails the member a signed, single-use
  // reset link. Gracefully no-ops for a Google/SSO-only member (no password to
  // reset) — the API says so via { sent:false, reason:"sso" } and we surface it.
  const handleSendPasswordReset = useCallback(
    async (memberId: string) => {
      try {
        const res = await fetch(
          `/api/v1/orgs/${orgId}/members/${memberId}/password-reset`,
          { method: "POST" },
        );
        if (!res.ok) throw new Error(`Failed (HTTP ${res.status})`);
        const data = (await res.json().catch(() => null)) as {
          sent?: boolean;
          reason?: string;
          message?: string;
        } | null;
        if (data?.sent) {
          toast.success("Password reset email sent.");
        } else if (data?.reason === "sso") {
          toast.info(
            data.message ??
              "This member signs in with Google/SSO — no password to reset.",
          );
        } else {
          toast.error("Couldn't send the reset email — try again.");
        }
      } catch (err) {
        notifyError(err, "Couldn't send the reset email.");
      }
    },
    [orgId],
  );

  const handleRevokeInvite = useCallback(
    async (invitationId: string) => {
      try {
        const res = await fetch(
          `/api/v1/orgs/${orgId}/invitations/${invitationId}`,
          { method: "DELETE" },
        );
        if (!res.ok) throw new Error(`Failed to revoke (HTTP ${res.status})`);
        toast.success("Invitation revoked");
        router.refresh();
      } catch (err) {
        notifyError(err, "Couldn't revoke the invitation.");
      }
    },
    [orgId, router],
  );

  const handleResendInvite = useCallback(
    async (invitationId: string) => {
      try {
        const res = await fetch(
          `/api/v1/orgs/${orgId}/invitations/${invitationId}`,
          { method: "POST" },
        );
        if (!res.ok) throw new Error(`Failed to resend (HTTP ${res.status})`);
        const data = (await res.json().catch(() => null)) as
          | { emailSent?: boolean }
          | null;
        toast.success(
          data?.emailSent === false
            ? "Invitation refreshed (email not sent — copy the link)."
            : "Invitation resent",
        );
      } catch (err) {
        notifyError(err, "Couldn't resend the invitation.");
      }
    },
    [orgId],
  );

  // Surface each row's existing operations (change role / remove) as a
  // right-click context menu + trailing ⋯ column via DataTable's rowActions.
  // Reuses the same handlers + permission gate as the inline actions column.
  const rowActions = useCallback(
    (r: Row): ActionMenuGroup[] => {
      const canManageMembers = can(Permission.ORG_MANAGE_MEMBERS);

      // Pending invitations: resend (re-email + refresh expiry) or revoke.
      if (r.kind === "invite") {
        return canManageMembers
          ? [
              {
                items: [
                  {
                    label: "Resend invite",
                    icon: Send,
                    onClick: () => handleResendInvite(r.id),
                  },
                  {
                    label: "Revoke invite",
                    icon: Trash2,
                    variant: "destructive" as const,
                    onClick: () =>
                      setConfirmTarget({ action: "revoke", id: r.id, name: r.name }),
                  },
                ],
              },
            ]
          : [];
      }

      const isOwner = r.role === "OWNER";
      // Platform-admin only: delete the GLOBAL account. Hidden on the viewer's
      // own row (the API also blocks self-deletion) and on invite rows.
      const canDeleteAccount =
        isPlatformAdmin && !!r.userId && r.userId !== currentUserId;
      return [
        {
          // "Manage roles…" opens the unified tier + work-role dialog. Available
          // even for an OWNER (their tier is static there, but their work-roles
          // are still manageable) — only the destructive "Remove" excludes owners.
          items: canManageMembers
            ? [
                {
                  label: "Manage roles…",
                  icon: Shield,
                  onClick: () => openRoleDialog(r),
                },
                {
                  label: "Send password reset",
                  icon: KeyRound,
                  onClick: () => handleSendPasswordReset(r.id),
                },
              ]
            : [],
        },
        {
          items: [
            ...(canManageMembers && !isOwner
              ? [
                  {
                    label: "Remove from org",
                    icon: UserMinus,
                    variant: "destructive" as const,
                    onClick: () =>
                      setConfirmTarget({ action: "remove", id: r.id, name: r.name }),
                  },
                ]
              : []),
            ...(canDeleteAccount
              ? [
                  {
                    label: "Delete account",
                    icon: UserX,
                    variant: "destructive" as const,
                    onClick: () => {
                      // Guarded above (canDeleteAccount) — narrow for the target.
                      if (r.userId) {
                        setConfirmTarget({
                          action: "delete-account",
                          id: r.userId,
                          name: r.name,
                        });
                      }
                    },
                  },
                ]
              : []),
          ],
        },
      ];
    },
    [
      can,
      handleResendInvite,
      handleSendPasswordReset,
      openRoleDialog,
      isPlatformAdmin,
      currentUserId,
    ],
  );

  const runConfirm = async () => {
    if (!confirmTarget) return;
    setConfirmPending(true);
    if (confirmTarget.action === "remove") {
      await handleRemoveMember(confirmTarget.id);
    } else if (confirmTarget.action === "delete-account") {
      await handleDeleteAccount(confirmTarget.id);
    } else {
      await handleRevokeInvite(confirmTarget.id);
    }
    setConfirmPending(false);
    setConfirmTarget(null);
  };

  const columns: ColumnDef<Row>[] = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <Avatar
            className={
              row.original.kind === "invite"
                ? "h-7 w-7 border border-dashed border-[var(--text-muted)]"
                : "h-7 w-7"
            }
          >
            <AvatarImage src={row.original.avatarUrl ?? undefined} />
            <AvatarFallback className="text-[10px]">
              {row.original.name.charAt(0)}
            </AvatarFallback>
          </Avatar>
          <span>{row.original.name}</span>
        </div>
      ),
    },
    { accessorKey: "email", header: "Email" },
    {
      accessorKey: "role",
      header: "Role",
      cell: ({ row }) => {
        if (row.original.kind === "invite") {
          return <Badge variant="neutral">Pending</Badge>;
        }
        const variant =
          ROLE_VARIANT[row.original.role as keyof typeof ROLE_VARIANT] ?? "neutral";
        const { workRoles } = row.original;
        const shown = workRoles.slice(0, 2);
        const overflow = workRoles.length - shown.length;
        const chips = (
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant={variant}>{row.original.role}</Badge>
            {shown.map((wr) => (
              <Badge key={wr.id} variant="neutral" className="text-[10px]">
                {wr.name}
              </Badge>
            ))}
            {overflow > 0 && (
              <Badge variant="neutral" className="text-[10px]">
                +{overflow}
              </Badge>
            )}
          </div>
        );
        // The cell doubles as a shortcut into the Manage-roles dialog for anyone
        // who can manage members (mirrors the ActionMenu entry).
        if (!can(Permission.ORG_MANAGE_MEMBERS)) return chips;
        return (
          <button
            type="button"
            className="cursor-pointer rounded-sm text-left transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
            onClick={() => openRoleDialog(row.original)}
            aria-label={`Manage roles for ${row.original.name}`}
          >
            {chips}
          </button>
        );
      },
    },
    {
      accessorKey: "joined",
      header: "Joined",
      // Fixed locale + UTC so the server and client render the same string —
      // a bare toLocaleDateString() uses the runtime timezone and caused a
      // hydration mismatch (this is a server-rendered client component).
      cell: ({ row }) =>
        new Date(row.original.joined).toLocaleDateString("en-US", {
          timeZone: "UTC",
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
    },
    {
      id: "actions",
      header: () => <div className="text-right">Actions</div>,
      enableSorting: false,
      // Reuse rowActions so the inline ⋯ and the right-click menu can never drift
      // (also drops the old non-functional "View profile" stub).
      cell: ({ row }) => (
        <div className="flex justify-end group/action">
          <ActionMenu groups={rowActions(row.original)}>
            <span />
          </ActionMenu>
        </div>
      ),
    },
  ];

  return (
    <>
      <DataTable columns={columns} data={rows} rowActions={rowActions} />

      {roleDialogTarget && (
        <TeamRoleDialog
          orgId={orgId}
          member={roleDialogTarget}
          workRoleOptions={workRoleOptions}
          grantableRoleIds={grantableRoleIds}
          onClose={() => setRoleDialogTarget(null)}
        />
      )}

      <Dialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open && !confirmPending) setConfirmTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {confirmTarget?.action === "remove"
                ? "Remove from organization?"
                : confirmTarget?.action === "delete-account"
                  ? "Delete this account?"
                  : "Revoke invitation?"}
            </DialogTitle>
          </DialogHeader>
          <p className="py-1 text-sm text-muted-foreground">
            {confirmTarget?.action === "remove" ? (
              <>
                This removes <strong>{confirmTarget?.name}</strong> from the
                organization and revokes their access. This cannot be undone.
              </>
            ) : confirmTarget?.action === "delete-account" ? (
              <>
                This permanently deletes <strong>{confirmTarget?.name}</strong>
                &apos;s account across <em>every</em> organization: all sessions,
                memberships, sign-in methods and the allowlist entry are revoked,
                and their profile is anonymized. Work they authored stays but is
                attributed to a &ldquo;Deleted user.&rdquo; Their email is freed
                so it can be invited again. This cannot be undone.
              </>
            ) : (
              <>
                This revokes the pending invitation for{" "}
                <strong>{confirmTarget?.name}</strong>. They&apos;ll need a new
                invite to join.
              </>
            )}
          </p>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmTarget(null)}
              disabled={confirmPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={runConfirm}
              disabled={confirmPending}
            >
              {confirmPending
                ? confirmTarget?.action === "remove"
                  ? "Removing…"
                  : confirmTarget?.action === "delete-account"
                    ? "Deleting…"
                    : "Revoking…"
                : confirmTarget?.action === "remove"
                  ? "Remove"
                  : confirmTarget?.action === "delete-account"
                    ? "Delete account"
                    : "Revoke"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
