"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";
import type { WorkflowDefinition } from "@/lib/workflow/definition";
import { projectBase, type SimulatedTransition } from "./api";
import { Pick } from "./fields";

type Member = { userId: string; user: { displayName: string | null; email: string } };
type ItemHit = { id: string; title: string; ticketNumber: number; columnKey: string };

const OUTCOME: Record<SimulatedTransition["outcome"], { label: string; variant: BadgeVariant }> = {
  available: { label: "Available", variant: "done" },
  needs_input: { label: "Asks for input", variant: "review" },
  blocked: { label: "Blocked", variant: "blocked" },
  restricted: { label: "Restricted", variant: "neutral" },
  hidden: { label: "Hidden", variant: "neutral" },
};

const listOf = <T,>(body: unknown): T[] => (Array.isArray(body) ? body : ((body as { data?: T[] })?.data ?? []));

/**
 * "Simulate": pick an item and a person, and see every transition out of the
 * item's status under the draft, and why each is or isn't open to them. The
 * server evaluates it exactly as it would a move; nothing is written.
 */
export function SimulatePanel({
  orgId,
  projectId,
  definition,
  nameOf,
}: {
  orgId: string;
  projectId: string;
  definition: WorkflowDefinition;
  nameOf: (key: string) => string;
}) {
  const base = projectBase(orgId, projectId);
  const [search, setSearch] = useState("");
  const [itemId, setItemId] = useState("");
  const [actorId, setActorId] = useState("");
  const [result, setResult] = useState<{ status: string; inWorkflow: boolean; transitions: SimulatedTransition[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const members = useQuery({
    queryKey: useOrgQueryKey("members"),
    queryFn: async () => listOf<Member>(await jsonFetch<unknown>(`/api/v1/orgs/${orgId}/members`)),
  });
  const items = useQuery({
    queryKey: useOrgQueryKey("workflow-simulate-items", projectId, search),
    queryFn: async () => listOf<ItemHit>(await jsonFetch<unknown>(`${base}/work-items?search=${encodeURIComponent(search)}&pageSize=10`)).slice(0, 10),
    enabled: search.trim().length >= 2,
  });

  const run = async () => {
    setBusy(true);
    try {
      setResult(
        await jsonFetch(`${base}/workflow/simulate`, {
          method: "POST",
          body: JSON.stringify({ itemId, ...(actorId && { actorUserId: actorId }), definition }),
        }),
      );
    } catch (e) {
      notifyError(e, "Couldn't simulate the workflow.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">Try the draft on a real item before publishing it.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1">
          <span>Find an item</span>
          <Input className="h-8 w-56" placeholder="Search titles…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <Pick
          label="Item"
          value={itemId}
          onChange={setItemId}
          options={(items.data ?? []).map((i) => ({ value: i.id, label: `#${i.ticketNumber} ${i.title}` }))}
          placeholder={search.trim().length >= 2 ? "Pick an item…" : "Search first"}
          className="min-w-64"
        />
        <Pick
          label="As"
          value={actorId}
          onChange={setActorId}
          options={(members.data ?? []).map((m) => ({ value: m.userId, label: m.user.displayName ?? m.user.email }))}
          placeholder="Me"
          className="min-w-48"
        />
        <Button size="sm" onClick={run} disabled={!itemId || busy}>
          {busy ? "Simulating…" : "Simulate"}
        </Button>
      </div>
      {result && (
        <div className="space-y-2">
          <p>
            From <strong>{nameOf(result.status)}</strong>
            {!result.inWorkflow && " (a status this draft doesn\u2019t use: only moves from any status apply)"}
          </p>
          {result.transitions.length === 0 ? (
            <p className="text-muted-foreground">No transition leads out of this status.</p>
          ) : (
            <ul className="space-y-1.5" aria-label="Simulated transitions">
              {result.transitions.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5">
                  <Badge variant={OUTCOME[t.outcome].variant}>{OUTCOME[t.outcome].label}</Badge>
                  <span className="font-medium">{t.name}</span>
                  <span className="text-muted-foreground">to {nameOf(t.to)}</span>
                  {t.reasons.length > 0 && <span className="w-full text-xs text-muted-foreground">{t.reasons.join(" ")}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
