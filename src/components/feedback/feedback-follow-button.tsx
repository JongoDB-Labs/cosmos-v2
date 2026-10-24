"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";

/** Follow a feedback item to hear about new comments on it, or stop. */
export function FeedbackFollowButton({ orgId, itemId }: { orgId: string; itemId: string }) {
  const base = `/api/v1/orgs/${orgId}/feedback/${itemId}/subscription`;
  const key = useOrgQueryKey("feedback-following", itemId);
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: key, queryFn: () => jsonFetch<{ following: boolean }>(base) });
  const [busy, setBusy] = useState(false);
  const following = data?.following ?? false;

  async function toggle() {
    setBusy(true);
    try {
      const next = await jsonFetch<{ following: boolean }>(base, {
        method: "PUT",
        body: JSON.stringify({ following: !following }),
      });
      qc.setQueryData(key, next);
    } catch (err) {
      notifyError(err, following ? "Couldn't unfollow." : "Couldn't follow.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      aria-pressed={following}
      disabled={busy || !data}
      onClick={() => void toggle()}
      title={following ? "You'll hear about new comments. Click to stop." : "Hear about new comments on this request"}
    >
      {following ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
      {following ? "Following" : "Follow"}
    </Button>
  );
}
