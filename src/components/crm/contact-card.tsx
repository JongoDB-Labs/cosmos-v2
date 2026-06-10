"use client";

import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { DollarSign, Pencil, Trash2 } from "lucide-react";
import { ActionMenu, type ActionMenuGroup } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { activateOnKey } from "@/lib/a11y/keyboard";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { jsonFetch } from "@/lib/query/json-fetcher";
import type { CrmContact, OrgMember } from "@/types/models";

interface ContactCardProps {
  contact: CrmContact;
  members: OrgMember[];
  onClick: (contact: CrmContact) => void;
  /**
   * Called after a successful delete so a parent that owns the contact list
   * (e.g. PipelineBoard's local state) can drop the removed contact. The CRM
   * contacts query is also invalidated, so React-Query-backed consumers update
   * automatically without this callback.
   */
  onDelete?: (contactId: string) => void;
}

export function ContactCard({ contact, members, onClick, onDelete }: ContactCardProps) {
  const { can, orgId } = usePermissions();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const deleteContact = useOrgMutation<void, Error, void>({
    mutationFn: () =>
      jsonFetch<void>(`/api/v1/orgs/${orgId}/crm/contacts/${contact.id}`, {
        method: "DELETE",
      }),
    invalidate: [["crm", "contacts"]],
    onSuccess: () => {
      setConfirmOpen(false);
      onDelete?.(contact.id);
    },
  });

  const owner = members.find((m) => m.id === contact.ownerId);
  const ownerName = owner?.user?.displayName ?? "Unassigned";
  const ownerAvatar = owner?.user?.avatarUrl ?? null;
  const ownerInitials = ownerName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  const groups: ActionMenuGroup[] = [
    {
      items: [
        ...(can(Permission.CRM_UPDATE)
          ? [
              {
                label: "Edit",
                icon: Pencil,
                onClick: () => onClick(contact),
              },
            ]
          : []),
      ],
    },
    {
      items: [
        ...(can(Permission.CRM_DELETE)
          ? [
              {
                label: "Delete",
                icon: Trash2,
                variant: "destructive" as const,
                onClick: () => setConfirmOpen(true),
              },
            ]
          : []),
      ],
    },
  ];

  return (
    <>
      <ActionMenu groups={groups}>
        <div
          role="button"
          tabIndex={0}
          aria-label={`Open contact ${contact.name}`}
          className="group/action rounded-lg border bg-card p-3 cursor-pointer hover:border-primary/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onClick(contact)}
          onKeyDown={activateOnKey(() => onClick(contact))}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{contact.name}</p>
              {contact.company && (
                <p className="text-xs text-muted-foreground truncate">
                  {contact.company}
                </p>
              )}
            </div>
            <Avatar className="h-5 w-5 shrink-0">
              <AvatarImage src={ownerAvatar ?? undefined} />
              <AvatarFallback className="text-[8px]">{ownerInitials}</AvatarFallback>
            </Avatar>
          </div>

          {contact.dealValue != null && Number(contact.dealValue) > 0 && (
            <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground">
              <DollarSign className="h-3 w-3" />
              <span className="font-medium text-foreground">
                {Number(contact.dealValue).toLocaleString()}
              </span>
            </div>
          )}
        </div>
      </ActionMenu>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) setConfirmOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete contact?</DialogTitle>
            <DialogDescription>
              This will permanently delete{" "}
              <span className="font-medium">{contact.name}</span>. This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={deleteContact.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteContact.mutate()}
              disabled={deleteContact.isPending}
            >
              {deleteContact.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
