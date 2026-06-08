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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { Shield, User, UserMinus } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

// Every non-OWNER OrgRole is assignable here (ownership transfer is a separate
// flow). Keep in sync with the OrgRole enum so a member's current role — e.g.
// GUEST — is always representable in the dialog.
const ASSIGNABLE_ROLES: Record<string, string> = {
  ADMIN: "Admin",
  BILLING_ADMIN: "Billing Admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
  GUEST: "Guest",
};

type Row = {
  kind: "member" | "invite";
  id: string;
  name: string;
  email: string;
  role: string;
  joined: string;
  avatarUrl: string | null;
};

const ROLE_VARIANT = {
  OWNER: "strategic",
  ADMIN: "progress",
  MEMBER: "neutral",
  VIEWER: "neutral",
} as const;

export function TeamTable({ rows }: { rows: Row[] }) {
  const { can, orgId } = usePermissions();
  const router = useRouter();
  const [roleTarget, setRoleTarget] = useState<{
    id: string;
    name: string;
    role: string;
  } | null>(null);
  const [savingRole, setSavingRole] = useState(false);

  const handleChangeRole = async () => {
    if (!roleTarget) return;
    setSavingRole(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/members/${roleTarget.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: roleTarget.role }),
      });
      if (!res.ok) throw new Error(`Failed to change role (HTTP ${res.status})`);
      setRoleTarget(null);
      router.refresh();
    } catch (err) {
      console.error("Failed to change role", err);
      notifyError(err, "Couldn't change the member's role.");
    } finally {
      setSavingRole(false);
    }
  };

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

  // Surface each row's existing operations (change role / remove) as a
  // right-click context menu + trailing ⋯ column via DataTable's rowActions.
  // Reuses the same handlers + permission gate as the inline actions column.
  const rowActions = useCallback(
    (r: Row): ActionMenuGroup[] => {
      const isOwner = r.role === "OWNER";
      const isMember = r.kind === "member";
      const canManage = can(Permission.ORG_MANAGE_MEMBERS) && isMember && !isOwner;
      return [
        {
          items: canManage
            ? [
                {
                  label: "Change role",
                  icon: Shield,
                  onClick: () =>
                    setRoleTarget({ id: r.id, name: r.name, role: r.role }),
                },
              ]
            : [],
        },
        {
          items: canManage
            ? [
                {
                  label: "Remove from org",
                  icon: UserMinus,
                  variant: "destructive" as const,
                  onClick: () => handleRemoveMember(r.id),
                },
              ]
            : [],
        },
      ];
    },
    [can, handleRemoveMember],
  );

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
        return <Badge variant={variant}>{row.original.role}</Badge>;
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
      cell: ({ row }) => {
        const isOwner = row.original.role === "OWNER";
        const isMember = row.original.kind === "member";

        const groups: ActionMenuGroup[] = [
          {
            items: [
              ...(can(Permission.ORG_MANAGE_MEMBERS) && isMember && !isOwner
                ? [
                    {
                      label: "Change role",
                      icon: Shield,
                      onClick: () =>
                        setRoleTarget({
                          id: row.original.id,
                          name: row.original.name,
                          role: row.original.role,
                        }),
                    },
                  ]
                : []),
              {
                label: "View profile",
                icon: User,
                onClick: () =>
                  console.log("View profile", row.original.id),
              },
            ],
          },
          {
            items: [
              ...(can(Permission.ORG_MANAGE_MEMBERS) && isMember && !isOwner
                ? [
                    {
                      label: "Remove from org",
                      icon: UserMinus,
                      variant: "destructive" as const,
                      onClick: () => handleRemoveMember(row.original.id),
                    },
                  ]
                : []),
            ],
          },
        ];

        return (
          <div className="flex justify-end group/action">
            <ActionMenu groups={groups}>
              <span />
            </ActionMenu>
          </div>
        );
      },
    },
  ];

  return (
    <>
      <DataTable columns={columns} data={rows} rowActions={rowActions} />

      <Dialog
        open={roleTarget !== null}
        onOpenChange={(open) => !open && setRoleTarget(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Change role{roleTarget ? ` — ${roleTarget.name}` : ""}</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Select
              items={ASSIGNABLE_ROLES}
              value={roleTarget?.role ?? "MEMBER"}
              onValueChange={(v) =>
                setRoleTarget((prev) => (prev && v ? { ...prev, role: v } : prev))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(ASSIGNABLE_ROLES).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRoleTarget(null)}
              disabled={savingRole}
            >
              Cancel
            </Button>
            <Button onClick={handleChangeRole} disabled={savingRole}>
              {savingRole ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
