"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { EmptyState } from "@/components/ui/empty-state";
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
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  AlertTriangle,
  Globe,
  Mail,
  Phone,
  User,
} from "lucide-react";

/**
 * Shape returned by `GET /api/v1/orgs/[orgId]/partners` (a bare array). The
 * `Partner` type in `@/types/models` is stale (wrong field names / no status),
 * so we model the actual API response locally to match the Prisma `Partner`
 * model + the route's `_count`.
 */
interface Partner {
  id: string;
  orgId: string;
  name: string;
  type: string;
  status: string;
  website: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { contracts: number };
}

interface PartnersListProps {
  orgId: string;
}

const TYPE_OPTIONS = [
  { value: "vendor", label: "Vendor" },
  { value: "client", label: "Client" },
  { value: "contractor", label: "Contractor" },
  { value: "partner", label: "Partner" },
  { value: "other", label: "Other" },
] as const;

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "prospect", label: "Prospect" },
  { value: "archived", label: "Archived" },
] as const;

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  active: "done",
  prospect: "progress",
  inactive: "neutral",
  archived: "neutral",
};

function typeLabel(type: string): string {
  return TYPE_OPTIONS.find((t) => t.value === type)?.label ?? type;
}

function statusLabel(status: string): string {
  return STATUS_OPTIONS.find((s) => s.value === status)?.label ?? status;
}

interface PartnerFormData {
  name: string;
  type: string;
  status: string;
  website: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
}

const emptyForm: PartnerFormData = {
  name: "",
  type: "vendor",
  status: "active",
  website: "",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
  notes: "",
};

function formFromPartner(p: Partner): PartnerFormData {
  return {
    name: p.name,
    type: p.type,
    status: p.status,
    website: p.website ?? "",
    contactName: p.contactName ?? "",
    contactEmail: p.contactEmail ?? "",
    contactPhone: p.contactPhone ?? "",
    notes: p.notes ?? "",
  };
}

/**
 * Build the request body, trimming strings and converting empty optionals to
 * null so the server's zod schema (which accepts nullish / empty-string) clears
 * the field rather than storing whitespace.
 */
function formToBody(form: PartnerFormData) {
  const trimOrNull = (v: string) => {
    const t = v.trim();
    return t === "" ? null : t;
  };
  return {
    name: form.name.trim(),
    type: form.type,
    status: form.status,
    website: trimOrNull(form.website),
    contactName: trimOrNull(form.contactName),
    contactEmail: trimOrNull(form.contactEmail),
    contactPhone: trimOrNull(form.contactPhone),
    notes: trimOrNull(form.notes),
  };
}

export function PartnersList({ orgId }: PartnersListProps) {
  const { can } = usePermissions();
  const canCreate = can(Permission.CRM_CREATE);
  const canUpdate = can(Permission.CRM_UPDATE);
  const canDelete = can(Permission.CRM_DELETE);

  const apiBase = `/api/v1/orgs/${orgId}/partners`;

  const partnersQueryKey = useOrgQueryKey("partners", "list");
  const {
    data: partners = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: partnersQueryKey,
    queryFn: () => jsonFetch<Partner[]>(apiBase),
  });

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editingPartner, setEditingPartner] = useState<Partner | null>(null);
  const [deletingPartner, setDeletingPartner] = useState<Partner | null>(null);
  const [form, setForm] = useState<PartnerFormData>(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function validate(): Record<string, string> {
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = "Name is required";
    const email = form.contactEmail.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      next.contactEmail = "Enter a valid email";
    }
    const website = form.website.trim();
    if (website && !/^https?:\/\//i.test(website)) {
      next.website = "Enter a valid URL (http:// or https://)";
    }
    return next;
  }

  function clearError(field: string) {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function openCreateDialog() {
    setForm(emptyForm);
    setErrors({});
    setCreateDialogOpen(true);
  }

  function openEditDialog(partner: Partner) {
    setEditingPartner(partner);
    setForm(formFromPartner(partner));
    setErrors({});
  }

  const createMutation = useOrgMutation<Partner, Error, PartnerFormData>({
    mutationFn: (data) =>
      jsonFetch(apiBase, {
        method: "POST",
        body: JSON.stringify(formToBody(data)),
      }),
    invalidate: [["partners", "list"]],
    onSuccess: () => {
      setCreateDialogOpen(false);
      setForm(emptyForm);
    },
    onError: (err) => notifyError(err, "Couldn't create the partner."),
  });

  const updateMutation = useOrgMutation<
    Partner,
    Error,
    { id: string; data: PartnerFormData }
  >({
    mutationFn: ({ id, data }) =>
      jsonFetch(`${apiBase}/${id}`, {
        method: "PUT",
        body: JSON.stringify(formToBody(data)),
      }),
    invalidate: [["partners", "list"]],
    onSuccess: () => {
      setEditingPartner(null);
    },
    onError: (err) => notifyError(err, "Couldn't update the partner."),
  });

  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    invalidate: [["partners", "list"]],
    onSuccess: () => {
      setDeletingPartner(null);
    },
    onError: (err) => notifyError(err, "Couldn't delete the partner."),
  });

  const submitting = createMutation.isPending || updateMutation.isPending;

  function handleCreate() {
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    createMutation.mutate(form);
  }

  function handleEdit() {
    if (!editingPartner) return;
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    updateMutation.mutate({ id: editingPartner.id, data: form });
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex justify-end">
          <Skeleton className="h-9 w-32" />
        </div>
        <div className="flex flex-col gap-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col gap-6">
        <LoadError
          onRetry={() => {
            void refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {canCreate && (
        <div className="flex justify-end">
          <Button onClick={openCreateDialog}>
            <Plus className="size-4" />
            New partner
          </Button>
        </div>
      )}

      {partners.length === 0 ? (
        <EmptyState
          title="No partners yet"
          description="Track the vendors, clients, and contractors your organization works with."
          action={
            canCreate ? (
              <Button onClick={openCreateDialog}>
                <Plus className="size-4" />
                New partner
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {partners.map((partner) => (
            <PartnerCard
              key={partner.id}
              partner={partner}
              canUpdate={canUpdate}
              canDelete={canDelete}
              onEdit={() => openEditDialog(partner)}
              onDelete={() => setDeletingPartner(partner)}
            />
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New partner</DialogTitle>
            <DialogDescription>
              Add a vendor, client, or contractor to your organization.
            </DialogDescription>
          </DialogHeader>
          <PartnerForm form={form} setForm={setForm} errors={errors} clearError={clearError} />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateDialogOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={submitting || !form.name.trim()}>
              {createMutation.isPending && (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              )}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        open={editingPartner !== null}
        onOpenChange={(open) => {
          if (!open) setEditingPartner(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit partner</DialogTitle>
            <DialogDescription>Update partner details and contact info.</DialogDescription>
          </DialogHeader>
          <PartnerForm form={form} setForm={setForm} errors={errors} clearError={clearError} />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditingPartner(null)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={submitting || !form.name.trim()}>
              {updateMutation.isPending && (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              )}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog
        open={deletingPartner !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingPartner(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-destructive" />
              Delete partner
            </DialogTitle>
            <DialogDescription>
              This will permanently delete{" "}
              <span className="font-medium">{deletingPartner?.name}</span>. This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeletingPartner(null)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deletingPartner) deleteMutation.mutate(deletingPartner.id);
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PartnerCard({
  partner,
  canUpdate,
  canDelete,
  onEdit,
  onDelete,
}: {
  partner: Partner;
  canUpdate: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const contractCount = partner._count?.contracts ?? 0;
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border bg-background p-4">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{partner.name}</span>
          <Badge variant="neutral" showDot={false} className="capitalize">
            {typeLabel(partner.type)}
          </Badge>
          <Badge variant={STATUS_VARIANT[partner.status] ?? "neutral"}>
            {statusLabel(partner.status)}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {partner.contactName && (
            <span className="flex items-center gap-1.5">
              <User className="size-3.5" />
              {partner.contactName}
            </span>
          )}
          {partner.contactEmail && (
            <a
              href={`mailto:${partner.contactEmail}`}
              className="flex items-center gap-1.5 hover:text-foreground hover:underline"
            >
              <Mail className="size-3.5" />
              {partner.contactEmail}
            </a>
          )}
          {partner.contactPhone && (
            <span className="flex items-center gap-1.5">
              <Phone className="size-3.5" />
              {partner.contactPhone}
            </span>
          )}
          {partner.website && (
            <a
              href={partner.website}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:text-foreground hover:underline"
            >
              <Globe className="size-3.5" />
              Website
            </a>
          )}
          {contractCount > 0 && (
            <span>
              {contractCount} contract{contractCount !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {partner.notes && (
          <p className="line-clamp-2 text-sm text-muted-foreground">{partner.notes}</p>
        )}
      </div>

      {(canUpdate || canDelete) && (
        <div className="flex shrink-0 items-center gap-1">
          {canUpdate && (
            <Button variant="ghost" size="icon-xs" onClick={onEdit} title="Edit partner">
              <Pencil className="size-3.5" />
            </Button>
          )}
          {canDelete && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onDelete}
              title="Delete partner"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function PartnerForm({
  form,
  setForm,
  errors,
  clearError,
}: {
  form: PartnerFormData;
  setForm: React.Dispatch<React.SetStateAction<PartnerFormData>>;
  errors: Record<string, string>;
  clearError: (field: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4 py-2">
      <FormField label="Name" required error={errors.name}>
        {(p) => (
          <Input
            {...p}
            value={form.name}
            onChange={(e) => {
              setForm((f) => ({ ...f, name: e.target.value }));
              clearError("name");
            }}
            placeholder="e.g. Acme Corp"
          />
        )}
      </FormField>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" id="partner-type-label">
            Type
          </label>
          <Select
            value={form.type}
            onValueChange={(val) => setForm((f) => ({ ...f, type: val ?? "vendor" }))}
          >
            <SelectTrigger className="w-full" aria-labelledby="partner-type-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPE_OPTIONS.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" id="partner-status-label">
            Status
          </label>
          <Select
            value={form.status}
            onValueChange={(val) => setForm((f) => ({ ...f, status: val ?? "active" }))}
          >
            <SelectTrigger className="w-full" aria-labelledby="partner-status-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <FormField label="Website" error={errors.website}>
        {(p) => (
          <Input
            {...p}
            type="url"
            value={form.website}
            onChange={(e) => {
              setForm((f) => ({ ...f, website: e.target.value }));
              clearError("website");
            }}
            placeholder="https://example.com"
          />
        )}
      </FormField>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Contact name">
          {(p) => (
            <Input
              {...p}
              value={form.contactName}
              onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))}
              placeholder="Jane Doe"
            />
          )}
        </FormField>

        <FormField label="Contact phone">
          {(p) => (
            <Input
              {...p}
              type="tel"
              value={form.contactPhone}
              onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value }))}
              placeholder="+1 555 123 4567"
            />
          )}
        </FormField>
      </div>

      <FormField label="Contact email" error={errors.contactEmail}>
        {(p) => (
          <Input
            {...p}
            type="email"
            value={form.contactEmail}
            onChange={(e) => {
              setForm((f) => ({ ...f, contactEmail: e.target.value }));
              clearError("contactEmail");
            }}
            placeholder="jane@example.com"
          />
        )}
      </FormField>

      <FormField label="Notes">
        {(p) => (
          <Textarea
            {...p}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            placeholder="Anything worth remembering about this partner"
          />
        )}
      </FormField>
    </div>
  );
}
