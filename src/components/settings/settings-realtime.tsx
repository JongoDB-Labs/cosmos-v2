"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useRealtimeEvents } from "@/hooks/use-realtime-events";

/**
 * Bridges org-scoped realtime events into the open Settings views so a
 * settings/membership change made in one tab (or by another admin) reflects
 * live in another open settings view (COSMOS-130 — finishes the app-wide
 * live-updates work started in COSMOS-127/129). Mounted once in the settings
 * layout, so every settings page shares a single subscription:
 *
 *   - `settings.updated` → invalidate the react-query-backed config views
 *     (feedback automation + intake policy, keyed `feedback-remediation-config`)
 *     and `router.refresh()` the server-rendered org-identity page.
 *   - `member.updated`   → invalidate the roles + members views (`work-roles`,
 *     `members`), so a role change / assignment shows without a manual reload.
 *
 * Every event arrives on the org's SSE stream (`org:{orgId}`), so this is
 * inherently org-scoped and can't leak across tenants. Renders nothing.
 */
export function SettingsRealtime({ orgId }: { orgId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  // Query-key prefixes (partial matches invalidate their dependent variants,
  // e.g. `["org", slug, "members", "for-roles"]`).
  const configKey = useOrgQueryKey("feedback-remediation-config");
  const rolesKey = useOrgQueryKey("work-roles");
  const membersKey = useOrgQueryKey("members");

  useRealtimeEvents(orgId, {
    "settings.updated": () => {
      void qc.invalidateQueries({ queryKey: configKey });
      router.refresh();
    },
    "member.updated": () => {
      void qc.invalidateQueries({ queryKey: rolesKey });
      void qc.invalidateQueries({ queryKey: membersKey });
      router.refresh();
    },
  });

  return null;
}
