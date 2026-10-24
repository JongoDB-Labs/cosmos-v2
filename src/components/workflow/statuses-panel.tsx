"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { excludeStatus, includeStatus, setInitial } from "@/lib/workflow/draft-edit";
import type { WorkflowDefinition } from "@/lib/workflow/definition";
import { WORKFLOW_INVALIDATE, projectBase, type Category, type ProjectStatus } from "./api";
import { Pick } from "./fields";

export const CATEGORY_LABELS: Record<Category, string> = {
  TODO: "To do",
  IN_PROGRESS: "In progress",
  DONE: "Done",
  CANCELLED: "Cancelled",
};
const CATEGORY_OPTIONS = (Object.keys(CATEGORY_LABELS) as Category[]).map((c) => ({ value: c, label: CATEGORY_LABELS[c] }));

const slug = (name: string) => name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/**
 * The statuses list: which of the project's statuses this workflow uses, and
 * which one new items start in (both part of the draft). A status's name,
 * colour, category and order belong to the project: editing them here changes
 * them for every board and workflow at once, straight away.
 */
export function StatusesPanel({
  orgId,
  projectId,
  definition,
  statuses,
  onChange,
  readOnly = false,
}: {
  orgId: string;
  projectId: string;
  definition: WorkflowDefinition;
  statuses: ProjectStatus[];
  onChange: (next: WorkflowDefinition) => void;
  readOnly?: boolean;
}) {
  const base = projectBase(orgId, projectId);
  const nameOf = (key: string) => statuses.find((s) => s.key === key)?.name ?? key;
  const used = new Set(definition.statuses.map((s) => s.key));
  const initial = definition.statuses.find((s) => s.isInitial)?.key;
  const patch = useOrgMutation({
    mutationFn: ({ key, body }: { key: string; body: Record<string, unknown> }) =>
      jsonFetch(`${base}/statuses/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify(body) }),
    invalidate: WORKFLOW_INVALIDATE,
    onError: (e) => notifyError(e, "Couldn't change the status."),
  });
  const create = useOrgMutation({
    mutationFn: (body: { key: string; name: string; category: Category }) =>
      jsonFetch<ProjectStatus>(`${base}/statuses`, { method: "POST", body: JSON.stringify(body) }),
    invalidate: WORKFLOW_INVALIDATE,
    onSuccess: (s) => onChange(includeStatus(definition, s.key, () => s.name)),
    onError: (e) => notifyError(e, "Couldn't add the status."),
  });
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState<Category>("IN_PROGRESS");

  const ordered = [...statuses].sort((a, b) => a.sortOrder - b.sortOrder);
  const swap = (i: number, j: number) => {
    const a = ordered[i];
    const b = ordered[j];
    patch.mutate({ key: a.key, body: { sortOrder: b.sortOrder } });
    patch.mutate({ key: b.key, body: { sortOrder: a.sortOrder } });
  };

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" aria-label="Statuses">
          <thead className="bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">In this workflow</th>
              <th scope="col" className="px-3 py-2 font-medium">Starts here</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="px-3 py-2 font-medium">Category</th>
              <th scope="col" className="px-3 py-2 font-medium">Items</th>
              <th scope="col" className="px-3 py-2 font-medium"><span className="sr-only">Order</span></th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((s, i) => (
              <tr key={s.key} className="border-t">
                <td className="px-3 py-2">
                  <Checkbox
                    aria-label={`Use ${s.name} in this workflow`}
                    checked={used.has(s.key)}
                    disabled={readOnly || (used.has(s.key) && used.size === 1)}
                    onChange={(e) => onChange(e.target.checked ? includeStatus(definition, s.key, nameOf) : excludeStatus(definition, s.key))}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="radio"
                    name="initial-status"
                    aria-label={`New items start in ${s.name}`}
                    checked={initial === s.key}
                    disabled={readOnly || !used.has(s.key) || s.archived}
                    onChange={() => onChange(setInitial(definition, s.key))}
                    className="accent-[var(--primary)]"
                  />
                </td>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-2">
                    <input
                      type="color"
                      aria-label={`Colour of ${s.name}`}
                      value={s.color}
                      disabled={readOnly}
                      onChange={(e) => patch.mutate({ key: s.key, body: { color: e.target.value } })}
                      className="h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
                    />
                    <StatusName status={s} disabled={readOnly} onRename={(name) => patch.mutate({ key: s.key, body: { name } })} />
                    {s.archived && <Badge variant="neutral">Archived</Badge>}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <Pick
                    label={`Category of ${s.name}`}
                    value={s.category}
                    onChange={(category) => patch.mutate({ key: s.key, body: { category } })}
                    options={CATEGORY_OPTIONS}
                    disabled={readOnly}
                    className="min-w-32"
                  />
                </td>
                <td className="px-3 py-2 tabular-nums text-muted-foreground">{s.items ?? 0}</td>
                <td className="px-3 py-2">
                  <span className="flex gap-1">
                    <Button variant="ghost" size="icon-sm" aria-label={`Move ${s.name} up`} disabled={readOnly || i === 0} onClick={() => swap(i, i - 1)}>
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Move ${s.name} down`} disabled={readOnly || i === ordered.length - 1} onClick={() => swap(i, i + 1)}>
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newName.trim();
            if (!name || !slug(name)) return;
            create.mutate({ key: slug(name), name, category: newCategory }, { onSuccess: () => setNewName("") });
          }}
        >
          <Input aria-label="New status name" placeholder="New status" className="h-8 w-48" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={50} />
          <Pick label="New status category" value={newCategory} onChange={(c) => setNewCategory(c as Category)} options={CATEGORY_OPTIONS} className="min-w-32" />
          <Button type="submit" size="sm" variant="outline" disabled={!slug(newName) || create.isPending}>
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
            Add status
          </Button>
        </form>
      )}
      <p className="text-xs text-muted-foreground">
        {"Name, colour, category and order belong to the project's status: they change for every board and workflow at once."}
      </p>
      <ConflictsSection orgId={orgId} projectId={projectId} nameOf={(k) => statuses.find((st) => st.key === k)?.name ?? k} readOnly={readOnly} />
    </div>
  );
}

interface Conflict {
  statusId: string;
  key: string;
  statusCategory: Category;
  boards: { boardId: string; boardName: string; category: Category }[];
}

/**
 * Statuses whose boards disagreed on their category when statuses moved to the
 * project. Until one is resolved, each disagreeing lane keeps its own
 * category, so nothing a board shows changed; resolving makes every lane
 * follow the status.
 */
function ConflictsSection({
  orgId,
  projectId,
  nameOf,
  readOnly,
}: {
  orgId: string;
  projectId: string;
  nameOf: (key: string) => string;
  readOnly: boolean;
}) {
  const base = `${projectBase(orgId, projectId)}/workflow/conflicts`;
  const conflicts = useQuery({
    queryKey: useOrgQueryKey("workflows", projectId, "conflicts"),
    queryFn: () => jsonFetch<Conflict[]>(base),
  });
  const resolve = useOrgMutation({
    mutationFn: (body: { key: string; take: "status" | Category }) => jsonFetch(base, { method: "POST", body: JSON.stringify(body) }),
    invalidate: WORKFLOW_INVALIDATE,
    onError: (e) => notifyError(e, "Couldn't resolve the conflict."),
  });
  const list = conflicts.data ?? [];
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="status-conflicts-heading" className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <h4 id="status-conflicts-heading" className="font-medium">Boards that disagree on a status&apos;s category</h4>
      <p className="text-xs text-muted-foreground">
        Until you choose, each board below keeps its own category for the status, so its done counts haven&apos;t changed. Choosing makes every board follow the status.
      </p>
      <ul className="space-y-2">
        {list.map((c) => {
          const boardCategories = [...new Set(c.boards.map((b) => b.category))];
          return (
            <li key={c.statusId} className="space-y-1">
              <p>
                <strong>{nameOf(c.key)}</strong> is {CATEGORY_LABELS[c.statusCategory]}; on{" "}
                {c.boards.map((b) => `${b.boardName} (${CATEGORY_LABELS[b.category]})`).join(", ")}
              </p>
              {!readOnly && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate({ key: c.key, take: "status" })}>
                    Keep {CATEGORY_LABELS[c.statusCategory]}
                  </Button>
                  {boardCategories.map((cat) => (
                    <Button key={cat} size="sm" variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate({ key: c.key, take: cat })}>
                      Use {CATEGORY_LABELS[cat]}, as the board has it
                    </Button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function StatusName({ status, disabled, onRename }: { status: ProjectStatus; disabled: boolean; onRename: (name: string) => void }) {
  const [name, setName] = useState(status.name);
  return (
    <Input
      aria-label={`Name of ${status.name}`}
      className="h-8 w-40"
      value={name}
      disabled={disabled}
      maxLength={50}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => {
        const next = name.trim();
        if (next && next !== status.name) onRename(next);
        else setName(status.name);
      }}
    />
  );
}
