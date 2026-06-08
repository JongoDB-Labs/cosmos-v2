"use client";

import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  AlertTriangle,
  Server,
  Power,
  PowerOff,
} from "lucide-react";

import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormField } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { DataTable } from "@/components/ui/data-table";
import type { ActionMenuGroup } from "@/components/ui/action-menu";
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

type Transport = "stdio" | "http" | "sse";

interface McpServer {
  id: string;
  orgId: string;
  name: string;
  transport: Transport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface McpServersManagerProps {
  orgId: string;
}

function parseLinesToRecord(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function recordToLines(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function parseArgsLine(text: string): string[] {
  // Naive whitespace split — good enough for `-y @scope/pkg` style args.
  // Users who need quoted/spaced args can edit each line in env-style if
  // we ever extend the form.
  return text
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function McpServersManager({ orgId }: McpServersManagerProps) {
  const apiBase = `/api/v1/orgs/${orgId}/mcp-servers`;

  const listKey = useOrgQueryKey("mcp-servers", "list");
  const {
    data: servers = [],
    isLoading: loading,
    isError,
    refetch,
  } = useQuery({
    queryKey: listKey,
    queryFn: () => jsonFetch<McpServer[]>(apiBase),
  });

  // Dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [deleting, setDeleting] = useState<McpServer | null>(null);

  // Form fields
  const [formName, setFormName] = useState("");
  const [formTransport, setFormTransport] = useState<Transport>("stdio");
  const [formCommand, setFormCommand] = useState("");
  const [formArgs, setFormArgs] = useState("");
  const [formEnv, setFormEnv] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formHeaders, setFormHeaders] = useState("");
  const [formEnabled, setFormEnabled] = useState(true);

  // Per-field client-side validation errors.
  const [errors, setErrors] = useState<Record<string, string>>({});

  function resetForm() {
    setFormName("");
    setFormTransport("stdio");
    setFormCommand("");
    setFormArgs("");
    setFormEnv("");
    setFormUrl("");
    setFormHeaders("");
    setFormEnabled(true);
    setErrors({});
  }

  function openCreate() {
    resetForm();
    setCreateOpen(true);
  }

  function openEdit(server: McpServer) {
    setEditing(server);
    setErrors({});
    setFormName(server.name);
    setFormTransport(server.transport);
    setFormCommand(server.command ?? "");
    setFormArgs((server.args ?? []).join(" "));
    setFormEnv(recordToLines(server.env ?? {}));
    setFormUrl(server.url ?? "");
    setFormHeaders(recordToLines(server.headers ?? {}));
    setFormEnabled(server.enabled);
    setEditOpen(true);
  }

  function openDelete(server: McpServer) {
    setDeleting(server);
    setDeleteOpen(true);
  }

  // Build the payload that matches the API schema.
  function buildPayload(): Record<string, unknown> {
    const base: Record<string, unknown> = {
      name: formName.trim(),
      transport: formTransport,
      enabled: formEnabled,
    };
    if (formTransport === "stdio") {
      base.command = formCommand.trim();
      base.args = parseArgsLine(formArgs);
      base.env = parseLinesToRecord(formEnv);
    } else {
      base.url = formUrl.trim();
      base.headers = parseLinesToRecord(formHeaders);
    }
    return base;
  }

  // Build a per-field error map for the required inputs. Required fields by
  // meaning: name (always), and the connection target — command for stdio
  // transports, or the server URL for http/sse transports (URL format).
  function validateForm(): Record<string, string> {
    const next: Record<string, string> = {};
    if (!formName.trim()) {
      next.name = "Name is required";
    }
    if (formTransport === "stdio") {
      if (!formCommand.trim()) {
        next.command = "Command is required";
      }
    } else {
      const url = formUrl.trim();
      if (!url) {
        next.url = "URL is required";
      } else if (!/^https?:\/\//i.test(url)) {
        next.url = "Enter a valid URL";
      }
    }
    return next;
  }

  const createMutation = useOrgMutation<
    McpServer,
    Error,
    Record<string, unknown>
  >({
    mutationFn: (payload) =>
      jsonFetch(apiBase, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    invalidate: [["mcp-servers", "list"]],
    onSuccess: () => {
      setCreateOpen(false);
      resetForm();
    },
    onError: (err) => notifyError(err, "Couldn't create the MCP server."),
  });

  const updateMutation = useOrgMutation<
    McpServer,
    Error,
    { id: string; body: Record<string, unknown> }
  >({
    mutationFn: ({ id, body }) =>
      jsonFetch(`${apiBase}/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    invalidate: [["mcp-servers", "list"]],
    onError: (err) => notifyError(err, "Couldn't update the MCP server."),
  });

  const deleteMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${apiBase}/${id}`, { method: "DELETE" }),
    invalidate: [["mcp-servers", "list"]],
    onSuccess: () => {
      setDeleteOpen(false);
      setDeleting(null);
    },
    onError: (err) => notifyError(err, "Couldn't delete the MCP server."),
  });

  const submitting =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending;

  function handleCreate() {
    const next = validateForm();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    createMutation.mutate(buildPayload());
  }

  function handleEdit() {
    if (!editing) return;
    const next = validateForm();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    updateMutation.mutate(
      { id: editing.id, body: buildPayload() },
      {
        onSuccess: () => {
          setEditOpen(false);
          setEditing(null);
        },
      },
    );
  }

  function handleDelete() {
    if (!deleting) return;
    deleteMutation.mutate(deleting.id);
  }

  const handleToggleEnabled = useCallback(
    (server: McpServer) => {
      updateMutation.mutate({
        id: server.id,
        body: { enabled: !server.enabled },
      });
    },
    [updateMutation],
  );

  // Surface the existing per-row operations (edit / enable-disable toggle /
  // delete) as a right-click + ⋯ menu, reusing the same handlers as the
  // inline action buttons and the Enabled toggle.
  const rowActions = useCallback(
    (server: McpServer): ActionMenuGroup[] => [
      {
        items: [
          {
            label: "Edit",
            icon: Pencil,
            onClick: () => openEdit(server),
          },
          {
            label: server.enabled ? "Disable" : "Enable",
            icon: server.enabled ? PowerOff : Power,
            onClick: () => handleToggleEnabled(server),
          },
        ],
      },
      {
        items: [
          {
            label: "Delete",
            icon: Trash2,
            variant: "destructive",
            onClick: () => openDelete(server),
          },
        ],
      },
    ],
    // openEdit/openDelete are stable setState-only closures; handleToggleEnabled
    // forwards to a memoized mutation. Listed for exhaustive-deps correctness.

    [handleToggleEnabled],
  );

  const columns: ColumnDef<McpServer>[] = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <span className="font-medium">{row.original.name}</span>
      ),
    },
    {
      accessorKey: "transport",
      header: "Transport",
      cell: ({ row }) => (
        <Badge variant="neutral" className="font-mono text-[10px] uppercase">
          {row.original.transport}
        </Badge>
      ),
    },
    {
      id: "target",
      header: "Target",
      enableSorting: false,
      cell: ({ row }) => {
        const s = row.original;
        if (s.transport === "stdio") {
          const cmd = [s.command ?? "", ...(s.args ?? [])].join(" ").trim();
          return (
            <code className="block max-w-xs truncate rounded bg-muted px-1.5 py-0.5 text-xs">
              {cmd || "(no command)"}
            </code>
          );
        }
        return (
          <code className="block max-w-xs truncate rounded bg-muted px-1.5 py-0.5 text-xs">
            {s.url || "(no url)"}
          </code>
        );
      },
    },
    {
      accessorKey: "enabled",
      header: "Enabled",
      cell: ({ row }) => (
        <ToggleSwitch
          checked={row.original.enabled}
          onCheckedChange={() => handleToggleEnabled(row.original)}
          aria-label={`Toggle ${row.original.name}`}
        />
      ),
    },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => openEdit(row.original)}
            title="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => openDelete(row.original)}
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ),
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

  // Clear a single field's error as the user edits it.
  function clearError(field: string) {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function renderFormFields(idPrefix: string) {
    return (
      <div className="flex flex-col gap-4 py-2">
        <FormField label="Name" required error={errors.name}>
          {(p) => (
            <Input
              {...p}
              value={formName}
              onChange={(e) => {
                setFormName(e.target.value);
                clearError("name");
              }}
              placeholder="e.g. Slack production"
            />
          )}
        </FormField>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-transport`}>Transport</Label>
          <Select
            value={formTransport}
            onValueChange={(v) => setFormTransport(v as Transport)}
          >
            <SelectTrigger id={`${idPrefix}-transport`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">stdio (spawn local process)</SelectItem>
              <SelectItem value="http">http</SelectItem>
              <SelectItem value="sse">sse</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {formTransport === "stdio" ? (
          <>
            <FormField label="Command" required error={errors.command}>
              {(p) => (
                <Input
                  {...p}
                  value={formCommand}
                  onChange={(e) => {
                    setFormCommand(e.target.value);
                    clearError("command");
                  }}
                  placeholder="npx"
                />
              )}
            </FormField>
            <FormField label="Args" hint="Space-separated argument list.">
              {(p) => (
                <Input
                  {...p}
                  value={formArgs}
                  onChange={(e) => setFormArgs(e.target.value)}
                  placeholder="-y @modelcontextprotocol/server-slack"
                />
              )}
            </FormField>
            <FormField label="Environment" hint="One KEY=value per line.">
              {(p) => (
                <Textarea
                  {...p}
                  value={formEnv}
                  onChange={(e) => setFormEnv(e.target.value)}
                  placeholder={"SLACK_TOKEN=xoxb-...\nWORKSPACE_ID=T123"}
                  rows={4}
                />
              )}
            </FormField>
          </>
        ) : (
          <>
            <FormField label="URL" required error={errors.url}>
              {(p) => (
                <Input
                  {...p}
                  type="url"
                  value={formUrl}
                  onChange={(e) => {
                    setFormUrl(e.target.value);
                    clearError("url");
                  }}
                  placeholder="https://mcp.example.com"
                />
              )}
            </FormField>
            <FormField label="Headers" hint="One Header=value per line.">
              {(p) => (
                <Textarea
                  {...p}
                  value={formHeaders}
                  onChange={(e) => setFormHeaders(e.target.value)}
                  placeholder={"Authorization=Bearer ...\nX-API-Version=2024-01"}
                  rows={4}
                />
              )}
            </FormField>
          </>
        )}

        <div className="flex items-center gap-3">
          <ToggleSwitch
            checked={formEnabled}
            onCheckedChange={setFormEnabled}
            aria-label="Enabled"
          />
          <Label className="cursor-pointer" onClick={() => setFormEnabled(!formEnabled)}>
            Enabled
          </Label>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" />
          Add MCP Server
        </Button>
      </div>

      <DataTable<McpServer>
        columns={columns}
        data={servers}
        getRowId={(row) => row.id}
        rowActions={rowActions}
        emptyState={
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-12">
            <Server className="h-10 w-10 text-muted-foreground/40" />
            <div className="text-center">
              <p className="text-sm font-medium text-muted-foreground">
                No MCP servers configured
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add a server to expose its tools to the AI chat.
              </p>
            </div>
          </div>
        }
      />

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setErrors({});
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add MCP Server</DialogTitle>
            <DialogDescription>
              Register a Model Context Protocol server. Stdio servers are
              spawned by the chat backend; http/sse servers are called over
              the network.
            </DialogDescription>
          </DialogHeader>
          {renderFormFields("create")}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={submitting}
            >
              {submitting && (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              )}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) setErrors({});
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit MCP Server</DialogTitle>
            <DialogDescription>
              Update the server configuration. Changes apply on the next chat
              turn for new conversations; existing conversations keep their
              prior config until the CLI process recycles.
            </DialogDescription>
          </DialogHeader>
          {renderFormFields("edit")}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={submitting}>
              {submitting && (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              )}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete MCP Server
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{deleting?.name}&quot;? The AI
              chat will no longer be able to call its tools.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={submitting}
            >
              {submitting && (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
