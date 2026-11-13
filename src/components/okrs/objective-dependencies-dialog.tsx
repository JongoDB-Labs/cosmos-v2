"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { HEALTH_LABEL } from "@/lib/okr/health";
import { HEALTH_VARIANT } from "./objective-card";
import type { Objective } from "@/types/models";

interface Candidate {
  id: string;
  title: string;
  /** The project, for an objective found outside this one. */
  where?: string;
}

/**
 * What an objective needs done first. The server holds the rules (same org, a
 * project the user can see, never itself, never a loop) and says why it
 * refused; this shows its words.
 *
 * Suggests this project's objectives, and searches the whole org's (the
 * projects the user can see) as they type.
 */
export function ObjectiveDependenciesDialog({
  orgId,
  projectId,
  objective,
  projectObjectives,
  onOpenChange,
  onChanged,
}: {
  orgId: string;
  projectId: string;
  objective: Objective;
  projectObjectives: Objective[];
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dependsOn = useMemo(() => objective.dependsOn ?? [], [objective.dependsOn]);
  const base = `/api/v1/orgs/${orgId}/projects/${projectId}/objectives/${objective.id}/dependencies`;

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  const searchKey = useOrgQueryKey("objective-dependency-search", debounced);
  const { data: found = [], isFetching } = useQuery({
    queryKey: searchKey,
    enabled: debounced.length > 0,
    queryFn: () =>
      jsonFetch<Array<{ id: string; label: string; sublabel?: string }>>(
        `/api/v1/orgs/${orgId}/mentions/search?q=${encodeURIComponent(debounced)}&types=objective`,
      ),
  });

  const candidates: Candidate[] = useMemo(() => {
    const taken = new Set([objective.id, ...dependsOn.map((d) => d.id)]);
    const list: Candidate[] = debounced
      ? found.map((h) => ({ id: h.id, title: h.label, where: h.sublabel }))
      : projectObjectives.map((o) => ({ id: o.id, title: o.title }));
    return list.filter((c) => !taken.has(c.id)).slice(0, 8);
  }, [debounced, found, projectObjectives, dependsOn, objective.id]);

  async function change(method: "POST" | "DELETE", dependsOnId: string) {
    setBusy(dependsOnId);
    setError(null);
    try {
      const res = await fetch(method === "POST" ? base : `${base}/${dependsOnId}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "POST" && { body: JSON.stringify({ dependsOnId }) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { detail?: string } | null;
        setError(body?.detail ?? "Couldn't save that dependency.");
        return;
      }
      if (method === "POST") setQuery("");
      onChanged();
    } catch {
      setError("Couldn't save that dependency.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Depends on</DialogTitle>
          <DialogDescription>
            Objectives that need to be done before &ldquo;{objective.title}&rdquo;. They can be in another project.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section aria-label="Current dependencies" className="space-y-1.5">
            {dependsOn.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing yet.</p>
            ) : (
              <ul className="space-y-1">
                {dependsOn.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{d.title}</span>
                    {d.overdue ? (
                      <Badge variant="critical">Overdue</Badge>
                    ) : (
                      d.health !== "no_date" && <Badge variant={HEALTH_VARIANT[d.health]}>{HEALTH_LABEL[d.health]}</Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${d.title}`}
                      disabled={busy !== null}
                      onClick={() => void change("DELETE", d.id)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="space-y-1.5">
            <Label htmlFor="dependency-search">Add an objective</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="dependency-search"
                className="pl-8"
                placeholder="Search objectives in any project…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <ul className="space-y-1" aria-label="Objectives to add">
              {candidates.map((c) => (
                <li key={c.id}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full justify-start gap-2"
                    disabled={busy !== null}
                    onClick={() => void change("POST", c.id)}
                  >
                    <span className="truncate">{c.title}</span>
                    {c.where && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{c.where}</span>}
                  </Button>
                </li>
              ))}
            </ul>
            {debounced && !isFetching && candidates.length === 0 && (
              <p className="text-sm text-muted-foreground">No other objective matches.</p>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm text-[var(--status-critical-text)]">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
