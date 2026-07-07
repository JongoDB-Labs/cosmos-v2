"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
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
  Power,
  Settings,
  Trash2,
  Download,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  ExternalLink,
  Plug,
  Bell,
} from "lucide-react";
import type { Integration } from "@/types/models";
import { notifyError } from "@/lib/errors/notify";
import { toast } from "sonner";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  TEAMS_EVENTS,
  TEAMS_EVENT_LABELS,
  TEAMS_NOTIFY_DEFAULTS,
  type TeamsEvent,
} from "@/lib/integrations/teams-notify-config";
import { BrandIcon } from "@/components/integrations/brand-icon";
import {
  CATEGORY_META,
  INTEGRATION_CATEGORIES,
  type IntegrationCategory,
} from "@/lib/integrations/registry";
import { filterProviders, groupByCategory } from "@/lib/integrations/filter";
import { useOrgQueryKey } from "@/lib/query/keys";
import { jsonFetch } from "@/lib/query/json-fetcher";

interface AvailableProvider {
  slug: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  status: "available" | "coming_soon";
  connect: "google" | "config" | "none";
  authType: string;
  sector?: string[];
  docsUrl?: string;
  installed: boolean;
  configFields?: { key: string; label: string; type: string; required: boolean; secret?: boolean }[];
}

const statusConfig = {
  ACTIVE: {
    color: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    icon: CheckCircle2,
    label: "Active",
  },
  INACTIVE: { color: "bg-muted text-muted-foreground", icon: Clock, label: "Inactive" },
  ERROR: {
    color: "bg-red-500/15 text-red-600 dark:text-red-400",
    icon: XCircle,
    label: "Error",
  },
};

function ChipButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "outline"}
      size="sm"
      className="h-7 rounded-full px-3 text-xs"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

interface IntegrationsManagerProps {
  orgId: string;
}

export function IntegrationsManager({ orgId }: IntegrationsManagerProps) {
  const apiBase = `/api/v1/orgs/${orgId}/integrations`;

  const availableKey = useOrgQueryKey("integrations", "available");
  const installedKey = useOrgQueryKey("integrations", "installed");
  const googleKey = useOrgQueryKey("google", "status");

  const {
    data: available = [],
    isLoading,
    isError,
    refetch: refetchAvailable,
  } = useQuery({
    queryKey: availableKey,
    queryFn: () => jsonFetch<AvailableProvider[]>(`${apiBase}/available`),
  });

  const { data: installed = [], isError: installedError, refetch: refetchInstalled } = useQuery({
    queryKey: installedKey,
    queryFn: () => jsonFetch<Integration[]>(apiBase),
  });

  const { data: google } = useQuery({
    queryKey: googleKey,
    queryFn: () => jsonFetch<{ connected: boolean }>(`/api/v1/me/google/status`),
  });

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<IntegrationCategory | "all">("all");
  const filtered = useMemo(
    () => filterProviders(available, query, category),
    [available, query, category],
  );
  const groups = useMemo(() => groupByCategory(filtered), [filtered]);
  const installedSlugs = useMemo(
    () => new Set(installed.map((i) => i.provider)),
    [installed],
  );
  // Google-auth integrations (Gmail/Calendar/Meet/Drive) connect via the user's
  // Google sign-in, NOT as installed Integration rows — so they belong in the
  // "Connected" section too when Google is linked, otherwise they look absent.
  const googleConnected = useMemo(
    () =>
      google?.connected
        ? available.filter((p) => p.connect === "google" && p.status === "available")
        : [],
    [google?.connected, available],
  );

  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [uninstallDialogOpen, setUninstallDialogOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<AvailableProvider | null>(null);
  const [selectedIntegration, setSelectedIntegration] = useState<Integration | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [formDisplayName, setFormDisplayName] = useState("");
  const [formConfig, setFormConfig] = useState<Record<string, string>>({});

  function refresh() {
    void refetchAvailable();
    void refetchInstalled();
  }

  function openInstallDialog(provider: AvailableProvider) {
    setSelectedProvider(provider);
    setFormDisplayName(provider.name);
    const configDefaults: Record<string, string> = {};
    provider.configFields?.forEach((f) => {
      configDefaults[f.key] = "";
    });
    setFormConfig(configDefaults);
    setInstallDialogOpen(true);
  }

  function openConfigDialog(integration: Integration) {
    setSelectedIntegration(integration);
    setFormDisplayName(integration.displayName);
    const configValues: Record<string, string> = {};
    const provider = available.find((p) => p.slug === integration.provider);
    provider?.configFields?.forEach((f) => {
      configValues[f.key] = (integration.config[f.key] as string) ?? "";
    });
    setFormConfig(configValues);
    setConfigDialogOpen(true);
  }

  function openUninstallDialog(integration: Integration) {
    setSelectedIntegration(integration);
    setUninstallDialogOpen(true);
  }

  async function handleInstall() {
    if (!selectedProvider) return;
    setSubmitting(true);
    try {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider.slug,
          displayName: formDisplayName.trim() || selectedProvider.name,
          config: formConfig,
        }),
      });
      if (!res.ok) throw new Error("Couldn't install the integration.");
      setInstallDialogOpen(false);
      refresh();
    } catch (err) {
      notifyError(err, "Couldn't install the integration.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfigure() {
    if (!selectedIntegration) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${apiBase}/${selectedIntegration.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: formDisplayName.trim(),
          config: formConfig,
        }),
      });
      if (!res.ok) throw new Error("Couldn't save the configuration.");
      setConfigDialogOpen(false);
      refresh();
    } catch (err) {
      notifyError(err, "Couldn't save the configuration.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleStatus(integration: Integration) {
    const newStatus = integration.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    try {
      const res = await fetch(`${apiBase}/${integration.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error("Couldn't change the integration status.");
      refresh();
    } catch (err) {
      notifyError(err, "Couldn't change the integration status.");
    }
  }

  async function handleUninstall() {
    if (!selectedIntegration) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${apiBase}/${selectedIntegration.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Couldn't uninstall the integration.");
      setUninstallDialogOpen(false);
      setSelectedIntegration(null);
      refresh();
    } catch (err) {
      notifyError(err, "Couldn't uninstall the integration.");
    } finally {
      setSubmitting(false);
    }
  }

  const configFieldsForProvider = (slug: string) =>
    available.find((p) => p.slug === slug)?.configFields ?? [];

  // Teams notification toggles (FR 8a162fe7): per-event on/off stored in the
  // integration's config.notify; absent keys fall back to the defaults.
  const [notifyFor, setNotifyFor] = useState<Integration | null>(null);
  const [notifyDraft, setNotifyDraft] = useState<Record<TeamsEvent, boolean>>(TEAMS_NOTIFY_DEFAULTS);
  const [notifySaving, setNotifySaving] = useState(false);

  function openNotifyDialog(integration: Integration) {
    const stored = ((integration.config?.notify ?? {}) as Partial<Record<TeamsEvent, boolean>>);
    setNotifyDraft(
      Object.fromEntries(
        TEAMS_EVENTS.map((e) => [e, stored[e] ?? TEAMS_NOTIFY_DEFAULTS[e]]),
      ) as Record<TeamsEvent, boolean>,
    );
    setNotifyFor(integration);
  }

  async function saveNotify() {
    if (!notifyFor) return;
    setNotifySaving(true);
    try {
      const res = await fetch(`${apiBase}/${notifyFor.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // PUT replaces config — send the merged object so other keys survive.
        body: JSON.stringify({ config: { ...notifyFor.config, notify: notifyDraft } }),
      });
      if (!res.ok) throw new Error("Couldn't save notification settings.");
      toast.success("Teams notifications saved");
      setNotifyFor(null);
      refresh();
    } catch (err) {
      notifyError(err, "Couldn't save notification settings.");
    } finally {
      setNotifySaving(false);
    }
  }

  // Test the Microsoft Teams connection (FR 8a162fe7) — mints a Graph token and,
  // when a default channel is set, posts a visible test message.
  const [testingId, setTestingId] = useState<string | null>(null);
  async function handleTestTeams(integration: Integration) {
    setTestingId(integration.id);
    try {
      const res = await fetch(`${apiBase}/teams/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ post: true }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        posted?: boolean;
        error?: string;
      };
      if (data.ok) {
        toast.success(
          data.posted
            ? "Connected — a test message was posted to the channel."
            : "Connected. Set a default Team + Channel ID to post messages.",
        );
      } else {
        toast.error(data.error ?? "Couldn't reach Microsoft Teams with these credentials.");
      }
    } catch (err) {
      notifyError(err, "Couldn't test the Teams connection.");
    } finally {
      setTestingId(null);
    }
  }

  // True when any required config field is still blank — blocks submit so the
  // user can't install/configure an integration with missing credentials and
  // get a silent failure (the `*` markers now actually gate the button).
  const hasMissingRequired = (
    fields: { key: string; required: boolean }[],
  ) => fields.some((f) => f.required && !(formConfig[f.key] ?? "").trim());

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-64 rounded-lg" />
        </div>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-24 rounded-full" />
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (isError || installedError) {
    return (
      <div className="flex flex-col gap-6">
        <LoadError onRetry={() => refresh()} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {(installed.length > 0 || googleConnected.length > 0) && (
        <section>
          <div className="mb-4">
            <h2 className="text-xl font-semibold">Connected</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage your connected integrations
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {googleConnected.map((provider) => (
              <div
                key={`google:${provider.slug}`}
                className="flex flex-col gap-3 rounded-lg border bg-card p-4"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                    <BrandIcon slug={provider.icon} name={provider.name} />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{provider.name}</p>
                    <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" />
                      Connected via Google
                    </span>
                  </div>
                </div>
                <p className="mt-auto border-t pt-2 text-xs text-muted-foreground">
                  Linked through your Google sign-in. Manage access from your
                  Google Account, or sign out to disconnect.
                </p>
              </div>
            ))}
            {installed.map((integration) => {
              const provider = available.find((p) => p.slug === integration.provider);
              const status = statusConfig[integration.status];
              const StatusIcon = status.icon;

              return (
                <div
                  key={integration.id}
                  className="flex flex-col gap-3 rounded-lg border bg-card p-4"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                        <BrandIcon
                          slug={provider?.icon ?? integration.provider}
                          name={integration.displayName}
                        />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{integration.displayName}</p>
                        <span
                          className={cn(
                            "mt-0.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs",
                            status.color,
                          )}
                        >
                          <StatusIcon className="h-3 w-3" />
                          {status.label}
                        </span>
                      </div>
                    </div>
                  </div>

                  {integration.lastSyncAt && (
                    <p className="text-xs text-muted-foreground">
                      Last sync: {new Date(integration.lastSyncAt).toLocaleString()}
                    </p>
                  )}

                  <div className="mt-auto flex items-center gap-1 border-t pt-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openConfigDialog(integration)}
                    >
                      <Settings className="mr-1 h-3.5 w-3.5" />
                      Configure
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggleStatus(integration)}
                    >
                      <Power className="mr-1 h-3.5 w-3.5" />
                      {integration.status === "ACTIVE" ? "Disable" : "Enable"}
                    </Button>
                    {integration.provider === "microsoft-teams-messaging" && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={testingId === integration.id}
                          onClick={() => handleTestTeams(integration)}
                        >
                          <Plug className="mr-1 h-3.5 w-3.5" />
                          {testingId === integration.id ? "Testing…" : "Test"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openNotifyDialog(integration)}
                        >
                          <Bell className="mr-1 h-3.5 w-3.5" />
                          Notifications
                        </Button>
                      </>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => openUninstallDialog(integration)}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" />
                      Uninstall
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search integrations…"
            className="max-w-sm"
          />
          <div className="flex flex-wrap gap-2">
            <ChipButton active={category === "all"} onClick={() => setCategory("all")}>
              All
            </ChipButton>
            {INTEGRATION_CATEGORIES.map((c) => (
              <ChipButton
                key={c}
                active={category === c}
                onClick={() => setCategory(c)}
              >
                {CATEGORY_META[c].label}
              </ChipButton>
            ))}
          </div>
        </div>

        {groups.length === 0 ? (
          <div className="rounded-lg border border-dashed bg-muted/30 p-10 text-center">
            <p className="text-sm text-muted-foreground">
              No integrations match &ldquo;{query}&rdquo;.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-8">
            {groups.map((group) => (
              <div key={group.category} className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold text-muted-foreground">
                  {group.label}
                </h3>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {group.providers.map((provider) => {
                    const tint =
                      CATEGORY_META[provider.category as IntegrationCategory]?.tint;
                    return (
                      <div
                        key={provider.slug}
                        className="flex flex-col gap-3 rounded-lg border bg-card p-4"
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                            <BrandIcon slug={provider.icon} name={provider.name} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{provider.name}</p>
                            <Badge
                              variant="neutral"
                              showDot={false}
                              className={cn("mt-0.5 text-[10px]", tint)}
                            >
                              {CATEGORY_META[provider.category as IntegrationCategory]
                                ?.label ?? provider.category}
                            </Badge>
                          </div>
                        </div>

                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {provider.description}
                        </p>

                        {provider.docsUrl && (
                          <a
                            href={provider.docsUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-1.5 inline-flex w-fit items-center gap-1 text-xs text-[var(--primary)] hover:underline"
                          >
                            <ExternalLink className="h-3 w-3 shrink-0" />
                            Setup guide
                          </a>
                        )}

                        <div className="mt-auto pt-2">
                          {provider.status === "coming_soon" ? (
                            <Badge variant="neutral" showDot={false} className="text-xs">
                              <Clock className="h-3 w-3" />
                              Coming soon
                            </Badge>
                          ) : provider.connect === "google" ? (
                            google?.connected ? (
                              <Badge
                                variant="done"
                                showDot={false}
                                className="text-xs"
                              >
                                <CheckCircle2 className="h-3 w-3" />
                                Connected
                              </Badge>
                            ) : (
                              // /api/auth/google is a server OAuth-redirect route,
                              // not a Next.js page — a hard navigation is correct here
                              // (mirrors login/page.tsx). <Link> would be wrong.
                              // eslint-disable-next-line @next/next/no-html-link-for-pages
                              <a
                                href="/api/auth/google"
                                className={cn(buttonVariants({ size: "sm" }))}
                              >
                                Connect Google
                              </a>
                            )
                          ) : installedSlugs.has(provider.slug) ? (
                            <Badge variant="done" showDot={false} className="text-xs">
                              <CheckCircle2 className="h-3 w-3" />
                              Installed
                            </Badge>
                          ) : provider.connect === "config" ? (
                            <Button size="sm" onClick={() => openInstallDialog(provider)}>
                              <Download className="mr-1 h-3.5 w-3.5" />
                              Install
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Dialog open={installDialogOpen} onOpenChange={setInstallDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedProvider && (
                <BrandIcon
                  slug={selectedProvider.icon}
                  name={selectedProvider.name}
                />
              )}
              Install {selectedProvider?.name}
            </DialogTitle>
            <DialogDescription>
              Configure and connect this integration to your workspace.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="install-display-name">Display Name</Label>
              <Input
                id="install-display-name"
                value={formDisplayName}
                onChange={(e) => setFormDisplayName(e.target.value)}
                placeholder={selectedProvider?.name}
              />
            </div>

            {selectedProvider?.configFields?.map((field) => (
              <div key={field.key} className="flex flex-col gap-1.5">
                <Label htmlFor={`config-${field.key}`}>
                  {field.label}
                  {field.required && <span className="ml-1 text-destructive">*</span>}
                </Label>
                <Input
                  id={`config-${field.key}`}
                  type={field.type === "secret" ? "password" : "text"}
                  value={formConfig[field.key] ?? ""}
                  onChange={(e) =>
                    setFormConfig((prev) => ({ ...prev, [field.key]: e.target.value }))
                  }
                  placeholder={field.label}
                />
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setInstallDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleInstall}
              disabled={
                submitting || hasMissingRequired(selectedProvider?.configFields ?? [])
              }
            >
              {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Install
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={configDialogOpen} onOpenChange={setConfigDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Configure {selectedIntegration?.displayName}</DialogTitle>
            <DialogDescription>Update integration settings.</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="config-display-name">Display Name</Label>
              <Input
                id="config-display-name"
                value={formDisplayName}
                onChange={(e) => setFormDisplayName(e.target.value)}
              />
            </div>

            {selectedIntegration &&
              configFieldsForProvider(selectedIntegration.provider).map((field) => (
                <div key={field.key} className="flex flex-col gap-1.5">
                  <Label htmlFor={`edit-config-${field.key}`}>
                    {field.label}
                    {field.required && <span className="ml-1 text-destructive">*</span>}
                  </Label>
                  <Input
                    id={`edit-config-${field.key}`}
                    type={field.type === "secret" ? "password" : "text"}
                    value={formConfig[field.key] ?? ""}
                    onChange={(e) =>
                      setFormConfig((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                  />
                </div>
              ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfigDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleConfigure}
              disabled={
                submitting ||
                hasMissingRequired(
                  selectedIntegration
                    ? configFieldsForProvider(selectedIntegration.provider)
                    : [],
                )
              }
            >
              {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={uninstallDialogOpen} onOpenChange={setUninstallDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Uninstall Integration
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to uninstall{" "}
              <strong>{selectedIntegration?.displayName}</strong>? This will disconnect
              the integration and remove all associated configuration.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUninstallDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleUninstall} disabled={submitting}>
              {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Uninstall
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Teams notification toggles (FR 8a162fe7) */}
      <Dialog open={notifyFor !== null} onOpenChange={(o) => !o && setNotifyFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Teams notifications</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Choose which Cosmos events post to the configured Teams channel.
          </p>
          <div className="space-y-3 py-2">
            {TEAMS_EVENTS.map((e) => (
              <label key={e} className="flex items-center justify-between gap-3 text-sm">
                <span>{TEAMS_EVENT_LABELS[e]}</span>
                <ToggleSwitch
                  checked={notifyDraft[e]}
                  onCheckedChange={(v) => setNotifyDraft((prev) => ({ ...prev, [e]: v }))}
                  aria-label={TEAMS_EVENT_LABELS[e]}
                />
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNotifyFor(null)} disabled={notifySaving}>
              Cancel
            </Button>
            <Button onClick={() => void saveNotify()} disabled={notifySaving}>
              {notifySaving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
