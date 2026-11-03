"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { SectionCard } from "@/components/ui/section-card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { normalizeInternalCategories } from "@/lib/time/internal-categories";

/**
 * The org's internal time categories: what time that isn't on a project can be
 * logged as, and reported under, separately from project time. Shown to
 * whoever may change org settings.
 */
export function InternalTimeCategoriesCard({ orgId }: { orgId: string }) {
  const { data } = useQuery({
    queryKey: useOrgQueryKey("time-categories"),
    queryFn: () => jsonFetch<{ categories: string[]; canManage: boolean }>(`/api/v1/orgs/${orgId}/time-categories`),
  });
  const save = useOrgMutation({
    mutationFn: (categories: string[]) =>
      jsonFetch(`/api/v1/orgs/${orgId}/time-categories`, { method: "PUT", body: JSON.stringify({ categories }) }),
    invalidate: [["time-categories"]],
    onError: (e) => notifyError(e, "Couldn't change the categories."),
  });
  if (!data?.canManage) return null;
  return (
    <SectionCard
      icon={Clock}
      title="Internal time"
      description="Time that isn't on a project, reported separately from project time."
    >
      <CategoriesEditor
        key={data.categories.join("\n")}
        categories={data.categories}
        pending={save.isPending}
        onSave={(categories) => save.mutate(categories)}
      />
    </SectionCard>
  );
}

function CategoriesEditor({
  categories,
  pending,
  onSave,
}: {
  categories: string[];
  pending: boolean;
  onSave: (categories: string[]) => void;
}) {
  const [draft, setDraft] = useState(categories.join(", "));
  const next = normalizeInternalCategories(draft.split(","));
  const changed = next.join("\n") !== categories.join("\n");
  return (
    <div className="space-y-1 text-sm">
      <label htmlFor="internal-time-categories">Internal time categories</label>
      <span className="block text-xs text-muted-foreground">
        What internal time can be logged as, separated by commas. Leave empty to stop categorising it. Entries
        already logged keep the category they were logged with.
      </span>
      <div className="flex gap-2">
        <Input
          id="internal-time-categories"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={pending}
        />
        <Button size="sm" onClick={() => onSave(next)} disabled={pending || !changed}>
          Save
        </Button>
      </div>
    </div>
  );
}
