"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey, useOrgSlug, orgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { ToggleSwitch as Toggle } from "@/components/ui/toggle-switch";
import { SectionCard } from "@/components/ui/section-card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Shield,
  Key,
  Globe,
  Users,
  Clock,
  Trash2,
  Plus,
  Copy,
  Check,
  AlertTriangle,
  X,
  RefreshCw,
} from "lucide-react";

interface OrgSecuritySettings {
  id: string;
  orgId: string;
  mfaRequired: boolean;
  sessionTimeoutMins: number;
  ipAllowlistEnabled: boolean;
  scimEnabled: boolean;
  ssoEnforced: boolean;
  ssoConnectionId: string | null;
  allowedDomains: string[];
  auditRetentionDays: number;
  createdAt: string;
  updatedAt: string;
}

interface SessionRecord {
  id: string;
  orgId: string;
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
  lastActiveAt: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  isCurrent?: boolean;
}

interface IpAllowlistEntry {
  id: string;
  orgId: string;
  cidr: string;
  label: string;
  createdAt: string;
}

interface ScimToken {
  id: string;
  prefix: string;
  label: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export function SecuritySettingsPanel({ orgId }: { orgId: string }) {
  const orgSlug = useOrgSlug();
  const qc = useQueryClient();

  const [domainInput, setDomainInput] = useState("");
  const [addIpOpen, setAddIpOpen] = useState(false);
  const [ipForm, setIpForm] = useState({ cidr: "", label: "" });
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenLabel, setTokenLabel] = useState("");
  const [generateTokenOpen, setGenerateTokenOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [deleteIpTarget, setDeleteIpTarget] = useState<IpAllowlistEntry | null>(null);
  const [deleteTokenTarget, setDeleteTokenTarget] = useState<ScimToken | null>(null);

  const [form, setForm] = useState({
    mfaRequired: false,
    ssoEnforced: false,
    ssoConnectionId: "",
    allowedDomains: [] as string[],
    sessionTimeoutMins: 60,
    ipAllowlistEnabled: false,
    scimEnabled: false,
    auditRetentionDays: 90,
  });

  const settingsKey = useOrgQueryKey("security-settings");
  const sessionsKey = useOrgQueryKey("security", "sessions");
  const ipKey = useOrgQueryKey("security", "ip-allowlist");
  const tokensKey = useOrgQueryKey("security", "scim-tokens");

  const settingsQ = useQuery({
    queryKey: settingsKey,
    queryFn: () =>
      jsonFetch<OrgSecuritySettings>(`/api/v1/orgs/${orgId}/security/settings`),
  });

  const sessionsQ = useQuery({
    queryKey: sessionsKey,
    queryFn: async () => {
      const data = await jsonFetch<
        SessionRecord[] | { sessions: SessionRecord[] }
      >(`/api/v1/orgs/${orgId}/security/sessions`);
      return Array.isArray(data) ? data : data.sessions ?? [];
    },
  });

  const ipQ = useQuery({
    queryKey: ipKey,
    queryFn: async () => {
      const data = await jsonFetch<
        IpAllowlistEntry[] | { entries: IpAllowlistEntry[] }
      >(`/api/v1/orgs/${orgId}/security/ip-allowlist`);
      return Array.isArray(data) ? data : data.entries ?? [];
    },
  });

  const tokensQ = useQuery({
    queryKey: tokensKey,
    queryFn: async () => {
      const data = await jsonFetch<
        ScimToken[] | { tokens: ScimToken[] }
      >(`/api/v1/orgs/${orgId}/security/scim-tokens`);
      return Array.isArray(data) ? data : data.tokens ?? [];
    },
  });

  const settings = settingsQ.data ?? null;
  const sessions = sessionsQ.data ?? [];
  const ipEntries = ipQ.data ?? [];
  const scimTokens = tokensQ.data ?? [];
  const loading =
    settingsQ.isLoading ||
    sessionsQ.isLoading ||
    ipQ.isLoading ||
    tokensQ.isLoading;

  // Sync form whenever fetched settings change. React Compiler flags
  // setState-in-effect as an anti-pattern, but this is a deliberate sync
  // from a remote source — the right shape (compute-in-render) would
  // require restructuring `form` as a derived value, which is a separate
  // refactor.
  useEffect(() => {
    if (settings) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm({
        mfaRequired: settings.mfaRequired,
        ssoEnforced: settings.ssoEnforced,
        ssoConnectionId: settings.ssoConnectionId ?? "",
        allowedDomains: settings.allowedDomains ?? [],
        sessionTimeoutMins: settings.sessionTimeoutMins,
        ipAllowlistEnabled: settings.ipAllowlistEnabled,
        scimEnabled: settings.scimEnabled,
        auditRetentionDays: settings.auditRetentionDays,
      });
    }
  }, [settings]);

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: orgQueryKey(orgSlug, "security-settings") });
    qc.invalidateQueries({ queryKey: orgQueryKey(orgSlug, "security", "sessions") });
    qc.invalidateQueries({ queryKey: orgQueryKey(orgSlug, "security", "ip-allowlist") });
    qc.invalidateQueries({ queryKey: orgQueryKey(orgSlug, "security", "scim-tokens") });
  }

  const saveSettings = useOrgMutation<unknown, Error, void>({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/security/settings`, {
        method: "PUT",
        body: JSON.stringify({
          mfaRequired: form.mfaRequired,
          ssoEnforced: form.ssoEnforced,
          ssoConnectionId: form.ssoConnectionId || null,
          allowedDomains: form.allowedDomains,
          sessionTimeoutMins: form.sessionTimeoutMins,
          ipAllowlistEnabled: form.ipAllowlistEnabled,
          scimEnabled: form.scimEnabled,
          auditRetentionDays: form.auditRetentionDays,
        }),
      }),
    invalidate: [["security-settings"]],
    onError: (err) => notifyError(err, "Couldn't save security settings."),
  });

  const revokeSessionMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (sessionId) =>
      jsonFetch(`/api/v1/orgs/${orgId}/security/sessions`, {
        method: "POST",
        body: JSON.stringify({ sessionIds: [sessionId] }),
      }),
    invalidate: [["security", "sessions"]],
    onError: (err) => notifyError(err, "Couldn't revoke the session."),
  });

  // No body → server revokes the caller's other sessions (not this device).
  const revokeAllMutation = useOrgMutation<unknown, Error, void>({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/security/sessions`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    invalidate: [["security", "sessions"]],
    onError: (err) => notifyError(err, "Couldn't revoke the sessions."),
  });

  const addIpMutation = useOrgMutation<
    IpAllowlistEntry,
    Error,
    { cidr: string; label: string }
  >({
    mutationFn: (payload) =>
      jsonFetch(`/api/v1/orgs/${orgId}/security/ip-allowlist`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    invalidate: [["security", "ip-allowlist"]],
    onSuccess: () => {
      setAddIpOpen(false);
      setIpForm({ cidr: "", label: "" });
    },
    onError: (err) => notifyError(err, "Couldn't add the IP allowlist entry."),
  });

  const deleteIpMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) =>
      jsonFetch(`/api/v1/orgs/${orgId}/security/ip-allowlist/${id}`, {
        method: "DELETE",
      }),
    invalidate: [["security", "ip-allowlist"]],
    onSuccess: () => setDeleteIpTarget(null),
    onError: (err) => notifyError(err, "Couldn't delete the IP allowlist entry."),
  });

  const generateTokenMutation = useOrgMutation<
    { token?: string; value?: string },
    Error,
    string
  >({
    mutationFn: (label) =>
      jsonFetch(`/api/v1/orgs/${orgId}/security/scim-tokens`, {
        method: "POST",
        body: JSON.stringify({ label }),
      }),
    invalidate: [["security", "scim-tokens"]],
    onSuccess: (data) => {
      setNewToken(data?.token ?? data?.value ?? null);
      setTokenLabel("");
    },
    onError: (err) => notifyError(err, "Couldn't generate the SCIM token."),
  });

  const deleteTokenMutation = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) =>
      jsonFetch(`/api/v1/orgs/${orgId}/security/scim-tokens/${id}`, {
        method: "DELETE",
      }),
    invalidate: [["security", "scim-tokens"]],
    onSuccess: () => setDeleteTokenTarget(null),
    onError: (err) => notifyError(err, "Couldn't delete the SCIM token."),
  });

  const saving =
    saveSettings.isPending ||
    revokeSessionMutation.isPending ||
    revokeAllMutation.isPending ||
    addIpMutation.isPending ||
    deleteIpMutation.isPending ||
    generateTokenMutation.isPending ||
    deleteTokenMutation.isPending;

  function handleSave() {
    saveSettings.mutate(undefined, { onSuccess: () => invalidateAll() });
  }

  function addDomain() {
    const d = domainInput.trim().toLowerCase();
    if (d && !form.allowedDomains.includes(d)) {
      setForm((p) => ({ ...p, allowedDomains: [...p.allowedDomains, d] }));
    }
    setDomainInput("");
  }

  function removeDomain(domain: string) {
    setForm((p) => ({
      ...p,
      allowedDomains: p.allowedDomains.filter((d) => d !== domain),
    }));
  }

  function revokeSession(sessionId: string) {
    revokeSessionMutation.mutate(sessionId);
  }

  function revokeAllSessions() {
    revokeAllMutation.mutate();
  }

  function addIpEntry() {
    if (!ipForm.cidr) return;
    addIpMutation.mutate(ipForm);
  }

  function deleteIpEntry() {
    if (!deleteIpTarget) return;
    deleteIpMutation.mutate(deleteIpTarget.id);
  }

  function generateToken() {
    if (!tokenLabel.trim()) return;
    generateTokenMutation.mutate(tokenLabel);
  }

  function deleteToken() {
    if (!deleteTokenTarget) return;
    deleteTokenMutation.mutate(deleteTokenTarget.id);
  }

  function copyToken() {
    if (newToken) {
      navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-40 rounded-lg" />
        ))}
      </div>
    );
  }

  if (settingsQ.isError || sessionsQ.isError || ipQ.isError || tokensQ.isError) {
    return (
      <div className="space-y-6">
        <LoadError
          onRetry={() => {
            settingsQ.refetch();
            sessionsQ.refetch();
            ipQ.refetch();
            tokensQ.refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Shield className="size-5" />
          Security Settings
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Configure authentication, sessions, and access controls
        </p>
      </div>

      <SectionCard
        icon={Key}
        title="Authentication"
        description="Configure MFA, SSO, and allowed domains"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Require MFA</p>
              <p className="text-xs text-muted-foreground">
                All users must enable multi-factor authentication
              </p>
            </div>
            <Toggle
              aria-label="Require MFA"
              checked={form.mfaRequired}
              onCheckedChange={(v) => setForm((p) => ({ ...p, mfaRequired: v }))}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Enforce SSO</p>
              <p className="text-xs text-muted-foreground">
                Users must sign in via SSO provider
              </p>
            </div>
            <Toggle
              aria-label="Enforce SSO"
              checked={form.ssoEnforced}
              onCheckedChange={(v) => setForm((p) => ({ ...p, ssoEnforced: v }))}
            />
          </div>

          {form.ssoEnforced && (
            <div className="grid gap-2">
              <Label>SSO Connection ID</Label>
              <Input
                value={form.ssoConnectionId}
                onChange={(e) =>
                  setForm((p) => ({ ...p, ssoConnectionId: e.target.value }))
                }
                placeholder="con_..."
              />
            </div>
          )}

          <div className="grid gap-2">
            <Label>Allowed Email Domains</Label>
            <p className="text-xs text-muted-foreground">
              When set, only people with these email domains can be invited to
              this organization (e.g. <span className="font-mono">defconai.com</span>).
              Existing members are never affected. Leave empty to allow any domain.
            </p>
            {form.allowedDomains.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {form.allowedDomains.map((d) => (
                  <Badge key={d} variant="neutral" className="gap-1 pr-1">
                    {d}
                    <button
                      type="button"
                      onClick={() => removeDomain(d)}
                      className="ml-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Input
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                placeholder="example.com"
                className="flex-1"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addDomain();
                  }
                }}
              />
              <Button type="button" variant="outline" size="sm" onClick={addDomain}>
                Add
              </Button>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        icon={Clock}
        title="Session Management"
        description="Control session timeouts and active sessions"
      >
        <div className="space-y-4">
          <div className="grid gap-2 max-w-xs">
            <Label>Session Timeout (minutes)</Label>
            <Input
              aria-label="Session timeout in minutes"
              type="number"
              min={5}
              value={form.sessionTimeoutMins}
              onChange={(e) =>
                setForm((p) => ({
                  ...p,
                  sessionTimeoutMins: parseInt(e.target.value) || 60,
                }))
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">Active Sessions</h4>
            <Button variant="destructive" size="sm" onClick={revokeAllSessions}>
              Revoke All
            </Button>
          </div>

          <div className="rounded-lg border overflow-hidden">
            <div className="overflow-x-auto scrollbar-x">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                      User ID
                    </th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                      IP
                    </th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                      User Agent
                    </th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                      Last Active
                    </th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                      Status
                    </th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                        No active sessions
                      </td>
                    </tr>
                  ) : (
                    sessions.map((s) => (
                      <tr
                        key={s.id}
                        className="border-b last:border-b-0 hover:bg-muted/30"
                      >
                        <td className="px-3 py-2 font-mono text-xs">
                          {s.userId.substring(0, 8)}…
                          {s.isCurrent && (
                            <Badge
                              variant="neutral"
                              className="ml-2 bg-primary/15 text-[var(--primary)] font-sans"
                            >
                              This device
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {s.ipAddress ?? "-"}
                        </td>
                        <td className="px-3 py-2 text-xs max-w-[150px] truncate">
                          {s.userAgent ?? "-"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {new Date(s.lastActiveAt).toLocaleString()}
                        </td>
                        <td className="px-3 py-2">
                          <Badge
                            variant={s.status === "ACTIVE" ? "done" : "neutral"}
                            className={cn(
                              s.status === "ACTIVE" &&
                                "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
                              s.status === "REVOKED" &&
                                "bg-red-500/15 text-red-700 dark:text-red-400"
                            )}
                          >
                            {s.status}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {s.status === "ACTIVE" && !s.isCurrent && (
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => revokeSession(s.id)}
                            >
                              Revoke
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        icon={Globe}
        title="IP Allowlist"
        description="Restrict access to specific IP ranges"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Enable IP Allowlist</p>
              <p className="text-xs text-muted-foreground">
                Only allow access from specified IP ranges
              </p>
            </div>
            <Toggle
              aria-label="Restrict access to allowed IP ranges"
              checked={form.ipAllowlistEnabled}
              onCheckedChange={(v) =>
                setForm((p) => ({ ...p, ipAllowlistEnabled: v }))
              }
            />
          </div>

          {form.ipAllowlistEnabled && (
            <>
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setAddIpOpen(true)}>
                  <Plus className="size-3 mr-1" />
                  Add Entry
                </Button>
              </div>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                        CIDR
                      </th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                        Label
                      </th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                        Created
                      </th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {ipEntries.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                          No IP allowlist entries
                        </td>
                      </tr>
                    ) : (
                      ipEntries.map((entry) => (
                        <tr
                          key={entry.id}
                          className="border-b last:border-b-0 hover:bg-muted/30"
                        >
                          <td className="px-3 py-2 font-mono text-xs">
                            {entry.cidr}
                          </td>
                          <td className="px-3 py-2 text-sm">{entry.label}</td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {new Date(entry.createdAt).toLocaleDateString()}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => setDeleteIpTarget(entry)}
                            >
                              <Trash2 className="size-3 text-destructive" />
                            </Button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </SectionCard>

      <SectionCard
        icon={Users}
        title="SCIM Provisioning"
        description="Manage automated user provisioning tokens"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Enable SCIM</p>
              <p className="text-xs text-muted-foreground">
                Allow identity providers to manage users automatically
              </p>
            </div>
            <Toggle
              aria-label="Enable SCIM provisioning"
              checked={form.scimEnabled}
              onCheckedChange={(v) =>
                setForm((p) => ({ ...p, scimEnabled: v }))
              }
            />
          </div>

          {form.scimEnabled && (
            <>
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setGenerateTokenOpen(true)}
                >
                  <Plus className="size-3 mr-1" />
                  Generate Token
                </Button>
              </div>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                        Prefix
                      </th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                        Label
                      </th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                        Last Used
                      </th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                        Created
                      </th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {scimTokens.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                          No SCIM tokens
                        </td>
                      </tr>
                    ) : (
                      scimTokens.map((token) => (
                        <tr
                          key={token.id}
                          className="border-b last:border-b-0 hover:bg-muted/30"
                        >
                          <td className="px-3 py-2 font-mono text-xs">
                            {token.prefix}...
                          </td>
                          <td className="px-3 py-2 text-sm">{token.label}</td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {token.lastUsedAt
                              ? new Date(token.lastUsedAt).toLocaleString()
                              : "Never"}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {new Date(token.createdAt).toLocaleDateString()}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => setDeleteTokenTarget(token)}
                            >
                              <Trash2 className="size-3 text-destructive" />
                            </Button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </SectionCard>

      <SectionCard
        icon={RefreshCw}
        title="Data Retention"
        description="Configure how long audit logs are retained"
      >
        <div className="grid gap-2 max-w-xs">
          <Label>Audit Log Retention (days)</Label>
          <Input
            aria-label="Audit log retention in days"
            type="number"
            min={30}
            value={form.auditRetentionDays}
            onChange={(e) =>
              setForm((p) => ({
                ...p,
                auditRetentionDays: parseInt(e.target.value) || 90,
              }))
            }
          />
        </div>
      </SectionCard>

      <div className="flex justify-end">
        <Button disabled={saving} onClick={handleSave}>
          {saving ? "Saving..." : "Save Settings"}
        </Button>
      </div>

      <Dialog open={addIpOpen} onOpenChange={setAddIpOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add IP Entry</DialogTitle>
            <DialogDescription>
              Add a CIDR range to the IP allowlist.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label>CIDR</Label>
              <Input
                value={ipForm.cidr}
                onChange={(e) =>
                  setIpForm((p) => ({ ...p, cidr: e.target.value }))
                }
                placeholder="e.g. 10.0.0.0/8"
              />
              <p className="text-xs text-muted-foreground">
                Use CIDR notation, e.g. 10.0.0.0/8 or 192.168.1.0/24
              </p>
            </div>
            <div className="grid gap-2">
              <Label>Label</Label>
              <Input
                value={ipForm.label}
                onChange={(e) =>
                  setIpForm((p) => ({ ...p, label: e.target.value }))
                }
                placeholder="Office network"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddIpOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!ipForm.cidr || saving} onClick={addIpEntry}>
              {saving ? "Adding..." : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!deleteIpTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteIpTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete IP Entry</DialogTitle>
            <DialogDescription>
              Remove{" "}
              <span className="font-mono font-medium">
                {deleteIpTarget?.cidr}
              </span>{" "}
              from the allowlist?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteIpTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={saving}
              onClick={deleteIpEntry}
            >
              {saving ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={generateTokenOpen} onOpenChange={setGenerateTokenOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Generate SCIM Token</DialogTitle>
            <DialogDescription>
              Create a new token for SCIM provisioning.
            </DialogDescription>
          </DialogHeader>
          {newToken ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-3">
                <code className="flex-1 break-all text-xs font-mono">
                  {newToken}
                </code>
                <Button variant="ghost" size="icon-xs" onClick={copyToken}>
                  {copied ? (
                    <Check className="size-3 text-emerald-600" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                </Button>
              </div>
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                <AlertTriangle className="size-4 shrink-0 text-amber-600 mt-0.5" />
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  This token will not be shown again. Copy it now and store it
                  securely.
                </p>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => {
                    setNewToken(null);
                    setGenerateTokenOpen(false);
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <>
              <div className="grid gap-2 py-2">
                <Label>Token Label</Label>
                <Input
                  value={tokenLabel}
                  onChange={(e) => setTokenLabel(e.target.value)}
                  placeholder="e.g. Okta SCIM"
                />
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setGenerateTokenOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={!tokenLabel.trim() || saving}
                  onClick={generateToken}
                >
                  {saving ? "Generating..." : "Generate"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!deleteTokenTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteTokenTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete SCIM Token</DialogTitle>
            <DialogDescription>
              Delete token{" "}
              <span className="font-medium">{deleteTokenTarget?.label}</span>?
              Any integrations using this token will stop working.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTokenTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={saving}
              onClick={deleteToken}
            >
              {saving ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
