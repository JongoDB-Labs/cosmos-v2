import { prisma } from "@/lib/db/client";
import { postTeamsChannelMessage } from "@/lib/integrations/teams";
import {
  TEAMS_NOTIFY_DEFAULTS,
  type TeamsEvent,
} from "@/lib/integrations/teams-notify-config";

/**
 * Teams event notifications (FR 8a162fe7, final piece). Call sites fire
 * `void teamsNotify(orgId, event, html)` at interesting moments; this module
 * decides whether anything actually posts:
 *
 *   - the org must have the Teams integration installed AND ACTIVE;
 *   - the event's toggle (Integration.config.notify[event]) must be on —
 *     absent toggles fall back to TEAMS_NOTIFY_DEFAULTS (user-approved:
 *     feedbackDelivered / itemCompleted / sprintStartEnd on, the noisier
 *     itemCreated / mentions / dailyDigest off).
 *
 * Always best-effort: failures (no channel configured, Graph down, bad creds)
 * are swallowed — a notification must never break the action that raised it.
 */

export {
  TEAMS_NOTIFY_DEFAULTS,
  TEAMS_EVENT_LABELS,
  TEAMS_EVENTS,
  escapeHtmlBasic,
  type TeamsEvent,
} from "@/lib/integrations/teams-notify-config";

const PROVIDER = "microsoft-teams-messaging";

/** Whether this org would post for `event` (integration active + toggle on). */
export async function teamsEventEnabled(orgId: string, event: TeamsEvent): Promise<boolean> {
  const integration = await prisma.integration.findFirst({
    where: { orgId, provider: PROVIDER, status: "ACTIVE" },
    select: { config: true },
  });
  if (!integration) return false;
  const notify = ((integration.config as Record<string, unknown>)?.notify ?? {}) as Partial<
    Record<TeamsEvent, boolean>
  >;
  return notify[event] ?? TEAMS_NOTIFY_DEFAULTS[event];
}

/** Post `html` to the org's Teams channel for `event`, if enabled. Never throws. */
export async function teamsNotify(orgId: string, event: TeamsEvent, html: string): Promise<void> {
  try {
    if (!(await teamsEventEnabled(orgId, event))) return;
    await postTeamsChannelMessage(orgId, { html });
  } catch {
    /* notifications are strictly best-effort */
  }
}
