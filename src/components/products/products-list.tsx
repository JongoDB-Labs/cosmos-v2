"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/form-field";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
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
  Package,
} from "lucide-react";
import {
  usePermissions,
  Permission,
} from "@/components/providers/permissions-provider";

/**
 * Shape returned by GET /api/v1/orgs/[orgId]/products. The list route returns a
 * bare array (success(products)), each row including a `_count.contracts`. The
 * Product type in @/types/models is out of sync with this route (it omits
 * `category` and uses uppercase status enums), so we model the live response
 * here instead.
 */
interface Product {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  price: string | null;
  currency: string;
  status: string;
  category: string | null;
  createdAt: string;
  _count?: { contracts: number };
}

interface ProductsListProps {
  orgId: string;
}

/** Status values accepted by the API (defaults to "active"). */
const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "draft", label: "Draft" },
  { value: "archived", label: "Archived" },
] as const;

const STATUS_BADGE: Record<string, { label: string; variant: BadgeVariant }> = {
  active: { label: "Active", variant: "done" },
  draft: { label: "Draft", variant: "review" },
  archived: { label: "Archived", variant: "neutral" },
};

interface ProductFormData {
  name: string;
  sku: string;
  description: string;
  category: string;
  price: string;
  currency: string;
  status: string;
}

const emptyForm: ProductFormData = {
  name: "",
  sku: "",
  description: "",
  category: "",
  price: "",
  currency: "USD",
  status: "active",
};

function formatPrice(price: number | string | null, currency: string): string {
  if (price == null) return "—";
  const n = Number(price);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(n);
  } catch {
    // Intl throws on an unknown currency code; fall back to a plain format.
    return `${currency} ${n.toFixed(2)}`;
  }
}

function statusBadge(status: string) {
  return STATUS_BADGE[status] ?? { label: status, variant: "neutral" as BadgeVariant };
}

export function ProductsList({ orgId }: ProductsListProps) {
  const { can } = usePermissions();
  const canCreate = can(Permission.CRM_CREATE);
  const canUpdate = can(Permission.CRM_UPDATE);
  const canDelete = can(Permission.CRM_DELETE);

  const apiBase = `/api/v1/orgs/${orgId}/products`;
  const productsQueryKey = useOrgQueryKey("products");

  const {
    data: products = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: productsQueryKey,
    queryFn: () => jsonFetch<Product[]>(apiBase),
  });

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [form, setForm] = useState<ProductFormData>(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function clearError(field: string) {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  /**
   * Validate the create/edit form. Name is required; price (when present) must
   * be a non-negative number. Returns the per-field error map — empty means OK.
   */
  function validateForm(): Record<string, string> {
    const next: Record<string, string> = {};
    if (!form.name.trim()) {
      next.name = "Name is required";
    }
    if (form.price.trim()) {
      const parsed = Number(form.price);
      if (!Number.isFinite(parsed) || parsed < 0) {
        next.price = "Enter a valid price";
      }
    }
    return next;
  }

  /** Build the JSON body the products API expects from the form state. */
  function buildBody() {
    const trimmedPrice = form.price.trim();
    return {
      name: form.name.trim(),
      description: form.description.trim() || null,
      sku: form.sku.trim() || null,
      category: form.category.trim() || null,
      price: trimmedPrice ? Number(trimmedPrice) : null,
      currency: form.currency.trim() || "USD",
      status: form.status,
    };
  }

  function openCreateDialog() {
    setForm(emptyForm);
    setErrors({});
    setCreateDialogOpen(true);
  }

  function openEditDialog(product: Product) {
    setEditing(product);
    setForm({
      name: product.name,
      sku: product.sku ?? "",
      description: product.description ?? "",
      category: product.category ?? "",
      price: product.price != null ? String(product.price) : "",
      currency: product.currency || "USD",
      status: product.status || "active",
    });
    setErrors({});
    setEditDialogOpen(true);
  }

  function openDeleteDialog(product: Product) {
    setDeleting(product);
    setDeleteDialogOpen(true);
  }

  const createMutation = useOrgMutation<Product, Error, ReturnType<typeof buildBody>>({
    mutationFn: (payload) =>
      jsonFetch(apiBase, { method: "POST", body: JSON.stringify(payload) }),
    invalidate: [["products"]],
    onSuccess: () => {
      setCreateDialogOpen(false);
      setForm(emptyForm);
    },
    onError: (err) => notifyError(err, "Couldn't create the product."),
  });

  const updateMutation = useOrgMutation<
    Product,
    Error,
    { id: string; body: ReturnType<typeof buildBody> }
  >({
    mutationFn: ({ id, body }) =>
      jsonFetch(`${apiBase}/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    invalidate: [["products"]],
    onSuccess: () => {
      setEditDialogOpen(false);
      setEditing(null);
    },
    onError: (err) => notifyError(err, "Couldn't update the product."),
  });

  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    invalidate: [["products"]],
    onSuccess: () => {
      setDeleteDialogOpen(false);
      setDeleting(null);
    },
    onError: (err) => notifyError(err, "Couldn't delete the product."),
  });

  const submitting =
    createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  function handleCreate() {
    const next = validateForm();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    createMutation.mutate(buildBody());
  }

  function handleEdit() {
    if (!editing) return;
    const next = validateForm();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    updateMutation.mutate({ id: editing.id, body: buildBody() });
  }

  function handleDelete() {
    if (!deleting) return;
    deleteMutation.mutate(deleting.id);
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <div className="flex justify-end">
          <Skeleton className="h-8 w-32" />
        </div>
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <LoadError
          onRetry={() => {
            void refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      {canCreate && (
        <div className="flex justify-end">
          <Button onClick={openCreateDialog}>
            <Plus className="size-4" />
            New product
          </Button>
        </div>
      )}

      {products.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No products yet"
          description="Add your first product or service to start building your catalog."
          action={
            canCreate ? (
              <Button size="sm" onClick={openCreateDialog}>
                <Plus className="size-4" />
                New product
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30 text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">SKU</th>
                <th className="px-4 py-2.5">Category</th>
                <th className="px-4 py-2.5 text-right">Price</th>
                <th className="px-4 py-2.5">Status</th>
                {(canUpdate || canDelete) && (
                  <th className="px-4 py-2.5 text-right">Actions</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y">
              {products.map((product) => {
                const badge = statusBadge(product.status);
                return (
                  <tr key={product.id} className="transition-colors hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div className="flex flex-col">
                        <span className="font-medium">{product.name}</span>
                        {product.description && (
                          <span className="line-clamp-1 text-xs text-muted-foreground">
                            {product.description}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {product.sku ? (
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {product.sku}
                        </code>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {product.category ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatPrice(product.price, product.currency)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </td>
                    {(canUpdate || canDelete) && (
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {canUpdate && (
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => openEditDialog(product)}
                              title="Edit"
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                          )}
                          {canDelete && (
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => openDeleteDialog(product)}
                              title="Delete"
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New product</DialogTitle>
            <DialogDescription>Add a product or service to the catalog.</DialogDescription>
          </DialogHeader>
          <ProductForm form={form} setForm={setForm} errors={errors} clearError={clearError} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={submitting || !form.name.trim()}>
              {createMutation.isPending && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit product</DialogTitle>
            <DialogDescription>Update this product&apos;s details.</DialogDescription>
          </DialogHeader>
          <ProductForm form={form} setForm={setForm} errors={errors} clearError={clearError} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={submitting || !form.name.trim()}>
              {updateMutation.isPending && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-destructive" />
              Delete product
            </DialogTitle>
            <DialogDescription>
              {deleting
                ? `Are you sure you want to delete "${deleting.name}"? This can't be undone.`
                : "Are you sure you want to delete this product? This can't be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={submitting}>
              {deleteMutation.isPending && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProductForm({
  form,
  setForm,
  errors,
  clearError,
}: {
  form: ProductFormData;
  setForm: React.Dispatch<React.SetStateAction<ProductFormData>>;
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
            placeholder="e.g. Pro subscription"
            onChange={(e) => {
              setForm((f) => ({ ...f, name: e.target.value }));
              clearError("name");
            }}
          />
        )}
      </FormField>

      <div className="grid grid-cols-2 gap-4">
        <FormField label="SKU">
          {(p) => (
            <Input
              {...p}
              value={form.sku}
              placeholder="e.g. PRO-001"
              onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
            />
          )}
        </FormField>
        <FormField label="Category">
          {(p) => (
            <Input
              {...p}
              value={form.category}
              placeholder="e.g. Software"
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            />
          )}
        </FormField>
      </div>

      <div className="grid grid-cols-[1fr_7rem] gap-4">
        <FormField label="Price" error={errors.price}>
          {(p) => (
            <Input
              {...p}
              type="number"
              min="0"
              step="0.01"
              value={form.price}
              placeholder="0.00"
              onChange={(e) => {
                setForm((f) => ({ ...f, price: e.target.value }));
                clearError("price");
              }}
            />
          )}
        </FormField>
        <FormField label="Currency">
          {(p) => (
            <Input
              {...p}
              value={form.currency}
              placeholder="USD"
              maxLength={10}
              onChange={(e) =>
                setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))
              }
            />
          )}
        </FormField>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium" id="product-status-label">
          Status
        </label>
        <Select
          value={form.status}
          onValueChange={(v) => setForm((f) => ({ ...f, status: v ?? "active" }))}
        >
          <SelectTrigger className="w-full" aria-labelledby="product-status-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-1.5 text-sm font-medium" htmlFor="product-description">
          <Package className="size-3.5 text-muted-foreground" />
          Description
        </label>
        <Textarea
          id="product-description"
          value={form.description}
          placeholder="What is this product or service?"
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
        />
      </div>
    </div>
  );
}
