"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitMerge, Undo2 } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FeedbackItem } from "./feedback-types";

/**
 * "Merged into …" for a merged request, with a way to open the one it was
 * merged into. Fetched by id: the survivor need not be on the current board.
 */
export function MergedNotice({
  orgId,
  item,
  onOpenItem,
}: {
  orgId: string;
  item: Pick<FeedbackItem, "id" | "status" | "mergedIntoId">;
  onOpenItem: (id: string) => void;
}) {
  const survivorId = item.mergedIntoId ?? null;
  const key = useOrgQueryKey("feedback-item", survivorId);
  const { data: survivor } = useQuery({
    queryKey: key,
    queryFn: () => jsonFetch<FeedbackItem>(`/api/v1/orgs/${orgId}/feedback/${survivorId}`),
    enabled: !!survivorId,
  });
  if (item.status !== "MERGED") return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3 text-sm">
      <GitMerge className="h-4 w-4 text-muted-foreground" />
      {survivorId ? (
        <>
          <span>Merged into</span>
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={() => onOpenItem(survivorId)}
          >
            {survivor?.title ?? "another request"}
          </button>
          <span className="text-muted-foreground">: votes and the discussion continue there.</span>
        </>
      ) : (
        <span>This request was merged; the request it was merged into no longer exists.</span>
      )}
    </div>
  );
}

/**
 * Staff: merge this request into another, or undo its merge. `candidates` are
 * the requests on the board; the survivor can't be this one or a merged one.
 */
export function MergeControls({
  orgId,
  item,
  candidates,
  onChanged,
}: {
  orgId: string;
  item: Pick<FeedbackItem, "id" | "title" | "status">;
  candidates: FeedbackItem[];
  onChanged: () => void;
}) {
  const base = `/api/v1/orgs/${orgId}/feedback/${item.id}/merge`;
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    return candidates
      .filter((c) => c.id !== item.id && c.status !== "MERGED")
      .filter((c) => !q || c.title.toLowerCase().includes(q))
      .slice(0, 20);
  }, [candidates, item.id, query]);

  async function run(init: RequestInit, failure: string) {
    setBusy(true);
    try {
      await jsonFetch(base, init);
      setPicking(false);
      onChanged();
    } catch (err) {
      notifyError(err, failure);
    } finally {
      setBusy(false);
    }
  }

  if (item.status === "MERGED") {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void run({ method: "DELETE" }, "Couldn't undo the merge.")}
      >
        <Undo2 className="h-4 w-4" />
        Undo merge
      </Button>
    );
  }

  return (
    <>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => setPicking(true)}>
        <GitMerge className="h-4 w-4" />
        Merge into…
      </Button>
      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Merge into another request</DialogTitle>
            <DialogDescription>
              &ldquo;{item.title}&rdquo; becomes a duplicate. Its votes and followers move to the request you
              pick, and you can undo this.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Search requests"
            placeholder="Search requests…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="max-h-64 space-y-1 overflow-y-auto" aria-label="Requests to merge into">
            {options.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  disabled={busy}
                  className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                  onClick={() =>
                    void run(
                      { method: "POST", body: JSON.stringify({ survivorId: c.id }) },
                      "Couldn't merge these requests.",
                    )
                  }
                >
                  {c.title}
                  <span className="ml-2 text-xs text-muted-foreground">{c.voteCount} votes</span>
                </button>
              </li>
            ))}
            {options.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">No matching requests.</li>}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
