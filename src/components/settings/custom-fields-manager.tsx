"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  AlertTriangle,
  ListFilter,
} from "lucide-react";
import type { CustomField, CustomFieldType } from "@/types/models";
import { notifyError } from "@/lib/errors/notify";
import { LoadError } from "@/components/ui/load-error";

const fieldTypeOptions: { value: CustomFieldType; label: string }[] = [
  { value: "TEXT", label: "Text" },
  { value: "NUMBER", label: "Number" },
  { value: "DATE", label: "Date" },
  { value: "SELECT", label: "Select" },
  { value: "MULTI_SELECT", label: "Multi-Select" },
  { value: "CHECKBOX", label: "Checkbox" },
  { value: "URL", label: "URL" },
  { value: "EMAIL", label: "Email" },
  { value: "USER", label: "User" },
];

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

interface CustomFieldsManagerProps {
  orgId: string;
}

export function CustomFieldsManager({ orgId }: CustomFieldsManagerProps) {
  const [fields, setFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingField, setEditingField] = useState<CustomField | null>(null);
  const [deletingField, setDeletingField] = useState<CustomField | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [formName, setFormName] = useState("");
  const [formKey, setFormKey] = useState("");
  const [formType, setFormType] = useState<CustomFieldType>("TEXT");
  const [formOptions, setFormOptions] = useState("");
  const [formRequired, setFormRequired] = useState(false);
  const [keyTouched, setKeyTouched] = useState(false);

  const apiBase = `/api/v1/orgs/${orgId}/custom-fields`;

  const fetchFields = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(apiBase);
      if (!res.ok) throw new Error();
      const json = await res.json();
      setFields(Array.isArray(json) ? json : json.data ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchFields();
  }, [fetchFields]);

  function openCreateDialog() {
    setEditingField(null);
    setFormName("");
    setFormKey("");
    setFormType("TEXT");
    setFormOptions("");
    setFormRequired(false);
    setKeyTouched(false);
    setDialogOpen(true);
  }

  function openEditDialog(field: CustomField) {
    setEditingField(field);
    setFormName(field.name);
    setFormKey(field.key);
    setFormType(field.fieldType);
    setFormOptions(field.options.join(", "));
    setFormRequired(field.required);
    setKeyTouched(true);
    setDialogOpen(true);
  }

  function openDeleteDialog(field: CustomField) {
    setDeletingField(field);
    setDeleteDialogOpen(true);
  }

  async function handleSubmit() {
    if (!formName.trim()) return;

    setSubmitting(true);
    try {
      const payload = {
        name: formName.trim(),
        key: formKey.trim() || slugify(formName),
        fieldType: formType,
        options:
          formType === "SELECT" || formType === "MULTI_SELECT"
            ? formOptions
                .split(",")
                .map((o) => o.trim())
                .filter(Boolean)
            : [],
        required: formRequired,
      };

      if (editingField) {
        // Update — only name, options, required are editable
        const res = await fetch(`${apiBase}/${editingField.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: payload.name,
            options: payload.options,
            required: payload.required,
          }),
        });
        if (!res.ok) throw new Error("Couldn't update the custom field.");
      } else {
        const res = await fetch(apiBase, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error("Couldn't create the custom field.");
      }

      setDialogOpen(false);
      await fetchFields();
    } catch (err) {
      console.error(err);
      notifyError(err, "Couldn't save the custom field.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!deletingField) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${apiBase}/${deletingField.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        // Optimistically remove from local state instead of re-fetching the
        // full list — the row vanishes immediately and we save a round-trip.
        setFields((prev) => prev.filter((f) => f.id !== deletingField.id));
        setDeleteDialogOpen(false);
        setDeletingField(null);
      } else {
        throw new Error("Couldn't delete the custom field.");
      }
    } catch (err) {
      console.error(err);
      notifyError(err, "Couldn't delete the custom field.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadError onRetry={() => { void fetchFields(); }} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <Button onClick={openCreateDialog}>
          <Plus className="h-4 w-4 mr-1" />
          Add Field
        </Button>
      </div>

      {/* Fields table */}
      {fields.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 gap-3 rounded-lg border border-dashed">
          <ListFilter className="h-10 w-10 text-muted-foreground/40" />
          <div className="text-center">
            <p className="text-sm font-medium text-muted-foreground">
              No custom fields yet
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Create your first custom field to extend work items
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left font-medium px-4 py-2.5">Name</th>
                <th className="text-left font-medium px-4 py-2.5">Key</th>
                <th className="text-left font-medium px-4 py-2.5">Type</th>
                <th className="text-left font-medium px-4 py-2.5">Required</th>
                <th className="text-right font-medium px-4 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((field) => (
                <tr key={field.id} className="border-b last:border-b-0 hover:bg-muted/30">
                  <td className="px-4 py-2.5 font-medium">{field.name}</td>
                  <td className="px-4 py-2.5">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                      {field.key}
                    </code>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant="neutral" className="text-xs">
                      {field.fieldType.replace("_", " ")}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    {field.required ? (
                      <Badge variant="done" className="text-xs">Yes</Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">No</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => openEditDialog(field)}
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => openDeleteDialog(field)}
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingField ? "Edit Field" : "Add Custom Field"}
            </DialogTitle>
            <DialogDescription>
              {editingField
                ? "Update the field name and options. Key and type cannot be changed."
                : "Define a new custom field for work items."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            {/* Name */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="field-name">Name</Label>
              <Input
                id="field-name"
                value={formName}
                onChange={(e) => {
                  setFormName(e.target.value);
                  if (!keyTouched) {
                    setFormKey(slugify(e.target.value));
                  }
                }}
                placeholder="e.g. Department"
              />
            </div>

            {/* Key */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="field-key">Key</Label>
              <Input
                id="field-key"
                value={formKey}
                onChange={(e) => {
                  setFormKey(e.target.value);
                  setKeyTouched(true);
                }}
                placeholder="auto-generated from name"
                disabled={!!editingField}
                className={cn(editingField && "opacity-60")}
              />
              <p className="text-[11px] text-muted-foreground">
                Used as the field identifier in the API
              </p>
            </div>

            {/* Type */}
            <div className="flex flex-col gap-1.5">
              <Label>Type</Label>
              <Select
                value={formType}
                onValueChange={(val) => setFormType(val as CustomFieldType)}
                disabled={!!editingField}
              >
                <SelectTrigger className={cn("w-full", editingField && "opacity-60")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {fieldTypeOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Options (for Select/Multi-Select) */}
            {(formType === "SELECT" || formType === "MULTI_SELECT") && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="field-options">Options</Label>
                <Input
                  id="field-options"
                  value={formOptions}
                  onChange={(e) => setFormOptions(e.target.value)}
                  placeholder="Option A, Option B, Option C"
                />
                <p className="text-[11px] text-muted-foreground">
                  Comma-separated list of options
                </p>
              </div>
            )}

            {/* Required toggle */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                role="switch"
                aria-checked={formRequired}
                onClick={() => setFormRequired((r) => !r)}
                className={cn(
                  "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                  formRequired ? "bg-primary" : "bg-muted"
                )}
              >
                <span
                  className={cn(
                    "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm transition-transform",
                    formRequired ? "translate-x-4" : "translate-x-0"
                  )}
                />
              </button>
              <Label className="cursor-pointer" onClick={() => setFormRequired((r) => !r)}>
                Required field
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!formName.trim() || submitting}>
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
              {editingField ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Field
            </DialogTitle>
            <DialogDescription>
              Delete field{" "}
              <strong>&ldquo;{deletingField?.name}&rdquo;</strong>? Work items
              using this field will lose their values.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={submitting}>
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
