import { prisma } from "@/lib/db/client";
import { postTeamsChannelMessage } from "@/lib/integrations/teams";
import { channelPolicy } from "@/lib/integrations/channel-policy.server";
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

/**
 * What a post is about, so the channel rule (`channel-policy.server.ts`) is
 * checked here as well as where the text is built: every project it names may
 * be posted about, or the chat channel it quotes is a public one.
 */
export type TeamsSubject = { projectIds: string[] } | { chatChannelId: string };

/**
 * Post `html` to the org's Teams channel for `event`, if enabled and if the
 * channel rule allows what it is about. The caller builds `html` with
 * `channelPolicy(orgId).text(...)`, so a marked title is left out rather than
 * the whole post dropped; a marking that still reaches here drops the post.
 * Never throws.
 */
export async function teamsNotify(orgId: string, event: TeamsEvent, html: string, about: TeamsSubject): Promise<void> {
  try {
    if (!(await teamsEventEnabled(orgId, event))) return;
    const policy = await channelPolicy(orgId);
    if ("projectIds" in about) {
      for (const projectId of about.projectIds) if (!(await policy.project(projectId))) return;
    } else if (!(await policy.chatChannel(about.chatChannelId))) {
      return;
    }
    if (policy.text(null, html) === undefined) return;
    await postTeamsChannelMessage(orgId, { html });
  } catch {
    /* notifications are strictly best-effort */
  }
}
