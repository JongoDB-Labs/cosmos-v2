"use client";

import { useState, useEffect } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import type { CrmContact, OrgMember } from "@/types/models";
import { notifyError } from "@/lib/errors/notify";

interface ContactDetailSheetProps {
  contact: CrmContact | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  members: OrgMember[];
  onUpdate: (updated: CrmContact) => void;
  onDelete: (contactId: string) => void;
}

const stageOptions: { value: CrmContact["stage"]; label: string }[] = [
  { value: "LEAD", label: "Lead" },
  { value: "QUALIFIED", label: "Qualified" },
  { value: "PROPOSAL", label: "Proposal" },
  { value: "NEGOTIATION", label: "Negotiation" },
  { value: "CLOSED_WON", label: "Closed Won" },
  { value: "CLOSED_LOST", label: "Closed Lost" },
];

export function ContactDetailSheet({
  contact,
  open,
  onOpenChange,
  orgId,
  members,
  onUpdate,
  onDelete,
}: ContactDetailSheetProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");
  const [title, setTitle] = useState("");
  const [stage, setStage] = useState<CrmContact["stage"]>("LEAD");
  const [dealValue, setDealValue] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { can } = usePermissions();

  // Intentional "derive state from prop" sync — fires only when the `contact`
  // reference changes (same pattern as card-detail-sheet).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (contact) {
      setName(contact.name);
      setEmail(contact.email ?? "");
      setPhone(contact.phone ?? "");
      setCompany(contact.company ?? "");
      setTitle(contact.title ?? "");
      setStage(contact.stage);
      setDealValue(contact.dealValue != null ? String(contact.dealValue) : "");
      setOwnerId(contact.ownerId ?? "");
      setNotes(contact.notes ?? "");
      setErrors({});
    }
  }, [contact]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function handleSave() {
    if (!contact) return;

    // Client-side validation runs before the API call. Server-error handling
    // (notifyError below) still covers failures that get past these checks.
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Name is required";
    if (email.trim() && !email.includes("@")) next.email = "Enter a valid email";
    if (dealValue.trim() && Number.isNaN(Number(dealValue)))
      next.dealValue = "Enter a valid number";

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSaving(true);

    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/crm/contacts/${contact.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email: email || null,
          phone: phone || null,
          company: company || null,
          title: title || null,
          stage,
          dealValue: dealValue ? parseFloat(dealValue) : null,
          ownerId: ownerId || null,
          notes: notes || null,
        }),
      });

      if (!res.ok) throw new Error("Failed to update contact");

      const updated: CrmContact = await res.json();
      onUpdate(updated);
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save contact:", err);
      notifyError(err, "Couldn't save the contact.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!contact) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/crm/contacts/${contact.id}`, {
        method: "DELETE",
      });

      if (!res.ok) throw new Error("Failed to delete contact");

      setConfirmDelete(false);
      onDelete(contact.id);
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to delete contact:", err);
      notifyError(err, "Couldn't delete the contact.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{contact ? "Edit Contact" : "Contact"}</SheetTitle>
          <SheetDescription>
            Update contact details and deal information.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-4">
          <FormField label="Name" required error={errors.name}>
            {(p) => (
              <Input
                {...p}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setErrors((prev) => ({ ...prev, name: "" }));
                }}
                placeholder="Contact name"
              />
            )}
          </FormField>

          <FormField label="Email" error={errors.email}>
            {(p) => (
              <Input
                {...p}
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setErrors((prev) => ({ ...prev, email: "" }));
                }}
                placeholder="email@example.com"
              />
            )}
          </FormField>

          <FormField label="Phone">
            {(p) => (
              <Input
                {...p}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 (555) 000-0000"
              />
            )}
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Company">
              {(p) => (
                <Input
                  {...p}
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="Company"
                />
              )}
            </FormField>
            <FormField label="Title">
              {(p) => (
                <Input
                  {...p}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Job title"
                />
              )}
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Stage">
              {(p) => (
                <Select value={stage} onValueChange={(v) => setStage(v as CrmContact["stage"])}>
                  <SelectTrigger {...p} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {stageOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormField label="Deal Value" error={errors.dealValue}>
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  value={dealValue}
                  onChange={(e) => {
                    setDealValue(e.target.value);
                    setErrors((prev) => ({ ...prev, dealValue: "" }));
                  }}
                  placeholder="0"
                />
              )}
            </FormField>
          </div>

          <FormField label="Owner">
            {(p) => (
              <Select value={ownerId} onValueChange={(v) => setOwnerId(v ?? "")}>
                <SelectTrigger {...p} className="w-full">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Unassigned</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.user?.displayName ?? m.userId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>

          <FormField label="Notes">
            {(p) => (
              <Textarea
                {...p}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add notes..."
                rows={3}
              />
            )}
          </FormField>
        </div>

        <SheetFooter>
          <div className="flex items-center justify-between w-full">
            {can(Permission.CRM_DELETE) ? (
              <Button
                variant="destructive"
                onClick={() => setConfirmDelete(true)}
                disabled={deleting}
              >
                Delete
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </SheetFooter>
      </SheetContent>

      <Dialog
        open={confirmDelete}
        onOpenChange={(o) => {
          if (!deleting) setConfirmDelete(o);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete contact?</DialogTitle>
            <DialogDescription>
              This permanently deletes{" "}
              {contact?.name ? `"${contact.name}"` : "this contact"} and its CRM
              record. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sheet>
  );
}
