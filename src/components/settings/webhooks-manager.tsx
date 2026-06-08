"use client";

import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import type { ActionMenuGroup } from "@/components/ui/action-menu";
import { cn } from "@/lib/utils";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormField } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { DataTable } from "@/components/ui/data-table";
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
  Play,
  Power,
  Copy,
  Check,
  AlertTriangle,
  Webhook as WebhookIcon,
  CheckCircle2,
  XCircle,
  Clock,
} from "lucide-react";
import type { Webhook, WebhookDelivery } from "@/types/models";

const AVAILABLE_EVENTS = [
  "work_item.created",
  "work_item.updated",
  "work_item.completed",
  "sprint.started",
  "sprint.completed",
  "comment.created",
  "meeting.created",
  "meeting.completed",
];

interface WebhooksManagerProps {
  orgId: string;
}

export function WebhooksManager({ orgId }: WebhooksManagerProps) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [secretDialogOpen, setSecretDialogOpen] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<Webhook | null>(null);
  const [deletingWebhook, setDeletingWebhook] = useState<Webhook | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, WebhookDelivery[]>>({});
  const [loadingDeliveriesFor, setLoadingDeliveriesFor] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; success: boolean; message: string } | null>(null);
  const [createdSecret, setCreatedSecret] = useState("");
  const [copiedSecret, setCopiedSecret] = useState(false);

  const [formUrl, setFormUrl] = useState("");
  const [formEvents, setFormEvents] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const apiBase = `/api/v1/orgs/${orgId}/webhooks`;

  const webhooksQueryKey = useOrgQueryKey("webhooks", "list");
  const {
    data: webhooks = [],
    isLoading: loading,
    isError,
    refetch,
  } = useQuery({
    queryKey: webhooksQueryKey,
    queryFn: () => jsonFetch<Webhook[]>(apiBase),
  });

  async function fetchDeliveries(webhookId: string) {
    if (deliveries[webhookId]) return;
    setLoadingDeliveriesFor(webhookId);
    try {
      const res = await fetch(`${apiBase}/${webhookId}/deliveries`);
      if (res.ok) {
        const json = await res.json();
        setDeliveries((prev) => ({ ...prev, [webhookId]: json.data ?? [] }));
      }
    } finally {
      setLoadingDeliveriesFor(null);
    }
  }

  function openCreateDialog() {
    setFormUrl("");
    setFormEvents([]);
    setErrors({});
    setCreateDialogOpen(true);
  }

  function openEditDialog(webhook: Webhook) {
    setEditingWebhook(webhook);
    setFormUrl(webhook.url);
    setFormEvents([...webhook.events]);
    setErrors({});
    setEditDialogOpen(true);
  }

  /**
   * Validate the create/edit form. Returns the per-field error map; an empty
   * object means the form is valid. URL is required and must be http(s); at
   * least one event must be selected.
   */
  function validateForm(): Record<string, string> {
    const next: Record<string, string> = {};
    const url = formUrl.trim();
    if (!url) {
      next.url = "Payload URL is required";
    } else if (!/^https?:\/\//i.test(url)) {
      next.url = "Enter a valid URL";
    }
    if (formEvents.length === 0) {
      next.events = "Select at least one event";
    }
    return next;
  }

  function openDeleteDialog(webhook: Webhook) {
    setDeletingWebhook(webhook);
    setDeleteDialogOpen(true);
  }

  /** Clear a single field's error without disturbing the others. */
  function clearError(field: string) {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function toggleEvent(event: string) {
    setFormEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]
    );
    clearError("events");
  }

  const createMutation = useOrgMutation<
    { secret?: string } & Webhook,
    Error,
    { url: string; events: string[] }
  >({
    mutationFn: (payload) =>
      jsonFetch(apiBase, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    invalidate: [["webhooks", "list"]],
    onSuccess: (data) => {
      const secret = data?.secret ?? "";
      setCreatedSecret(secret);
      setCreateDialogOpen(false);
      if (secret) setSecretDialogOpen(true);
    },
    onError: (err) => notifyError(err, "Couldn't create the webhook."),
  });

  const updateMutation = useOrgMutation<
    Webhook,
    Error,
    { id: string; body: Record<string, unknown> }
  >({
    mutationFn: ({ id, body }) =>
      jsonFetch(`${apiBase}/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    invalidate: [["webhooks", "list"]],
    onError: (err) => notifyError(err, "Couldn't update the webhook."),
  });

  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) =>
      jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    invalidate: [["webhooks", "list"]],
    onSuccess: () => {
      setDeleteDialogOpen(false);
      setDeletingWebhook(null);
    },
    onError: (err) => notifyError(err, "Couldn't delete the webhook."),
  });

  const submitting =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending;

  async function handleCreate() {
    const next = validateForm();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    createMutation.mutate({ url: formUrl.trim(), events: formEvents });
  }

  async function handleEdit() {
    if (!editingWebhook) return;
    const next = validateForm();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    updateMutation.mutate(
      {
        id: editingWebhook.id,
        body: { url: formUrl.trim(), events: formEvents },
      },
      {
        onSuccess: () => {
          setEditDialogOpen(false);
          setEditingWebhook(null);
        },
      },
    );
  }

  async function handleDelete() {
    if (!deletingWebhook) return;
    deleteMutation.mutate(deletingWebhook.id);
  }

  const handleToggleActive = useCallback(
    (webhook: Webhook) => {
      updateMutation.mutate({
        id: webhook.id,
        body: { active: !webhook.active },
      });
    },
    [updateMutation],
  );

  const handleTest = useCallback(
    async (webhookId: string) => {
      setTestingId(webhookId);
      setTestResult(null);
      try {
        const res = await fetch(`${apiBase}/${webhookId}/test`, { method: "POST" });
        const json = await res.json();
        setTestResult({
          id: webhookId,
          success: res.ok,
          message: json.message ?? (res.ok ? "Test delivery sent" : "Test failed"),
        });
      } catch {
        setTestResult({ id: webhookId, success: false, message: "Network error" });
      } finally {
        setTestingId(null);
      }
    },
    [apiBase],
  );

  function copySecret() {
    navigator.clipboard.writeText(createdSecret);
    setCopiedSecret(true);
    setTimeout(() => setCopiedSecret(false), 2000);
  }

  const rowActions = useCallback(
    (webhook: Webhook): ActionMenuGroup[] => [
      {
        items: [
          {
            label: "Edit",
            icon: Pencil,
            onClick: () => openEditDialog(webhook),
          },
          {
            label: "Send test",
            icon: Play,
            onClick: () => handleTest(webhook.id),
            disabled: testingId === webhook.id,
          },
          {
            label: webhook.active ? "Deactivate" : "Activate",
            icon: Power,
            onClick: () => handleToggleActive(webhook),
          },
        ],
      },
      {
        items: [
          {
            label: "Delete",
            icon: Trash2,
            variant: "destructive",
            onClick: () => openDeleteDialog(webhook),
          },
        ],
      },
    ],
    [testingId, handleTest, handleToggleActive],
  );

  const columns: ColumnDef<Webhook>[] = [
    {
      accessorKey: "url",
      header: "URL",
      cell: ({ row }) => {
        const url = row.original.url;
        return (
          <code className="block max-w-xs truncate rounded bg-muted px-1.5 py-0.5 text-xs">
            {url.length > 50 ? url.slice(0, 50) + "..." : url}
          </code>
        );
      },
    },
    {
      accessorKey: "events",
      header: "Events",
      enableSorting: false,
      cell: ({ row }) => {
        const events = row.original.events;
        return (
          <div className="flex items-center gap-1.5">
            {events.slice(0, 2).map((event) => (
              <Badge key={event} variant="neutral" className="text-[10px]">
                {event}
              </Badge>
            ))}
            {events.length > 2 && (
              <Badge variant="neutral" showDot={false} className="text-[10px]">
                +{events.length - 2}
              </Badge>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "active",
      header: "Status",
      cell: ({ row }) => {
        const webhook = row.original;
        return (
          <button
            type="button"
            role="switch"
            aria-checked={webhook.active}
            onClick={() => handleToggleActive(webhook)}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
              webhook.active ? "bg-primary" : "bg-muted"
            )}
          >
            <span
              className={cn(
                "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm transition-transform",
                webhook.active ? "translate-x-4" : "translate-x-0"
              )}
            />
          </button>
        );
      },
    },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: ({ row }) => {
        const webhook = row.original;
        return (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => openEditDialog(webhook)}
              title="Edit"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => handleTest(webhook.id)}
              disabled={testingId === webhook.id}
              title="Send test"
            >
              {testingId === webhook.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => openDeleteDialog(webhook)}
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      },
    },
  ];

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-8 w-32" />
        </div>
        <Skeleton className="h-48 rounded-lg" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col gap-6">
        <LoadError
          onRetry={() => {
            refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <Button onClick={openCreateDialog}>
          <Plus className="h-4 w-4 mr-1" />
          Add Webhook
        </Button>
      </div>

      <DataTable<Webhook>
        columns={columns}
        data={webhooks}
        getRowId={(row) => row.id}
        rowActions={rowActions}
        emptyState={
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-12">
            <WebhookIcon className="h-10 w-10 text-muted-foreground/40" />
            <div className="text-center">
              <p className="text-sm font-medium text-muted-foreground">
                No webhooks configured
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Create a webhook to receive event notifications
              </p>
            </div>
          </div>
        }
        renderExpanded={(webhook) => {
          // Lazy-load deliveries when first expanded.
          if (!deliveries[webhook.id] && loadingDeliveriesFor !== webhook.id) {
            // Fire and forget; state update triggers a re-render.
            void fetchDeliveries(webhook.id);
          }
          const rows = deliveries[webhook.id];
          return (
            <div className="space-y-3">
              {testResult && testResult.id === webhook.id && (
                <div
                  className={cn(
                    "flex items-center gap-2 rounded px-3 py-2 text-xs",
                    testResult.success
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "bg-red-500/10 text-red-600 dark:text-red-400"
                  )}
                >
                  {testResult.success ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5" />
                  )}
                  {testResult.message}
                </div>
              )}

              <div className="rounded-lg border bg-muted/30">
                <div className="border-b px-3 py-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Recent Deliveries
                  </p>
                </div>
                {!rows ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : rows.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                    No deliveries yet
                  </p>
                ) : (
                  <div className="divide-y">
                    {rows.map((delivery) => (
                      <div
                        key={delivery.id}
                        className="flex items-center gap-3 px-3 py-2 text-xs"
                      >
                        <span className="shrink-0">
                          {delivery.status === "SUCCESS" && (
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                          )}
                          {delivery.status === "FAILED" && (
                            <XCircle className="h-3.5 w-3.5 text-red-500" />
                          )}
                          {delivery.status === "PENDING" && (
                            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </span>
                        <Badge variant="neutral" className="text-[10px]">
                          {delivery.event}
                        </Badge>
                        {delivery.statusCode && (
                          <code className="text-muted-foreground">
                            {delivery.statusCode}
                          </code>
                        )}
                        <span className="ml-auto text-muted-foreground">
                          {delivery.lastAttemptAt
                            ? new Date(delivery.lastAttemptAt).toLocaleString()
                            : new Date(delivery.createdAt).toLocaleString()}
                        </span>
                        <span className="text-muted-foreground">
                          {delivery.attempts} attempt{delivery.attempts !== 1 ? "s" : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        }}
      />

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Webhook</DialogTitle>
            <DialogDescription>
              Send event notifications to an external URL.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <FormField label="Payload URL" required error={errors.url}>
              {(p) => (
                <Input
                  {...p}
                  type="url"
                  value={formUrl}
                  onChange={(e) => {
                    setFormUrl(e.target.value);
                    clearError("url");
                  }}
                  placeholder="https://example.com/webhook"
                />
              )}
            </FormField>

            <div className="flex flex-col gap-2">
              <Label id="create-events-label">
                Events
                <span
                  className="text-[var(--status-critical-text,var(--status-critical))]"
                  aria-hidden
                >
                  *
                </span>
              </Label>
              <div
                className="grid grid-cols-2 gap-2"
                role="group"
                aria-labelledby="create-events-label"
                aria-describedby={errors.events ? "create-events-error" : undefined}
              >
                {AVAILABLE_EVENTS.map((event) => (
                  <label
                    key={event}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors",
                      formEvents.includes(event)
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/50"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={formEvents.includes(event)}
                      onChange={() => toggleEvent(event)}
                      className="rounded border-input"
                    />
                    {event}
                  </label>
                ))}
              </div>
              {errors.events && (
                <p id="create-events-error" className="text-xs text-destructive">
                  {errors.events}
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={submitting}>
              {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Webhook</DialogTitle>
            <DialogDescription>
              Update webhook URL and subscribed events.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <FormField label="Payload URL" required error={errors.url}>
              {(p) => (
                <Input
                  {...p}
                  type="url"
                  value={formUrl}
                  onChange={(e) => {
                    setFormUrl(e.target.value);
                    clearError("url");
                  }}
                  placeholder="https://example.com/webhook"
                />
              )}
            </FormField>

            <div className="flex flex-col gap-2">
              <Label id="edit-events-label">
                Events
                <span
                  className="text-[var(--status-critical-text,var(--status-critical))]"
                  aria-hidden
                >
                  *
                </span>
              </Label>
              <div
                className="grid grid-cols-2 gap-2"
                role="group"
                aria-labelledby="edit-events-label"
                aria-describedby={errors.events ? "edit-events-error" : undefined}
              >
                {AVAILABLE_EVENTS.map((event) => (
                  <label
                    key={event}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors",
                      formEvents.includes(event)
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/50"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={formEvents.includes(event)}
                      onChange={() => toggleEvent(event)}
                      className="rounded border-input"
                    />
                    {event}
                  </label>
                ))}
              </div>
              {errors.events && (
                <p id="edit-events-error" className="text-xs text-destructive">
                  {errors.events}
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={submitting}>
              {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Webhook
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this webhook? All delivery history will
              be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={submitting}>
              {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={secretDialogOpen} onOpenChange={setSecretDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Webhook Secret</DialogTitle>
            <DialogDescription>
              Copy this secret now. It will not be shown again. Use it to verify
              incoming webhook payloads.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 py-2">
            <code className="flex-1 break-all rounded-md border bg-muted px-3 py-2 font-mono text-xs">
              {createdSecret}
            </code>
            <Button variant="outline" size="icon" onClick={copySecret}>
              {copiedSecret ? (
                <Check className="h-4 w-4 text-emerald-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setSecretDialogOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
