// src/lib/ai/connectors/slack.descriptor.ts
//
// Slack expressed as a ConnectorDescriptor — mirrors the GitHub pattern (tools/slack.ts
// defs + executors/slack.ts dispatch). availability:"all" — Slack is a gov-usable
// native connector behind our own egress fence (bot token sealed in the vault; the
// model only ever sees what the gate projects).
//
// EGRESS — gov sees STRUCTURAL ONLY; content WITHHELD (default-deny):
//   - TOOL_ENTITY:
//       slack_search_messages → slack_message
//       slack_list_channels   → slack_channel
//       (slack_post_message is intentionally UNMAPPED — its result is re-gated by the
//        same maps; the write returns only ts/channel, and an unmapped tool ⇒ full
//        withhold for gov, the safe floor.)
//   - EXPOSABLE_FIELDS:
//       slack_message: ts, channel(id), user(opaque id), type. WITHHOLD: text
//                      (content), blocks, attachments, any profile/PII.
//       slack_channel: id, is_private, is_archived, created. WITHHOLD: name, topic,
//                      purpose (can be sensitive).
//   - HANDLEABLE_FIELDS: NONE — Slack has no handleable CUI string field (the model
//                      orchestrates BY channel/message id under the MAC ceiling, never
//                      by referencing message text). Omitted on purpose.

import type { ConnectorDescriptor } from "./types";
import { slackTools } from "../tools/slack";
import { executeSlackTool } from "../executors/slack";

export const slackConnector: ConnectorDescriptor = {
  provider: "slack",
  availability: "all", // gov-usable (unlike the commercial-only Nango breadth connector)
  toolDefs: slackTools,
  execute: (name, input, ctx) =>
    executeSlackTool(name, input, { userId: ctx.userId, orgId: ctx.orgId }),
  egress: {
    slack_search_messages: { entityType: "slack_message" },
    slack_list_channels: { entityType: "slack_channel" },
  },
  exposableFields: {
    // slackSearchMessages returns a shallow message shape including text (content).
    // Structural ONLY: ts (message id) + channel (id) + user (opaque id) + type.
    // `text`/blocks/attachments and any profile/PII are content → WITHHELD.
    slack_message: ["ts", "channel", "user", "type"],
    // slackListChannels returns id/name/is_private/is_archived/created. Structural
    // ONLY: id + the boolean flags + created. `name`/topic/purpose are content → WITHHELD.
    slack_channel: ["id", "is_private", "is_archived", "created"],
  },
  // No handleableFields: Slack has no handleable CUI string field (see header).
};
