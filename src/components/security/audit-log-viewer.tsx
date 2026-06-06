"use client";

import { useCallback, useEffect, useState } from "react";
import { notifyError } from "@/lib/errors/notify";
import { LoadError } from "@/components/ui/load-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ScrollText,
  ChevronLeft,
  ChevronRight,
  Download,
  Search,
  Filter,
} from "lucide-react";

interface AuditLogEntry {
  id: string;
  orgId: string;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  ipAddress: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface MemberOption {
  id: string;
  userId: string;
  user: {
    id: string;
    email: string;
    displayName: string | null;
  } | null;
}

interface AuditLogResponse {
  logs: AuditLogEntry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export function AuditLogViewer({ orgId }: { orgId: string }) {
  const [data, setData] = useState<AuditLogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [page, setPage] = useState(1);
  const [limit] = useState(25);
  const [members, setMembers] = useState<MemberOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/orgs/${orgId}/members`);
        if (res.ok && !cancelled) {
          const json = await res.json();
          const list: MemberOption[] = Array.isArray(json)
            ? json
            : json.data ?? json.members ?? [];
          setMembers(list);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const [filters, setFilters] = useState({
    action: "",
    entity: "",
    userId: "",
    startDate: "",
    endDate: "",
  });

  const [appliedFilters, setAppliedFilters] = useState({
    action: "",
    entity: "",
    userId: "",
    startDate: "",
    endDate: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(limit));
      if (appliedFilters.action) params.set("action", appliedFilters.action);
      if (appliedFilters.entity) params.set("entity", appliedFilters.entity);
      if (appliedFilters.userId) params.set("userId", appliedFilters.userId);
      if (appliedFilters.startDate) params.set("startDate", appliedFilters.startDate);
      if (appliedFilters.endDate) params.set("endDate", appliedFilters.endDate);

      const res = await fetch(`/api/v1/orgs/${orgId}/audit-logs?${params.toString()}`);
      if (!res.ok) throw new Error();
      const json = await res.json();
      setData({
        logs: json.logs ?? json.data ?? [],
        total: json.total ?? 0,
        page: json.page ?? page,
        limit: json.limit ?? limit,
        totalPages: json.totalPages ?? Math.ceil((json.total ?? 0) / limit),
      });
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId, page, limit, appliedFilters]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function applyFilters() {
    setPage(1);
    setAppliedFilters({ ...filters });
  }

  function clearFilters() {
    const cleared = {
      action: "",
      entity: "",
      userId: "",
      startDate: "",
      endDate: "",
    };
    setFilters(cleared);
    setAppliedFilters(cleared);
    setPage(1);
  }

  async function exportLogs(format: "json" | "csv") {
    const params = new URLSearchParams();
    params.set("format", format);
    if (appliedFilters.action) params.set("action", appliedFilters.action);
    if (appliedFilters.entity) params.set("entity", appliedFilters.entity);
    if (appliedFilters.userId) params.set("userId", appliedFilters.userId);
    if (appliedFilters.startDate)
      params.set("startDate", appliedFilters.startDate);
    if (appliedFilters.endDate) params.set("endDate", appliedFilters.endDate);

    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/audit-logs/export?${params.toString()}`,
      );
      if (!res.ok) throw new Error("Couldn't export the audit logs.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-logs.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      notifyError(err, "Couldn't export the audit logs.");
    }
  }

  const hasActiveFilters = Object.values(appliedFilters).some(Boolean);

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-8 w-32" />
        </div>
        <Skeleton className="h-12 rounded-lg" />
        <Skeleton className="h-96 rounded-lg" />
      </div>
    );
  }

  if (loadError && !data) {
    return (
      <div className="space-y-6">
        <LoadError onRetry={() => { void load(); }} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <ScrollText className="size-5" />
            Audit Logs
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Review security and activity events
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => exportLogs("json")}>
            <Download className="size-3 mr-1" />
            Export JSON
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportLogs("csv")}>
            <Download className="size-3 mr-1" />
            Export CSV
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <Filter className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Filters</span>
          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="ml-auto text-xs text-muted-foreground hover:text-foreground"
            >
              Clear all
            </button>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="grid gap-1.5">
            <Label className="text-xs">Action</Label>
            <Input
              value={filters.action}
              onChange={(e) =>
                setFilters((p) => ({ ...p, action: e.target.value }))
              }
              placeholder="e.g. CREATE"
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Entity</Label>
            <Input
              value={filters.entity}
              onChange={(e) =>
                setFilters((p) => ({ ...p, entity: e.target.value }))
              }
              placeholder="e.g. project"
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">User</Label>
            <Select
              items={{
                all: "— All users —",
                ...Object.fromEntries(
                  members.map((m) => [
                    m.userId,
                    m.user?.displayName || m.user?.email || m.userId,
                  ]),
                ),
              }}
              value={filters.userId || "all"}
              onValueChange={(v) =>
                setFilters((p) => ({
                  ...p,
                  userId: !v || v === "all" ? "" : v,
                }))
              }
            >
              <SelectTrigger className="w-full" aria-label="Filter by user">
                <SelectValue placeholder="All users" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">— All users —</SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>
                    {m.user?.displayName || m.user?.email || m.userId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Start Date</Label>
            <DatePicker
              value={filters.startDate}
              onValueChange={(v) =>
                setFilters((p) => ({ ...p, startDate: v }))
              }
              placeholder="Start date"
              aria-label="Start date"
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">End Date</Label>
            <DatePicker
              value={filters.endDate}
              onValueChange={(v) =>
                setFilters((p) => ({ ...p, endDate: v }))
              }
              placeholder="End date"
              aria-label="End date"
            />
          </div>
        </div>
        <div className="flex justify-end mt-3">
          <Button size="sm" onClick={applyFilters}>
            <Search className="size-3 mr-1" />
            Apply Filters
          </Button>
        </div>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Audit log entries"
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  Timestamp
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  User
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  Action
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  Entity
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  Entity ID
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  IP Address
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b">
                    {Array.from({ length: 6 }).map((_, j) => (
                      <td key={j} className="px-3 py-2">
                        <Skeleton className="h-4 w-full" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : !data || data.logs.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-8 text-center text-muted-foreground"
                  >
                    No audit log entries found
                  </td>
                </tr>
              ) : (
                data.logs.map((log) => (
                  <tr
                    key={log.id}
                    className="border-b last:border-b-0 hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-xs" title={log.userId ?? undefined}>
                      {(() => {
                        if (!log.userId) return "-";
                        const m = members.find(
                          (mm) => mm.userId === log.userId,
                        );
                        return (
                          m?.user?.displayName ||
                          m?.user?.email ||
                          `${log.userId.substring(0, 8)}…`
                        );
                      })()}
                    </td>
                    <td className="px-3 py-2 text-xs font-medium">
                      {log.action}
                    </td>
                    <td className="px-3 py-2 text-xs">{log.entity}</td>
                    <td
                      className="px-3 py-2 font-mono text-xs"
                      title={log.entityId ?? undefined}
                    >
                      {log.entityId
                        ? `${log.entityId.substring(0, 8)}…`
                        : "-"}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {log.ipAddress ?? "-"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {data && data.totalPages > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {data.total} total entr{data.total === 1 ? "y" : "ies"}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="size-3 mr-1" />
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {data.page} of {data.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= data.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
              <ChevronRight className="size-3 ml-1" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
