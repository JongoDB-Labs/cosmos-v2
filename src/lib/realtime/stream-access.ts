/**
 * Which events on the org stream a subscriber may hear: the RULE, pure.
 *
 * The stream (`/api/v1/orgs/[orgId]/events`) joins the org topic, so everything
 * published there reaches every connection in the org. Work-item events carry a
 * project, and used to carry the item's title too, so a member kept out of a
 * team-scoped project still watched its new items arrive by name. The stateful
 * half that applies this per connection is `stream-gate.server.ts`.
 *
 * Every event name the server publishes falls into exactly one class below;
 * `stream-access.arch.test.ts` fails when a new one is not classified, and when
 * a project-bound event is published without its `projectId`. An event that
 * fits no class is not sent at all: a new event reaches nobody until it says
 * who may hear it.
 */

import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { parseTopic } from "./topics";

/**
 * About something inside ONE project. Sent only to a subscriber who may read
 * work items in that project (`getReadableProjectIds`: the item gate the REST
 * routes use, team scoping, a key's project ceiling and ABAC ITEM_READ denies).
 * Published WITHOUT a `projectId`, one is dropped: there is nothing to check it
 * against, so it fails closed.
 */
export const PROJECT_BOUND_EVENTS: ReadonlySet<string> = new Set([
  "work-item.created",
  "work-item.updated",
  "work-item.deleted",
  "work-item-link.created",
  "work-item-link.deleted",
  "ceremony.changed",
]);

/**
 * About the org, not a project, and safe for every member: ids and small
 * enumerations only. Clients refetch through the gated routes.
 */
export const ORG_WIDE_EVENTS: Readonly<Record<string, string>> = {
  "org.created": "published to the new org's own topic, which only its creator has joined",
  "settings.updated": "the org id and which settings section changed",
  "member.updated": "a member id with its new role or a removed flag",
  "feedback.throttled": "a feedback id and a reason code",
  "feedback.gated": "a feedback id and a role name",
  "feedback.flagged": "a feedback id and a decision code",
  "feedback.duplicate": "a feedback id and the id it duplicates",
  "feedback.delivered": "a feedback id and the work item id it became (not its key, which names the project)",
  "feedback.comment.created": "feedback and comment ids",
  "feedback.comment.updated": "feedback and comment ids",
  "feedback.comment.deleted": "feedback and comment ids",
  "feedback.merged": "feedback ids",
  "feedback.unmerged": "feedback ids",
};

/**
 * Chat. Sent on a channel topic, the subscriber's own user topic, or (presence)
 * the org topic, and only to someone who may use chat at all (CHAT_USE), as
 * every chat route requires. A channel topic's traffic goes only to the
 * channel's current members: the stream joined its channels when it opened,
 * and someone removed from one since must stop hearing it.
 */
export const CHAT_EVENT_PREFIX = "chat.";

/**
 * A plugin's events, by name prefix: the permission the plugin's own read
 * routes require, which the subscriber must hold to hear them. One that also
 * names a `projectId` is checked against that project, like a project-bound
 * event. A plugin whose events are not listed here is heard by nobody.
 */
export const PLUGIN_EVENT_PREFIXES: Readonly<Record<string, { permission: bigint; why: string }>> = {
  "pi_planning.": {
    permission: Permission.PROJECT_READ,
    why: "PI planning event, card and vote ids; the plugin's board, risk and vote reads require PROJECT_READ",
  },
};

/** The plugin class an event name falls in, if any. */
export function pluginEventClass(type: string): { permission: bigint; why: string } | null {
  for (const [prefix, rule] of Object.entries(PLUGIN_EVENT_PREFIXES)) if (type.startsWith(prefix)) return rule;
  return null;
}

/** On the subscriber's own user topic: their own notifications. */
export const OWN_TOPIC_EVENTS: ReadonlySet<string> = new Set(["notification.created"]);

/** Written by the stream route itself, never published. */
export const STREAM_ONLY_EVENTS: ReadonlySet<string> = new Set(["hello"]);

export interface StreamAudience {
  /** Projects whose work items this subscriber may read. */
  readable: ReadonlySet<string>;
  /** Every project in the org when `readable` was computed. */
  known: ReadonlySet<string>;
  /** Holds CHAT_USE. */
  chat: boolean;
  /** Chat channels the subscriber is a member of now. */
  channels: ReadonlySet<string>;
  /** The subscriber's effective permissions. */
  permissions: bigint;
}

/** An event as the bus delivers it: the topic it was published on decides some classes. */
export interface StreamEvent {
  topic: string;
  type: string;
  data: unknown;
}

/**
 * `"refresh"` means the event names a project this audience has never heard of
 * (created after the connection opened): recompute, then ask again. A second
 * `"refresh"` after recomputing is a drop.
 */
export type StreamDecision = "send" | "drop" | "refresh";

export function streamDecision(event: StreamEvent, audience: StreamAudience): StreamDecision {
  const topic = parseTopic(event.topic);
  if (!topic) return "drop";
  const { type } = event;

  if (type.startsWith(CHAT_EVENT_PREFIX) && !(type in ORG_WIDE_EVENTS)) {
    if (!audience.chat) return "drop";
    // By topic, not payload: a reaction names only its message.
    if (topic.kind === "channel") return audience.channels.has(topic.id) ? "send" : "drop";
    return "send";
  }
  if (OWN_TOPIC_EVENTS.has(type)) return topic.kind === "user" ? "send" : "drop";

  const plugin = pluginEventClass(type);
  if (plugin && !hasPermission(audience.permissions, plugin.permission)) return "drop";
  if (!plugin && !PROJECT_BOUND_EVENTS.has(type) && !(type in ORG_WIDE_EVENTS)) return "drop";

  const projectId = projectIdOf(event.data);
  if (projectId !== null) {
    if (audience.readable.has(projectId)) return "send";
    return audience.known.has(projectId) ? "drop" : "refresh";
  }
  return PROJECT_BOUND_EVENTS.has(type) ? "drop" : "send";
}

function projectIdOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const id = (data as { projectId?: unknown }).projectId;
  return typeof id === "string" && id.length > 0 ? id : null;
}
