"use client";

import { useState } from "react";
import { ArrowUpRight, Check, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { jsonFetch } from "@/lib/query/json-fetcher";
import type { CeremonyAction } from "./use-ceremony";

interface ActionItemsProps {
  basePath: string;
  projectKey: string;
  orgSlug: string;
  ceremonyId: string | null;
  actions: CeremonyAction[];
  members: { userId: string; displayName: string }[];
  closed: boolean;
  invalidateKey: unknown[];
}

interface PromoteResult {
  workItem: { id: string; ticketNumber: number; title: string };
  created: boolean;
}

/**
 * Action items, with the one control that decides whether a retro changes
 * anything: promote.
 *
 * An action captured here is text. Promoted, it becomes a real work item on the
 * next sprint, which is the difference between a decision the team acts on and
 * a list nobody reads again.
 */
export function ActionItems({
  basePath,
  projectKey,
  orgSlug,
  ceremonyId,
  actions,
  members,
  closed,
  invalidateKey,
}: ActionItemsProps) {
  const [text, setText] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [dueDate, setDueDate] = useState("");

  const addAction = useOrgMutation<unknown, Error, void>({
    mutationFn: () =>
      jsonFetch(`${basePath}/ceremony/actions`, {
        method: "POST",
        body: JSON.stringify({
          ceremonyId,
          text: text.trim(),
          ownerId: ownerId || null,
          dueDate: dueDate || null,
        }),
      }),
    invalidate: [invalidateKey],
    onSuccess: () => {
      setText("");
      setOwnerId("");
      setDueDate("");
    },
  });

  const removeAction = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) =>
      jsonFetch(`${basePath}/ceremony/actions/${id}`, { method: "DELETE" }),
    invalidate: [invalidateKey],
  });

  const promote = useOrgMutation<PromoteResult, Error, string>({
    mutationFn: (id) =>
      jsonFetch<PromoteResult>(
        `${basePath}/ceremony/actions/${id}/promote`,
        { method: "POST" }
      ),
    invalidate: [invalidateKey],
  });

  const canAdd = Boolean(ceremonyId) && !closed && text.trim().length > 0;

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--surface)] text-left">
              <th scope="col" className="px-4 py-2 font-medium">Action</th>
              <th scope="col" className="px-4 py-2 font-medium">Owner</th>
              <th scope="col" className="px-4 py-2 font-medium">Due</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                Tracked
              </th>
            </tr>
          </thead>
          <tbody>
            {actions.map((a) => {
              const owner = members.find((m) => m.userId === a.ownerId);
              return (
                <tr key={a.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-2">{a.text}</td>
                  <td className="px-4 py-2 text-[var(--text-muted)]">
                    {owner?.displayName ?? "—"}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-[var(--text-muted)]">
                    {a.dueDate ? new Date(a.dueDate).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-2">
                      {a.workItemId ? (
                        // Already tracked: link to the work item rather than
                        // offering a second promotion.
                        <a
                          href={`/${orgSlug}/projects/${projectKey}/items/${a.workItemId}`}
                          className="inline-flex items-center gap-1 text-xs text-[var(--status-done-text,var(--status-done))]"
                        >
                          <Check className="h-3.5 w-3.5" />
                          Tracked
                        </a>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={closed || promote.isPending}
                          onClick={() => promote.mutate(a.id)}
                        >
                          <ArrowUpRight className="mr-1 h-3.5 w-3.5" />
                          Promote
                        </Button>
                      )}
                      {closed ? null : (
                        <button
                          type="button"
                          aria-label={`Delete action: ${a.text}`}
                          onClick={() => removeAction.mutate(a.id)}
                          className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--status-critical-text,var(--status-critical))]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {actions.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-6 text-center text-[var(--text-muted)]"
                >
                  No actions yet. Assign one accountable owner and a concrete
                  date to each.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {closed ? null : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (canAdd) addAction.mutate();
          }}
        >
          <div className="min-w-[240px] flex-1">
            <label htmlFor="action-text" className="mb-1 block text-xs font-medium">
              Action
            </label>
            <Input
              id="action-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What will we do differently?"
              maxLength={2000}
            />
          </div>
          <div>
            <label htmlFor="action-owner" className="mb-1 block text-xs font-medium">
              Owner
            </label>
            <select
              id="action-owner"
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
              className="h-9 rounded-[calc(var(--radius)-2px)] border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="action-due" className="mb-1 block text-xs font-medium">
              Due date
            </label>
            <Input
              id="action-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={!canAdd || addAction.isPending}>
            <Plus className="mr-1 h-4 w-4" />
            Add action
          </Button>
        </form>
      )}
    </div>
  );
}
